import { Logger } from '@nestjs/common';
import { RequestAborted } from '../common/abort';
import { wavFile } from '../common/audio/wav';
import { ConversationMessage, InquiryTurn, inquirySystemPrompt } from '../llm/inquiry-turn';
import { ExecutionContext, SpokenKind } from '../scenario-executions/execution-context';
import { SessionEnding, SessionEvent } from '../scenario-executions/scenario-executions.service';
import { LoopNodeData, MenuNodeData, MenuOption, ScenarioGraph, ScenarioGraphNode, ScenarioNodeType } from '../scenarios/scenario-graph';
import { branchTarget, LoopTopics, nextStep, topicsAhead } from '../scenarios/scenario-plan';
import { CallLog } from './call-log';
import { CallRecorder } from './call-recorder';
import { END_PAUSE_MS, HEARTBEAT_MS, MARK_GRACE_MS, MEDIA_CHUNK_BYTES, SAMPLE_RATE, START_PAUSE_MS } from './call-timing';
import { CallProgress, CallTransport, InboundMessage } from './call-transport';
import { Ear, Utterance } from './ear';

export const BEFORE_ANSWER =
  'The caller spoke again before you answered. The previous request was cancelled. Answer the latest caller speech in light of the full conversation.';
export const REPLY_CUT_OFF =
  'The caller interrupted while you were speaking. They may not have heard the full previous reply. Continue from the latest caller speech.';

const NODE_TITLE: Record<ScenarioNodeType, string> = {
  start: 'Start',
  end: 'End',
  tts: 'Text to speech',
  loop: 'Conversational loop',
  switch: 'Topic switch',
  menu: 'Keypad menu',
};

export type CallChannel = 'BROWSER' | 'PHONE';
export type CallbackReason = 'TURN_LIMIT' | 'SILENCE' | 'DEFAULT_TOPIC' | 'ERROR';

export interface TurnRequest {
  messages: ConversationMessage[];
  note?: string;
  topics?: LoopTopics['topics'];
  defaultTopicId?: string;
}

/** What the session needs from the rest of the API. The services record provider events from the context they get. */
export interface CallServices {
  transcribe(modelId: string, wav: Buffer, context: ExecutionContext, signal: AbortSignal): Promise<string>;
  /** A phone-format (μ-law) clip of a line. */
  clip(modelId: string, text: string, context: ExecutionContext, signal: AbortSignal): Promise<Buffer>;
  complete(modelId: string, request: TurnRequest, context: ExecutionContext, signal: AbortSignal): Promise<InquiryTurn>;
  /** The model fields `llm.aborted` copies, as the services do for `llm.completed`. */
  describeLlm(modelId: string): Promise<Record<string, unknown>>;
  writeEvents(events: SessionEvent[]): Promise<void>;
  heartbeat(): Promise<void>;
  storeRecordings(recordings: { caller: Buffer; mix: Buffer; peaks: number[] }): Promise<boolean>;
  close(ending: SessionEnding): Promise<void>;
}

export interface CallTiming {
  startPauseMs: number;
  endPauseMs: number;
  markGraceMs: number;
  heartbeatMs: number;
  /** Turns a node's seconds (menu wait, no input) into milliseconds. Tests shorten it. */
  secondMs: number;
}

const DEFAULT_TIMING: CallTiming = {
  startPauseMs: START_PAUSE_MS,
  endPauseMs: END_PAUSE_MS,
  markGraceMs: MARK_GRACE_MS,
  heartbeatMs: HEARTBEAT_MS,
  secondMs: 1000,
};

export interface CallOutcome extends SessionEnding {
  callbackReason: CallbackReason | null;
}

/** A provider failed inside a conversational loop, after the sorry line was played. */
class LoopFailure extends Error {}

function isAbort(error: unknown) {
  return error instanceof RequestAborted || (error instanceof Error && error.name === 'AbortError');
}

function messageOf(error: unknown) {
  return error instanceof Error && error.message ? error.message : 'The call failed.';
}

