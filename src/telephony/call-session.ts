import { WebSocket } from 'ws';
import { ExecutionContext, SpokenKind } from '../scenario-executions/execution-context';
import { ScenarioGraph, ScenarioGraphNode } from '../scenarios/scenario-graph';
import { LANGUAGE_NAME, LanguageVoice, ScenarioLanguage, ScenarioLanguageModels, delayLines, emptyVoice, languageKeyLine, spokenLine } from '../scenarios/scenario-languages';
import { CallLog } from './call-log';
import { DtmfDecoder } from './dtmf';
import { decodeUlaw, pcmWav, rms } from './ulaw';

const FRAME = 160;
const SPEECH_RMS = 500;
const START_FRAMES = 15;
const MAX_CLOSING_RETURNS = 8;

interface Turn {
  reply: string;
  inquiry: string | null;
  phase: string;
  topicId: string | null;
}

export interface LiveEar {
  push(audio: Buffer): void;
  finish(): Promise<string>;
  cancel(): void;
}

export interface CallDeps {
  speak(modelId: string, text: string, execution: ExecutionContext | null): Promise<Buffer>;
  speakStream(modelId: string, text: string, execution: ExecutionContext | null, onChunk: (chunk: Buffer) => void): Promise<void>;
  transcribe(modelId: string, wav: Buffer, execution: ExecutionContext | null): Promise<string>;
  openLive(modelId: string): Promise<LiveEar | null>;
  rememberTranscript(modelId: string, wav: Buffer, text: string, startedAt: number, execution: ExecutionContext | null): Promise<string>;
  complete(
    modelId: string,
    input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; note?: string; topics?: Array<{ id: string; description: string }>; defaultTopicId?: string; closingReturn?: boolean; language?: string },
    execution: ExecutionContext | null,
  ): Promise<Turn>;
  streamTurn(
    modelId: string,
    input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; note?: string; topics?: Array<{ id: string; description: string }>; defaultTopicId?: string; closingReturn?: boolean; language?: string },
    execution: ExecutionContext | null,
  ): { sentences: AsyncIterable<string>; turn: Promise<Turn> };
  judgeClosing(modelId: string, question: string, answer: string, execution: ExecutionContext | null): Promise<'questions' | 'done'>;
  onDigit?(digit: string): void;
}

interface Inbound {
  event?: string;
  media?: { payload?: string };
  mark?: { name?: string };
  start?: { streamSid?: string; customParameters?: Record<string, string> };
  dtmf?: { digit?: string };
}

/** One phone call. Twilio sends μ-law, and the session walks the scenario. */
export class PhoneScenarioSession {
  private streamSid = '';
  private closed = false;
  private playing = false;
  private samples: Int16Array[] = [];
  private markWait: ((name: string) => void) | null = null;
  private messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private topicId: string | null = null;
  private topicLabel: string | null = null;
  private inquiry: string | null = null;
  private resume = false;
  private closingReturns = 0;
  private reachedEnd = false;
  private utteranceStartMs = 0;
  private utteranceDurationMs = 0;
  private language: ScenarioLanguage;
  private languageLocked = false;
  private listeningForDigit = false;
  private pendingDigit: string | null = null;
  private digitWait: ((digit: string | null) => void) | null = null;
  private hangupCall: (() => Promise<void>) | null = null;
  private readonly tones = new DtmfDecoder((digit) => this.takeDigit(digit));
  private liveEar: LiveEar | null = null;
  private captureLive = false;
  private liveQueue: Buffer[] = [];
  private playGeneration = 0;
  private ulawRest: Buffer = Buffer.alloc(0);
  private stopPlayback: (() => void) | null = null;

  constructor(
    private readonly socket: WebSocket,
    private readonly graph: ScenarioGraph,
    private readonly deps: CallDeps,
    private log: CallLog,
    private readonly languages: ScenarioLanguage[] = ['en'],
    private readonly languageModels: ScenarioLanguageModels = {},
    private readonly askLanguage = false,
    chosenLanguage: ScenarioLanguage | null = null,
  ) {
    this.language = chosenLanguage ?? languages[0] ?? 'en';
    this.languageLocked = Boolean(chosenLanguage);
  }

