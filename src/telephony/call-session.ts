import { WebSocket } from 'ws';
import { ExecutionContext, SpokenKind } from '../scenario-executions/execution-context';
import { ScenarioGraph, ScenarioGraphNode } from '../scenarios/scenario-graph';
import { LANGUAGE_NAME, LanguageVoice, ScenarioLanguage, ScenarioLanguageModels, delayLines, emptyVoice, languageKeyLine, spokenLine } from '../scenarios/scenario-languages';
import { CallLog } from './call-log';
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

export interface CallDeps {
  speak(modelId: string, text: string, execution: ExecutionContext | null): Promise<Buffer>;
  transcribe(modelId: string, wav: Buffer, execution: ExecutionContext | null): Promise<string>;
  complete(
    modelId: string,
    input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; note?: string; topics?: Array<{ id: string; description: string }>; defaultTopicId?: string; closingReturn?: boolean; language?: string },
    execution: ExecutionContext | null,
  ): Promise<Turn>;
  judgeClosing(modelId: string, question: string, answer: string, execution: ExecutionContext | null): Promise<'questions' | 'done'>;
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
  private pendingDigit: string | null = null;
  private digitWait: ((digit: string | null) => void) | null = null;

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
      const decoded = decodeUlaw(Buffer.from(message.media.payload, 'base64'));
      this.log.caller(decoded);
      if (!this.playing) this.samples.push(decoded);
    }
    if (message.event === 'mark' && message.mark?.name) this.markWait?.(message.mark.name);
    if (message.event === 'dtmf' && message.dtmf?.digit) this.takeDigit(message.dtmf.digit);
    if (message.event === 'stop') {
      this.closed = true;
      this.digitWait?.(null);
    }
  }

  hangUp() {
    this.closed = true;
    this.digitWait?.(null);
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
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'Call ended.');
    }
  }

  private voice(): LanguageVoice {
    return this.languageModels[this.language] ?? emptyVoice();
  }

  private takeDigit(digit: string) {
    if (this.digitWait) this.digitWait(digit);
    else this.pendingDigit = digit;
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
    for (let index = 0; index < this.languages.length; index += 1) {
      const code = this.languages[index];
      await this.speak(this.languageModels[code]?.ttsModelId ?? null, languageKeyLine(code, index), 'language', 'step');
      if (this.closed) return;
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
      if (fromClosing) {
        text = this.messages.at(-1)?.content ?? '';
      } else {
        const heard = await this.listen(silenceSeconds);
        if (!heard || this.closed) return false;
        text = await this.deps.transcribe(sttModelId, pcmWav(heard), this.heardContext(node.id));
        if (!text.trim()) continue;
        this.messages.push({ role: 'user', content: text.trim() });
      }
      turns += 1;
      const filler = fillers.map((line) => line.trim()).filter(Boolean);
      const delay = filler.length > 0 ? this.speak(ttsModelId, filler[Math.floor(Math.random() * filler.length)], node.id, 'delay') : Promise.resolve();
      const topics = this.topicsAhead(node.id);
      const turnPromise = this.deps.complete(
        llmModelId,
        {
          messages: this.messages,
          language: LANGUAGE_NAME[this.language],
          ...(fromClosing ? { closingReturn: true } : {}),
          ...(topics ?? {}),
        },
        this.log.context(node.id, null),
      );
      await delay;
      const turn = await turnPromise;
      if (turn.reply.trim()) {
        this.messages.push({ role: 'assistant', content: turn.reply });
        await this.speak(ttsModelId, turn.reply, node.id, 'reply');
      }
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

  private async speak(modelId: string | null, text: string, nodeId: string, kind: SpokenKind) {
    if (!modelId || !text.trim() || this.closed) return;
    const ctx = this.log.context(nodeId, kind);
    const audio = await this.deps.speak(modelId, text, ctx);
    const startMs = this.log.now();
    this.log.agent(decodeUlaw(audio));
    await this.log.played({ nodeId, text, kind, startMs, endMs: startMs + Math.round(audio.length / 8) });
    this.playing = true;
    this.samples = [];
    try {
      for (let offset = 0; offset < audio.length && !this.closed; offset += FRAME) {
        this.send({ event: 'media', media: { payload: audio.subarray(offset, offset + FRAME).toString('base64') } });
      }
      const name = `m${Date.now()}`;
      this.send({ event: 'mark', mark: { name } });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.markWait = null;
          resolve();
        }, Math.ceil(audio.length / 8) + 2000);
        this.markWait = (heard) => {
          if (heard !== name) return;
          clearTimeout(timer);
          this.markWait = null;
          resolve();
        };
      });
    } finally {
      this.playing = false;
      this.samples = [];
    }
  }

  private listen(silenceSeconds: number) {
    const quietNeeded = Math.max(1, silenceSeconds) * 50;
    let voiced = 0;
    let quiet = 0;
    let started = false;
    let ticks = 0;
    const uttered: Int16Array[] = [];
    this.samples = [];
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