type Played = 'played' | 'cleared';

interface Pending {
  resolve: (result: { outcome: Played; endMs: number }) => void;
  timer: ReturnType<typeof setTimeout>;
  placed: ReturnType<CallRecorder['speak']>;
}

/** Audio out. Counts a clip as played when the transport returns the mark sent after it. */
class Speaker {
  private readonly pending = new Map<string, Pending>();
  private readonly drainWaiters: Array<() => void> = [];
  private counter = 0;
  private queueEndMs = 0;
  lastEndMs = 0;

  constructor(
    private readonly transport: CallTransport,
    private readonly recorder: CallRecorder,
    private readonly clock: () => number,
    private readonly graceMs: number,
  ) {}

  get idle() {
    return this.pending.size === 0;
  }

  play(audio: Buffer) {
    const now = this.clock();
    const startMs = Math.max(now, this.queueEndMs);
    const durationMs = (audio.length * 1000) / SAMPLE_RATE;
    this.queueEndMs = startMs + durationMs;
    const placed = this.recorder.speak(audio, startMs);
    for (let offset = 0; offset < audio.length; offset += MEDIA_CHUNK_BYTES) {
      this.transport.send({ event: 'media', media: { payload: audio.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64') } });
    }
    this.counter += 1;
    const name = `m${this.counter}`;
    this.transport.send({ event: 'mark', mark: { name } });
    const done = new Promise<{ outcome: Played; endMs: number }>((resolve) => {
      const timer = setTimeout(() => this.settle(name, 'played'), startMs - now + durationMs + this.graceMs);
      this.pending.set(name, { resolve, timer, placed });
    });
    return { startMs, done };
  }

  onMark(name: string) {
    this.settle(name, 'played');
  }

  /** Stops everything queued at once. */
  clear() {
    if (this.pending.size === 0) return;
    this.transport.send({ event: 'clear' });
    const now = this.clock();
    for (const name of [...this.pending.keys()]) this.settle(name, 'cleared', now);
    this.queueEndMs = now;
  }

  drained() {
    if (this.idle) return Promise.resolve();
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve));
  }

  private settle(name: string, outcome: Played, at = this.clock()) {
    const pending = this.pending.get(name);
    if (!pending) return;
    this.pending.delete(name);
    clearTimeout(pending.timer);
    if (outcome === 'cleared') this.recorder.cut(pending.placed, at);
    this.lastEndMs = at;
    pending.resolve({ outcome, endMs: at });
    if (this.pending.size === 0) for (const resolve of this.drainWaiters.splice(0)) resolve();
  }
}

/** The ear of one conversational loop, with the waits the turn loop needs. */
class Listener {
  readonly ear: Ear;
  lastActivityMs: number;
  private readonly utterances: Utterance[] = [];
  private utteranceWaiter: ((utterance: Utterance) => void) | null = null;
  private readonly speechWaiters = new Set<() => void>();

  constructor(silenceMs: number, startedMs: number) {
    this.ear = new Ear(silenceMs);
    this.lastActivityMs = startedMs;
  }

  hear(samples: Int16Array, atMs: number, nowMs: number) {
    const event = this.ear.hear(samples, atMs);
    if (this.ear.phase !== 'idle') this.lastActivityMs = nowMs;
    if (event?.type === 'speech') for (const resolve of [...this.speechWaiters]) resolve();
    if (event?.type === 'utterance') {
      const utterance: Utterance = { samples: event.samples, startedMs: event.startedMs, durationMs: event.durationMs };
      if (this.utteranceWaiter) {
        const resolve = this.utteranceWaiter;
        this.utteranceWaiter = null;
        resolve(utterance);
      } else {
        this.utterances.push(utterance);
      }
    }
  }

  hasPendingSpeech() {
    return this.ear.phase === 'speaking' || this.utterances.length > 0;
  }

  takeUtterance(): Utterance | null {
    return this.utterances.shift() ?? null;
  }