  useLog(log: CallLog) {
    this.log = log;
  }

  outcome() {
    this.log.inquiry = this.inquiry;
    this.log.topicId = this.topicId;
    this.log.topicLabel = this.topicLabel;
    return { reachedEnd: this.reachedEnd };
  }

  receive(raw: string) {
    let message: Inbound;
    try {
      message = JSON.parse(raw) as Inbound;
    } catch {
      return;
    }
    if (message.event === 'start' && message.start?.streamSid) this.streamSid = message.start.streamSid;
    if (message.event === 'media' && message.media?.payload) {
      const ulaw = Buffer.from(message.media.payload, 'base64');
      const decoded = decodeUlaw(ulaw);
      if (this.listeningForDigit) this.tones.push(decoded);
      this.log.caller(decoded);
      if (!this.playing) {
        this.samples.push(decoded);
        if (this.liveEar) {
          if (this.captureLive) this.liveEar.push(ulaw);
          else {
            this.liveQueue.push(ulaw);
            if (this.liveQueue.length > 100) this.liveQueue.shift();
          }
        }
      }
    }
    if (message.event === 'mark' && message.mark?.name) this.markWait?.(message.mark.name);
    if (message.event === 'dtmf' && message.dtmf?.digit && this.listeningForDigit) this.takeDigit(message.dtmf.digit);
    if (message.event === 'stop') {
      this.closed = true;
      this.digitWait?.(null);
    }
  }

  hangUp() {
    this.closed = true;
    this.digitWait?.(null);
  }

  prepareHangup(hangup: () => Promise<void>) {
    this.hangupCall = hangup;
  }

