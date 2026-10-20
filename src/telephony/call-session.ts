import { WebSocket } from 'ws';
import { ScenarioGraph, ScenarioGraphNode } from '../scenarios/scenario-graph';
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
  speak(modelId: string, text: string): Promise<Buffer>;
  transcribe(modelId: string, wav: Buffer): Promise<string>;
  complete(
    modelId: string,
    input: { messages: Array<{ role: 'user' | 'assistant'; content: string }>; note?: string; topics?: Array<{ id: string; description: string }>; defaultTopicId?: string; closingReturn?: boolean },
  ): Promise<Turn>;
  judgeClosing(modelId: string, question: string, answer: string): Promise<'questions' | 'done'>;
}

interface Inbound {
  event?: string;
  media?: { payload?: string };
  mark?: { name?: string };
  start?: { streamSid?: string; customParameters?: Record<string, string> };
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
  private resume = false;
  private closingReturns = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly graph: ScenarioGraph,
    private readonly deps: CallDeps,
  ) {}

  receive(raw: string) {
    let message: Inbound;
    try {
      message = JSON.parse(raw) as Inbound;
    } catch {
      return;
    }
    if (message.event === 'start' && message.start?.streamSid) this.streamSid = message.start.streamSid;
    if (message.event === 'media' && message.media?.payload && !this.playing) {
      this.samples.push(decodeUlaw(Buffer.from(message.media.payload, 'base64')));
    }
    if (message.event === 'mark' && message.mark?.name) this.markWait?.(message.mark.name);
    if (message.event === 'stop') this.closed = true;
  }

  hangUp() {
    this.closed = true;
  }

  async run() {
    try {
      let nodeId = this.next(this.node('start')?.id ?? '', null);
      const seen = new Set<string>();
      while (nodeId && !this.closed) {
        if (seen.has(nodeId) && this.node(nodeId)?.type !== 'loop' && this.node(nodeId)?.type !== 'closing') break;
        const node = this.node(nodeId);
        if (!node || node.type === 'end' || node.type === 'start') break;
        seen.add(nodeId);
        if (node.type === 'tts') {
          await this.speak(node.data.modelId, node.data.text);
          nodeId = this.next(node.id, null);
        } else if (node.type === 'loop') {
          const accepted = await this.loop(node);
          nodeId = accepted ? this.next(node.id, null) : null;
        } else if (node.type === 'switch') {
          const topic = node.data.topics.find((item) => item.id === this.topicId) ?? node.data.topics.find((item) => item.isDefault);
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
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000, 'Call ended.');
    }
  }

  private async loop(node: Extract<ScenarioGraphNode, { type: 'loop' }>) {
    const { sttModelId, ttsModelId, llmModelId, fillers, silenceSeconds, maxTurns } = node.data;
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
        text = await this.deps.transcribe(sttModelId, pcmWav(heard));
        if (!text.trim()) continue;
        this.messages.push({ role: 'user', content: text.trim() });
      }
      turns += 1;
      const filler = fillers.map((line) => line.trim()).filter(Boolean);
      const delay = filler.length > 0 ? this.speak(ttsModelId, filler[Math.floor(Math.random() * filler.length)]) : Promise.resolve();
      const topics = this.topicsAhead(node.id);
      const turnPromise = this.deps.complete(llmModelId, {
        messages: this.messages,
        ...(fromClosing ? { closingReturn: true } : {}),
        ...(topics ?? {}),
      });
      await delay;
      const turn = await turnPromise;
      if (turn.reply.trim()) {
        this.messages.push({ role: 'assistant', content: turn.reply });
        await this.speak(ttsModelId, turn.reply);
      }
      if (turn.phase === 'accepted' && turn.inquiry) {
        this.topicId = turn.topicId;
        return true;
      }
    }
    return false;
  }

  private async closing(node: Extract<ScenarioGraphNode, { type: 'closing' }>) {
    const { ttsModelId, sttModelId, llmModelId, text, silenceSeconds } = node.data;
    if (!ttsModelId || !sttModelId || !llmModelId) return 'done' as const;
    await this.speak(ttsModelId, text);
    this.messages.push({ role: 'assistant', content: text });
    const heard = await this.listen(silenceSeconds);
    if (!heard) return 'done' as const;
    const answer = (await this.deps.transcribe(sttModelId, pcmWav(heard))).trim();
    if (!answer) return 'done' as const;
    this.messages.push({ role: 'user', content: answer });
    return this.deps.judgeClosing(llmModelId, text, answer);
  }

  private async speak(modelId: string | null, text: string) {
    if (!modelId || !text.trim() || this.closed) return;
    const audio = await this.deps.speak(modelId, text);
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
    const uttered: Int16Array[] = [];
    this.samples = [];
    return new Promise<Int16Array | null>((resolve) => {
      const timer = setInterval(() => {
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
              uttered.push(frame);
            }
          } else {
            uttered.push(frame);
            quiet = loud ? 0 : quiet + 1;
            if (quiet >= quietNeeded) {
              clearInterval(timer);
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