  onUtterance(resolve: ((utterance: Utterance) => void) | null) {
    this.utteranceWaiter = resolve;
  }

  /** Resolves when speech is confirmed, at once if the caller is already speaking. */
  speech() {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    if (this.ear.phase === 'speaking') resolve();
    else this.speechWaiters.add(resolve);
    return { promise, cancel: () => this.speechWaiters.delete(resolve) };
  }
}

interface MenuState {
  node: Extract<ScenarioGraphNode, { type: 'menu' }>;
  chosen: MenuOption | null;
  stopPrompt: AbortController | null;
  keyWaiter: (() => void) | null;
}

/**
 * One live call: walks the graph from Start, runs the turn loop, and writes the execution as it goes. Created when
 * the transport's `start` message arrives with a valid token.
 */
export class CallSession {
  readonly done: Promise<CallOutcome>;
  private readonly run = new AbortController();
  private readonly log: CallLog;
  private readonly recorder = new CallRecorder();
  private readonly speaker: Speaker;
  private readonly timing: CallTiming;
  private readonly logger = new Logger(CallSession.name);
  private readonly messages: ConversationMessage[] = [];
  private readonly menuChoices: string[] = [];
  private listener: Listener | null = null;
  private menu: MenuState | null = null;
  private active: ScenarioGraphNode | null = null;
  private inquiry: string | null = null;
  private topicId: string | null = null;
  private topicLabel: string | null = null;
  private callbackReason: CallbackReason | null = null;
  private callerLeft = false;
  private readonly llmSnapshots = new Map<string, Promise<Record<string, unknown>>>();

  constructor(
    private readonly options: {
      executionId: string;
      graph: ScenarioGraph;
      channel: CallChannel;
      transport: CallTransport;
      services: CallServices;
      /** Wall time when the execution was created, which is t = 0 on the clock. */
      createdAt: number;
      start: { callSid?: string; streamSid?: string };
      now?: () => number;
      timing?: Partial<CallTiming>;
    },
  ) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.log = new CallLog(options.executionId, (events) => options.services.writeEvents(events), () => this.clock());
    this.speaker = new Speaker(options.transport, this.recorder, () => this.clock(), this.timing.markGraceMs);
    this.done = this.runCall();
  }

  receive(message: InboundMessage) {
    if (message.event === 'media') this.onMedia(message.media.payload);
    else if (message.event === 'mark') this.speaker.onMark(message.mark.name);
    else if (message.event === 'dtmf') this.onKey(message.dtmf.digit);
    else if (message.event === 'stop') this.hangUp();
  }