  async run() {
    try {
      await this.chooseLanguage();
      let nodeId = this.next(this.node('start')?.id ?? '', null);
      const seen = new Set<string>();
      while (nodeId && !this.closed) {
        if (seen.has(nodeId) && this.node(nodeId)?.type !== 'loop' && this.node(nodeId)?.type !== 'closing') break;
        const node = this.node(nodeId);
        if (!node || node.type === 'end' || node.type === 'start') break;
        seen.add(nodeId);
        if (node.type === 'tts') {
          await this.speak(this.voice().ttsModelId, spokenLine(node.data, this.language), node.id, 'step');
          nodeId = this.next(node.id, null);
        } else if (node.type === 'loop') {
          const accepted = await this.loop(node);
          nodeId = accepted ? this.next(node.id, null) : null;
        } else if (node.type === 'switch') {
          const topic = node.data.topics.find((item) => item.id === this.topicId) ?? node.data.topics.find((item) => item.isDefault);
          if (topic) this.topicLabel = topic.description.trim() || null;
          nodeId = topic ? this.next(node.id, topic.id) : null;
        } else if (node.type === 'closing') {
          const outcome = await this.closing(node);
          if (outcome === 'questions') {
            this.closingReturns += 1;
            if (this.closingReturns > MAX_CLOSING_RETURNS) break;
            this.resume = true;
            seen.clear();
          }
          nodeId = this.next(node.id, outcome);
        }
      }
    } finally {
      this.reachedEnd = !this.closed;
      await this.hangupCall?.();
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'Call ended.');
    }
  }

  private voice(): LanguageVoice {
    return this.languageModels[this.language] ?? emptyVoice();
  }

  private takeDigit(digit: string) {
    const key = digit.trim();
    if (!/^[0-9]$/.test(key)) return;
    this.deps.onDigit?.(key);
    if (this.digitWait) this.digitWait(key);
    else this.pendingDigit = key;
  }

  private waitForDigit(ms: number) {
    if (this.pendingDigit) {
      const digit = this.pendingDigit;
      this.pendingDigit = null;
      return Promise.resolve(digit);
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.digitWait = null;
        resolve(null);
      }, ms);
      this.digitWait = (digit) => {
        clearTimeout(timer);
        this.digitWait = null;
        resolve(digit);
      };
    });
  }

  private async chooseLanguage() {
    if (this.languageLocked || !this.askLanguage || this.languages.length === 0 || this.closed) return;
    if (this.languages.some((code) => !this.languageModels[code]?.ttsModelId)) {
      this.closed = true;
      return;
    }
    this.pendingDigit = null;
    this.listeningForDigit = true;
    try {
      for (let index = 0; index < this.languages.length; index += 1) {
        const code = this.languages[index];
        await this.speak(this.languageModels[code]?.ttsModelId ?? null, languageKeyLine(code, index), 'language', 'step');
        if (this.closed) return;
        if (this.pendingDigit) break;
      }
      const pressed = this.pendingDigit;
      this.pendingDigit = null;
      const digit = pressed ?? (await this.waitForDigit(12_000));
      const chosen = digit ? this.languages[Number(digit) - 1] : undefined;
      if (!chosen) {
        this.closed = true;
        return;
      }
      this.language = chosen;
    } finally {
      this.listeningForDigit = false;
    }
  }

  private heardContext(nodeId: string) {
    return this.log.context(nodeId, null, { startedMs: this.utteranceStartMs, durationMs: this.utteranceDurationMs });
  }

  private async loop(node: Extract<ScenarioGraphNode, { type: 'loop' }>) {
    const { silenceSeconds, maxTurns } = node.data;
    const { sttModelId, ttsModelId, llmModelId } = this.voice();
    const fillers = delayLines(node.data, this.language);
    if (!sttModelId || !ttsModelId || !llmModelId) return false;
    let turns = 0;
    while (!this.closed && turns < maxTurns) {
      const fromClosing = this.resume;
      this.resume = false;
      let text = '';
      let delay = Promise.resolve();
      if (fromClosing) {
        text = this.messages.at(-1)?.content ?? '';
        delay = this.speakDelay(ttsModelId, fillers, node.id);
      } else {
        const prepared = this.prepareDelay(ttsModelId, fillers, node.id);
        const liveStarted = Date.now();
        const live = await this.deps.openLive(sttModelId).catch(() => null);
        this.liveEar = live;
        let heard: Int16Array | null = null;
        try {
          heard = await this.listen(silenceSeconds);
        } finally {
          this.captureLive = false;
          this.liveEar = null;
        }
        if (!heard || this.closed) {
          live?.cancel();
          prepared.abandon();
          return false;
        }
        delay = prepared.play();
        try {
          const liveText = live ? await live.finish().catch(() => '') : '';
          text = liveText.trim()
            ? await this.deps.rememberTranscript(sttModelId, pcmWav(heard), liveText.trim(), liveStarted, this.heardContext(node.id))
            : await this.deps.transcribe(sttModelId, pcmWav(heard), this.heardContext(node.id));
        } catch (error) {
          this.cutPlayback();
          await delay.catch(() => undefined);
          throw error;
        }
        if (!text.trim()) {
          this.cutPlayback();
          await delay.catch(() => undefined);
          continue;
        }
        this.messages.push({ role: 'user', content: text.trim() });
      }
      turns += 1;
      const topics = this.topicsAhead(node.id);
      const turnInput = {
        messages: this.messages,
        language: LANGUAGE_NAME[this.language],
        ...(fromClosing ? { closingReturn: true } : {}),
        ...(topics ?? {}),
      };
      const streamed = this.deps.streamTurn(llmModelId, turnInput, this.log.context(node.id, null));
      void streamed.turn.catch(() => undefined);
      let spoke = false;
      try {
        for await (const sentence of streamed.sentences) {
          if (this.closed) return false;
          const line = sentence.trim();
          if (!line) continue;
          if (!spoke) {
            this.cutPlayback();
            await delay.catch(() => undefined);
          }
          spoke = true;
          await this.speak(ttsModelId, line, node.id, 'reply');
        }
      } catch (error) {
        this.cutPlayback();
        throw error;
      }
      if (!spoke) {
        this.cutPlayback();
        await delay.catch(() => undefined);
      }
      const turn = await streamed.turn;
      if (!spoke && turn.reply.trim()) await this.speak(ttsModelId, turn.reply, node.id, 'reply');
      if (turn.reply.trim()) this.messages.push({ role: 'assistant', content: turn.reply });
      if (turn.phase === 'accepted' && turn.inquiry) {
        this.inquiry = turn.inquiry;
        this.topicId = turn.topicId;
        return true;
      }
    }
    return false;
  }

  private async closing(node: Extract<ScenarioGraphNode, { type: 'closing' }>) {
    const { silenceSeconds } = node.data;
    const { ttsModelId, sttModelId, llmModelId } = this.voice();
    const text = spokenLine(node.data, this.language);
    if (!ttsModelId || !sttModelId || !llmModelId || !text) return 'done' as const;
    await this.speak(ttsModelId, text, node.id, 'step');
    this.messages.push({ role: 'assistant', content: text });
    const heard = await this.listen(silenceSeconds);
    if (!heard) return 'done' as const;
    const answer = (await this.deps.transcribe(sttModelId, pcmWav(heard), this.heardContext(node.id))).trim();
    if (!answer) return 'done' as const;
    this.messages.push({ role: 'user', content: answer });
    return this.deps.judgeClosing(llmModelId, text, answer, this.log.context(node.id, null));
  }

  /** Load a delay line while the caller is still talking, so it can play the moment they go quiet. */
  private prepareDelay(ttsModelId: string, fillers: string[], nodeId: string) {
    const lines = fillers.map((line) => line.trim()).filter(Boolean);
    const text = lines[Math.floor(Math.random() * lines.length)] ?? '';
    if (!text || this.closed) return { play: () => Promise.resolve(), abandon: () => undefined };
    const pending = this.deps.speak(ttsModelId, text, this.log.context(nodeId, 'delay'));
    void pending.catch(() => undefined);
    return {
      play: () => this.playUlaw(text, nodeId, 'delay', pending),
      abandon: () => undefined,
    };
  }

  private speakDelay(ttsModelId: string, fillers: string[], nodeId: string) {
    return this.prepareDelay(ttsModelId, fillers, nodeId).play();
  }

  private async speak(modelId: string | null, text: string, nodeId: string, kind: SpokenKind) {
    if (!modelId || !text.trim() || this.closed) return;
    const token = this.playGeneration;
    const ctx = this.log.context(nodeId, kind);
    let startMs = 0;
    let sent = 0;
    const heard: Buffer[] = [];
    try {
      await this.deps.speakStream(modelId, text, ctx, (chunk) => {
        if (token !== this.playGeneration || this.closed || !chunk.length) return;
        if (!startMs) {
          startMs = this.log.now();
          this.playing = true;
          this.samples = [];
        }
        heard.push(chunk);
        sent += this.writeUlaw(chunk);
      });
      if (heard.length) this.log.agent(decodeUlaw(Buffer.concat(heard)));
      await this.finishPlayback(token, sent, startMs, nodeId, text, kind);
    } finally {
      if (token === this.playGeneration) {
        this.playing = false;
        this.samples = [];
      }
    }
  }

  private async playUlaw(text: string, nodeId: string, kind: SpokenKind, pending: Promise<Buffer>) {
    const token = this.playGeneration;
    const audio = await pending;
    if (this.closed || token !== this.playGeneration || !audio.length) return;
    const startMs = this.log.now();
    this.log.agent(decodeUlaw(audio));
    this.playing = true;
    this.samples = [];
    try {
      const sent = this.writeUlaw(audio);
      await this.finishPlayback(token, sent, startMs, nodeId, text, kind);
    } finally {
      if (token === this.playGeneration) {
        this.playing = false;
        this.samples = [];
      }
    }
  }

  private cutPlayback() {
    this.playGeneration += 1;
    this.ulawRest = Buffer.alloc(0);
    this.playing = false;
    this.send({ event: 'clear' });
    const stop = this.stopPlayback;
    this.stopPlayback = null;
    stop?.();
  }

  private writeUlaw(chunk: Buffer) {
    const data = this.ulawRest.length ? Buffer.concat([this.ulawRest, chunk]) : chunk;
    const whole = data.length - (data.length % FRAME);
    for (let offset = 0; offset < whole && !this.closed; offset += FRAME) {
      this.send({ event: 'media', media: { payload: data.subarray(offset, offset + FRAME).toString('base64') } });
    }
    this.ulawRest = Buffer.from(data.subarray(whole));
    return whole;
  }

  private async finishPlayback(token: number, sent: number, startMs: number, nodeId: string, text: string, kind: SpokenKind) {
    if (token !== this.playGeneration || this.closed) return;
    if (this.ulawRest.length) {
      const frame = Buffer.concat([this.ulawRest, Buffer.alloc(FRAME - this.ulawRest.length, 0xff)]);
      this.ulawRest = Buffer.alloc(0);
      this.send({ event: 'media', media: { payload: frame.toString('base64') } });
    }
    if (sent > 0 && startMs) await this.log.played({ nodeId, text, kind, startMs, endMs: startMs + Math.round(sent / 8) });
    await this.waitMark(token, sent);
  }

  private waitMark(token: number, bytes: number) {
    if (token !== this.playGeneration || this.closed || bytes <= 0) return Promise.resolve();
    const name = `m${Date.now()}`;
    this.send({ event: 'mark', mark: { name } });
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (this.markWait === onMark) this.markWait = null;
        if (this.stopPlayback === finish) this.stopPlayback = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.ceil(bytes / 8) + 2000);
      const onMark = (heard: string) => {
        if (heard !== name) return;
        finish();
      };
      this.markWait = onMark;
      this.stopPlayback = finish;
    });
  }

  private listen(silenceSeconds: number) {
    const quietNeeded = Math.max(1, silenceSeconds) * 50;
    let voiced = 0;
    let quiet = 0;
    let started = false;
    let ticks = 0;
    const uttered: Int16Array[] = [];
    this.samples = [];
    this.captureLive = false;
    this.liveQueue = [];
    return new Promise<Int16Array | null>((resolve) => {
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks % 1500 === 0) void this.log.touch();
        if (this.closed) {
          clearInterval(timer);
          resolve(null);
          return;
        }
        let frame = this.samples.shift();
        while (frame) {
          const loud = rms(frame) >= SPEECH_RMS;
          if (!started) {
            if (loud) voiced += 1;
            else voiced = 0;
            if (voiced >= START_FRAMES) {
              started = true;
              this.captureLive = true;
              const queued = this.liveQueue.splice(0);
              for (const frame of queued) this.liveEar?.push(frame);
              this.utteranceStartMs = Math.max(0, this.log.now() - START_FRAMES * 20);
              uttered.push(frame);
            }
          } else {
            uttered.push(frame);
            quiet = loud ? 0 : quiet + 1;
            if (quiet >= quietNeeded) {
              clearInterval(timer);
              this.utteranceDurationMs = Math.max(0, this.log.now() - this.utteranceStartMs);
              resolve(concat(uttered));
              return;
            }
          }
          frame = this.samples.shift();
        }
      }, 20);
    });
  }

  private topicsAhead(fromId: string) {
    let current = this.next(fromId, null);
    const seen = new Set<string>([fromId]);
    while (current && !seen.has(current)) {
      seen.add(current);
      const node = this.node(current);
      if (!node || node.type === 'end') return null;
      if (node.type === 'closing') {
        current = this.next(node.id, 'done');
        continue;
      }
      if (node.type === 'switch') {
        const fallback = node.data.topics.find((topic) => topic.isDefault);
        const described = node.data.topics.filter((topic) => !topic.isDefault && topic.description.trim());
        if (!fallback || described.length === 0) return null;
        return { defaultTopicId: fallback.id, topics: described.map((topic) => ({ id: topic.id, description: topic.description.trim() })) };
      }
      current = this.next(node.id, null);
    }
    return null;
  }

  private node(id: string) {
    return this.graph.nodes.find((node) => node.id === id);
  }

  private next(source: string, handle: string | null) {
    const edge = this.graph.edges.find((item) => item.source === source && (handle ? item.sourceHandle === handle : !item.sourceHandle || item.sourceHandle === 'out'));
    if (edge) return edge.target;
    if (handle) return this.graph.edges.find((item) => item.source === source && item.sourceHandle === handle)?.target ?? null;
    return this.graph.edges.find((item) => item.source === source)?.target ?? null;
  }

  private send(message: object) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ ...message, streamSid: this.streamSid }));
  }
}

function concat(frames: Int16Array[]) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const joined = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    joined.set(frame, offset);
    offset += frame.length;
  }
  return joined;
}