  /** The caller hung up, or the browser closed the stream. */
  hangUp() {
    if (this.run.signal.aborted) return;
    this.callerLeft = true;
    this.run.abort();
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private clock() {
    return Math.max(0, this.now() - this.options.createdAt);
  }

  private get aborted() {
    return this.run.signal.aborted;
  }

  private progress(progress: CallProgress) {
    if (this.options.channel === 'BROWSER') this.options.transport.send({ event: 'progress', progress });
  }

  private async runCall(): Promise<CallOutcome> {
    const heartbeat = setInterval(() => void this.options.services.heartbeat().catch(() => undefined), this.timing.heartbeatMs);
    let status: SessionEnding['status'] = 'FINISHED';
    let errorMessage: string | null = null;
    try {
      this.log.event(
        'stream.started',
        { channel: this.options.channel, ...(this.options.start.callSid ? { callSid: this.options.start.callSid, streamSid: this.options.start.streamSid } : {}) },
        null,
      );
      this.progress({ kind: 'started', executionId: this.options.executionId });
      await this.walk();
      if (this.aborted) status = 'STOPPED';
    } catch (error) {
      if (this.aborted && !(error instanceof LoopFailure)) {
        status = 'STOPPED';
      } else {
        status = 'FAILED';
        errorMessage = messageOf(error);
        if (error instanceof LoopFailure) this.markCallback('ERROR');
      }
    } finally {
      clearInterval(heartbeat);
    }
    return this.finish(status, errorMessage);
  }

  private async finish(status: SessionEnding['status'], errorMessage: string | null): Promise<CallOutcome> {
    if (this.active) this.leave(status === 'STOPPED' ? 'stopped' : status === 'FAILED' ? 'failed' : 'completed');
    this.speaker.clear();
    this.run.abort();
    const durationMs = Math.round(this.clock());
    const ending: CallOutcome = {
      status,
      durationMs,
      inquiry: this.inquiry,
      topicId: this.topicId,
      topicLabel: this.topicLabel,
      menuChoice: this.menuChoices.length > 0 ? this.menuChoices.join(' › ') : null,
      errorMessage,
      callbackReason: this.callbackReason,
    };
    this.log.event(
      'execution.ended',
      {
        status: status.toLowerCase(),
        inquiry: ending.inquiry,
        topicId: ending.topicId,
        topicLabel: ending.topicLabel,
        menuChoice: ending.menuChoice,
        errorMessage,
        ...(this.callerLeft ? { reason: 'caller_hung_up' } : {}),
      },
      null,
    );
    this.progress({ kind: 'ended', executionId: this.options.executionId, status, error: errorMessage, inquiry: this.inquiry });
    await this.log.flush();
    try {
      await this.options.services.storeRecordings(this.recorder.build(durationMs));
    } catch (error) {
      this.logger.warn(`Could not store the recordings of execution ${this.options.executionId}: ${messageOf(error)}`);
    }
    try {
      await this.options.services.close(ending);
    } catch (error) {
      this.logger.warn(`Could not close execution ${this.options.executionId}: ${messageOf(error)}`);
    }
    this.options.transport.close();
    return ending;
  }

  private node(id: string | null) {
    return id ? (this.options.graph.nodes.find((node) => node.id === id) ?? null) : null;
  }

  private async walk() {
    let step: ScenarioGraphNode | null = this.options.graph.nodes.find((node) => node.type === 'start') ?? null;
    while (step && !this.aborted) {
      this.enter(step);
      let next: ScenarioGraphNode | null = null;
      if (step.type === 'start') {
        await this.pause(this.timing.startPauseMs);
        next = nextStep(this.options.graph, step.id);
      } else if (step.type === 'tts') {
        const text = step.data.text.trim();
        await this.speakFixed(step.data.modelId ?? '', text, 'step', step.id, this.run.signal);
        if (this.aborted) return;
        this.messages.push({ role: 'assistant', content: text });
        next = nextStep(this.options.graph, step.id);
      } else if (step.type === 'menu') {
        const option = await this.runMenu(step);
        if (!option) return;
        next = this.node(branchTarget(this.options.graph, step.id, option.id));
      } else if (step.type === 'loop') {
        await this.runLoop(step.id, step.data);
        next = nextStep(this.options.graph, step.id);
      } else if (step.type === 'switch') {
        next = this.route(step);
      } else {
        await this.speaker.drained();
        await this.pause(this.timing.endPauseMs);
        if (!this.aborted) this.leave('completed');
        return;
      }
      if (this.aborted) return;
      if (!next) throw new Error('A step in this scenario has no next step.');
      this.leave('completed');
      step = next;
    }
  }

  private enter(node: ScenarioGraphNode) {
    this.active = node;
    this.log.event('node.entered', { nodeId: node.id, nodeType: node.type, title: NODE_TITLE[node.type] }, node.id);
    this.progress({ kind: 'step', nodeId: node.id });
  }

  private leave(reason: 'completed' | 'stopped' | 'failed') {
    if (!this.active) return;
    this.log.event('node.left', { nodeId: this.active.id, reason }, this.active.id);
    this.active = null;
  }

  private pause(ms: number) {
    return new Promise<void>((resolve) => {
      if (this.aborted) return resolve();
      const timer = setTimeout(done, ms);
      this.run.signal.addEventListener('abort', done, { once: true });
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private onMedia(payload: string) {
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.length === 0) return;
    const heard = this.recorder.hear(bytes, this.clock());
    this.listener?.hear(heard.samples, heard.atMs, this.clock());
  }

  private onKey(digit: string) {
    if (!/^[0-9*#]$/.test(digit)) return;
    const menu = this.menu;
    const option = menu && !menu.chosen ? (menu.node.data.options.find((item) => item.key === digit) ?? null) : null;
    this.log.event('key.pressed', { key: digit, accepted: Boolean(option) }, menu?.node.id ?? this.active?.id ?? null);
    if (!menu || !option) return;
    menu.chosen = option;
    menu.stopPrompt?.abort();
    menu.keyWaiter?.();
  }

  /** Plays a line known before the call. Returns quietly when `signal` stops it. */
  private async speakFixed(modelId: string, text: string, kind: SpokenKind, nodeId: string, signal: AbortSignal) {
    const context = this.log.context({ nodeId, kind });
    let audio: Buffer;
    try {
      audio = await this.options.services.clip(modelId, text, context, signal);
    } catch (error) {
      if (signal.aborted) return 'cleared';
      throw error;
    }
    return this.playLine(audio, { text, kind, nodeId, audioSeq: context.clientSeq }, signal);
  }

  /** Plays audio and records `tts.played`, amended with its end when the mark comes back or `clear` cuts it. */
  private async playLine(audio: Buffer, meta: { text: string; kind: SpokenKind; nodeId: string; audioSeq: number }, signal: AbortSignal): Promise<Played> {
    if (signal.aborted) return 'cleared';
    const { startMs, done } = this.speaker.play(audio);
    const seq = this.log.event(
      'tts.played',
      { audioEventSeq: meta.audioSeq, text: meta.text, kind: meta.kind, endMs: null, interrupted: false },
      meta.nodeId,
      startMs,
    );
    this.progress({ kind: 'agent', text: meta.text, spoken: meta.kind });
    const stop = () => this.speaker.clear();
    signal.addEventListener('abort', stop, { once: true });
    const result = await done;
    signal.removeEventListener('abort', stop);
    this.log.amend(seq, { endMs: Math.round(result.endMs), interrupted: result.outcome === 'cleared' && !this.aborted });
    return result.outcome;
  }

  private async runMenu(node: Extract<ScenarioGraphNode, { type: 'menu' }>): Promise<MenuOption | null> {
    const data: MenuNodeData = node.data;
    const menu: MenuState = { node, chosen: null, stopPrompt: null, keyWaiter: null };
    this.menu = menu;
    let promptsPlayed = 0;
    try {
      for (let round = 0; round <= data.repeats && !menu.chosen && !this.aborted; round += 1) {
        for (const prompt of data.prompts) {
          menu.stopPrompt = new AbortController();
          await this.speakFixed(prompt.ttsModelId ?? '', prompt.text, 'menu', node.id, AbortSignal.any([this.run.signal, menu.stopPrompt.signal]));
          if (menu.chosen || this.aborted) break;
        }
        promptsPlayed += 1;
        if (menu.chosen || this.aborted) break;
        await this.waitForKey(menu, data.waitSeconds * this.timing.secondMs);
      }
    } finally {
      this.menu = null;
    }
    if (this.aborted) return null;
    const option = menu.chosen ?? data.options.find((item) => item.id === data.defaultOptionId) ?? data.options[0];
    this.log.event(
      'menu.chosen',
      { optionId: option.id, label: option.label, key: menu.chosen ? option.key : null, usedDefault: !menu.chosen, promptsPlayed },
      node.id,
    );
    this.menuChoices.push(option.label);
    return option;
  }

  private waitForKey(menu: MenuState, ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.run.signal.removeEventListener('abort', done);
        menu.keyWaiter = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.run.signal.addEventListener('abort', done, { once: true });
      menu.keyWaiter = done;
      if (menu.chosen || this.aborted) done();
    });
  }

  private route(node: Extract<ScenarioGraphNode, { type: 'switch' }>) {
    const topics = node.data.topics;
    const fallback = topics.find((topic) => topic.isDefault) ?? topics[0];
    const matched = this.topicId && topics.some((topic) => topic.id === this.topicId) ? this.topicId : fallback.id;
    const usedFallback = matched === fallback.id;
    const label = usedFallback ? fallback.description || 'Default' : topics.find((topic) => topic.id === matched)?.description || matched;
    const nextId = branchTarget(this.options.graph, node.id, matched) ?? branchTarget(this.options.graph, node.id, fallback.id);
    this.topicId = matched;
    this.topicLabel = label;
    this.log.event('switch.routed', { topicId: matched, topicLabel: label, usedFallback, nextNodeId: nextId }, node.id);
    this.progress({ kind: 'topic', topicId: matched, label });
    if (usedFallback && this.inquiry) this.markCallback('DEFAULT_TOPIC');
    return this.node(nextId);
  }

  /** Only phone calls are marked, because a browser call has no number to call back. A call keeps its first reason. */
  private markCallback(reason: CallbackReason) {
    if (this.options.channel !== 'PHONE' || this.callbackReason) return;
    this.callbackReason = reason;
    this.log.event('callback.marked', { reason }, this.active?.id ?? null);
  }

  private async runLoop(nodeId: string, data: LoopNodeData) {
    const topics = topicsAhead(this.options.graph, nodeId);
    const listener = new Listener(data.silenceSeconds * 1000, this.clock());
    this.listener = listener;
    const sttModelId = data.sttModelId ?? '';
    const ttsModelId = data.ttsModelId ?? '';
    const llmModelId = data.llmModelId ?? '';
    const priorMessages = this.messages.length;
    let note: string | undefined;
    let skipFiller = false;

    try {
      const fillers = await this.prepareFillers(ttsModelId, data.fillers, nodeId);
      while (!this.aborted) {
        const utterance = await this.nextUtterance(listener, data.noInputSeconds * this.timing.secondMs);
        if (this.aborted) return;
        if (utterance === 'silence') return this.unresolved('SILENCE', nodeId);

        const delay =
          !skipFiller && !listener.hasPendingSpeech() ? this.playUntilSpeech(listener, (signal) => this.playDelay(fillers, nodeId, signal)) : null;
        let text = '';
        try {
          const context = this.log.context({ nodeId, utterance });
          text = (await this.options.services.transcribe(sttModelId, wavFile(utterance.samples), context, this.run.signal)).trim();
        } catch (error) {
          delay?.stop();
          await delay?.done;
          throw error;
        }
        if (this.aborted || !text) {
          delay?.stop();
          await delay?.done;
          if (this.aborted) return;
          continue;
        }

        this.messages.push({ role: 'user', content: text });
        this.progress({ kind: 'caller', text });
        const turnsHere = this.messages.slice(priorMessages).filter((message) => message.role === 'user').length;
        this.log.event('turn.counted', { turn: turnsHere, maxTurns: data.maxTurns }, nodeId);
        if (turnsHere > data.maxTurns) {
          delay?.stop();
          await delay?.done;
          return this.unresolved('TURN_LIMIT', nodeId);
        }

        if (!delay && listener.hasPendingSpeech()) {
          note = BEFORE_ANSWER;
          skipFiller = true;
          continue;
        }

        const llmAbort = new AbortController();
        const llmSignal = AbortSignal.any([this.run.signal, llmAbort.signal]);
        const request: TurnRequest = {
          messages: this.messages.map((message) => ({ ...message })),
          ...(note ? { note } : {}),
          ...(topics ? { topics: topics.topics, defaultTopicId: topics.defaultTopicId } : {}),
        };
        const turnPromise = this.options.services.complete(llmModelId, request, this.log.context({ nodeId }), llmSignal);
        void turnPromise.catch(() => undefined);

        if (delay) {
          const played = await delay.done;
          if (played !== 'played') {
            llmAbort.abort();
            if (this.aborted) {
              this.discardLlm(llmModelId, request, 'stopped', nodeId);
              return;
            }
            if (played === 'interrupted') {
              this.log.event('barge_in', { during: 'delay', note: 'before_answer' }, nodeId);
              this.discardLlm(llmModelId, request, 'barge_in', nodeId);
              note = BEFORE_ANSWER;
              skipFiller = true;
            }
            continue;
          }
        }

        skipFiller = false;
        const turn = await this.untilSpeechOr(listener, (signal) => {
          signal.addEventListener('abort', () => llmAbort.abort(), { once: true });
          return turnPromise;
        });
        if (this.aborted) {
          this.discardLlm(llmModelId, request, 'stopped', nodeId);
          return;
        }
        if (turn === 'interrupted') {
          this.log.event('barge_in', { during: 'llm', note: 'before_answer' }, nodeId);
          this.discardLlm(llmModelId, request, 'barge_in', nodeId);
          note = BEFORE_ANSWER;
          skipFiller = true;
          continue;
        }

        note = undefined;
        if (turn.reply.trim()) {
          this.messages.push({ role: 'assistant', content: turn.reply });
          const spoken = await this.untilSpeechOr(listener, async (signal) => {
            const context = this.log.context({ nodeId, kind: 'reply' });
            const audio = await this.options.services.clip(ttsModelId, turn.reply, context, signal);
            return this.playLine(audio, { text: turn.reply, kind: 'reply', nodeId, audioSeq: context.clientSeq }, signal);
          });
          if (this.aborted) return;
          if (spoken === 'interrupted') {
            const last = this.messages[this.messages.length - 1];
            if (last?.role === 'assistant') last.interrupted = true;
            this.log.event('barge_in', { during: 'reply', note: 'reply_cut_off' }, nodeId);
            note = REPLY_CUT_OFF;
            skipFiller = true;
            continue;
          }
        }

        if (turn.phase === 'accepted' && turn.inquiry) {
          this.inquiry = turn.inquiry;
          if (turn.topicId) this.topicId = turn.topicId;
          this.log.event('inquiry.accepted', { inquiry: turn.inquiry, topicId: turn.topicId }, nodeId);
          this.progress({ kind: 'inquiry', inquiry: turn.inquiry, topicId: turn.topicId });
          return;
        }
      }
    } catch (error) {
      if (this.aborted || isAbort(error)) return;
      await this.sayGoodbyeAfterFailure(ttsModelId, data.sorryLine, nodeId);
      throw new LoopFailure(messageOf(error));
    } finally {
      this.listener = null;
    }
  }

  /** A provider failed in a loop: stop all audio and say the sorry line. A failing sorry line is skipped. */
  private async sayGoodbyeAfterFailure(ttsModelId: string, sorryLine: string, nodeId: string) {
    this.speaker.clear();
    if (this.aborted || !ttsModelId || !sorryLine) return;
    try {
      await this.speakFixed(ttsModelId, sorryLine, 'sorry', nodeId, this.run.signal);
    } catch (error) {
      this.logger.warn(`The sorry line failed for execution ${this.options.executionId}: ${messageOf(error)}`);
    }
  }

  private unresolved(reason: 'TURN_LIMIT' | 'SILENCE', nodeId: string) {
    this.log.event('loop.unresolved', { reason }, nodeId);
    this.markCallback(reason);
  }

  private async prepareFillers(ttsModelId: string, lines: string[], nodeId: string) {
    const fillers = lines.length > 0 ? lines : ["Just a moment, I'll check."];
    return Promise.all(
      fillers.map(async (line) => {
        const context = this.log.context({ nodeId, kind: 'delay' });
        const audio = await this.options.services.clip(ttsModelId, line, context, this.run.signal);
        return { line, audio, seq: context.clientSeq };
      }),
    );
  }

  private async playDelay(fillers: Array<{ line: string; audio: Buffer; seq: number }>, nodeId: string, signal: AbortSignal) {
    const filler = fillers[Math.floor(Math.random() * fillers.length)];
    await this.playLine(filler.audio, { text: filler.line, kind: 'delay', nodeId, audioSeq: filler.seq }, signal);
  }

  /**
   * The next utterance, or 'silence' when the caller has not started speaking `noInputMs` after the last audio played.
   * Resolves with 'silence' too if the call is stopped, which the loop checks first.
   */
  private nextUtterance(listener: Listener, noInputMs: number): Promise<Utterance | 'silence'> {
    const queued = listener.takeUtterance();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const finish = (value: Utterance | 'silence') => {
        clearInterval(check);
        listener.onUtterance(null);
        this.run.signal.removeEventListener('abort', stopped);
        resolve(value);
      };
      const stopped = () => finish('silence');
      const check = setInterval(() => {
        if (listener.ear.phase !== 'idle' || !this.speaker.idle) return;
        const since = Math.max(this.speaker.lastEndMs, listener.lastActivityMs);
        if (this.clock() - since >= noInputMs) finish('silence');
      }, Math.min(100, Math.max(5, noInputMs / 10)));
      listener.onUtterance((utterance) => finish(utterance));
      this.run.signal.addEventListener('abort', stopped, { once: true });
    });
  }

  private playUntilSpeech(listener: Listener, play: (signal: AbortSignal) => Promise<void>) {
    const cancel = new AbortController();
    let stopped = false;
    const done = this.untilSpeechOr(listener, (signal) => play(AbortSignal.any([signal, cancel.signal]))).then((result) => {
      if (stopped) return 'cancelled' as const;
      return result === 'interrupted' ? ('interrupted' as const) : ('played' as const);
    });
    return {
      done,
      stop() {
        stopped = true;
        cancel.abort();
      },
    };
  }

  /** Runs `work` until it finishes or the caller starts speaking, which aborts it and returns 'interrupted'. */
  private async untilSpeechOr<T>(listener: Listener, work: (signal: AbortSignal) => Promise<T>): Promise<T | 'interrupted'> {
    if (this.aborted) return 'interrupted';
    const child = new AbortController();
    const onAbort = () => child.abort();
    this.run.signal.addEventListener('abort', onAbort, { once: true });
    const speech = listener.speech();
    const done = work(child.signal).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const first = await Promise.race([speech.promise.then(() => 'speech' as const), done]);
    this.run.signal.removeEventListener('abort', onAbort);
    if (first === 'speech') {
      child.abort();
      return 'interrupted';
    }
    speech.cancel();
    if (!first.ok) {
      if (this.aborted || isAbort(first.error)) return 'interrupted';
      throw first.error;
    }
    listener.ear.discardUnconfirmed();
    return first.value;
  }

  /** Records that an LLM answer was thrown away. The answer itself, if it came, is `llm.completed`. */
  private discardLlm(modelId: string, request: TurnRequest, reason: 'barge_in' | 'stopped', nodeId: string) {
    const seq = this.log.event(
      'llm.aborted',
      {
        modelId,
        systemPrompt: inquirySystemPrompt(request.note, request.topics, request.defaultTopicId),
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.interrupted
            ? `${message.content}\n[interrupted: the caller spoke over this and may not have heard it fully]`
            : message.content,
        })),
        note: request.note ?? null,
        topics: request.topics ?? null,
        defaultTopicId: request.defaultTopicId ?? null,
        reason,
      },
      nodeId,
    );
    let snapshot = this.llmSnapshots.get(modelId);
    if (!snapshot) {
      snapshot = this.options.services.describeLlm(modelId).catch(() => ({}));
      this.llmSnapshots.set(modelId, snapshot);
    }
    void snapshot.then((model) => this.log.amend(seq, model));
  }
}
