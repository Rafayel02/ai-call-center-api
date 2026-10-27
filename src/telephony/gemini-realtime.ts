import { WebSocket } from 'ws';
import { RealtimeTools, runVoiceTool } from './realtime-tools';
import { fromGeminiOutput, toGeminiInput } from './gemini-audio';

interface RealtimeHandlers {
  onAudio: (payload: string) => void;
  onClear: () => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  onFinished?: () => void;
}

interface GeminiPart {
  inlineData?: { data?: unknown };
}

interface GeminiCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

interface GeminiMessage {
  setupComplete?: unknown;
  error?: { message?: unknown };
  toolCall?: { functionCalls?: GeminiCall[] };
  toolCallCancellation?: { ids?: string[] };
  serverContent?: {
    interrupted?: unknown;
    turnComplete?: boolean;
    modelTurn?: { parts?: GeminiPart[] };
  };
}

export function geminiSetup(model: string, instructions: string) {
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: instructions }] },
    },
  };
}

function publicMessage(text: string, fallback: string) {
  const cleaned = text.replace(/key=[^&\s]+/gi, 'key').replace(/AIza[0-9A-Za-z_-]+/g, '').trim();
  return cleaned.slice(0, 300) || fallback;
}

/** Speech-to-speech session on Gemini Live. The caller still sends the existing phone or browser audio. */
export class GeminiRealtime {
  readonly done: Promise<boolean>;
  private readonly socket: WebSocket;
  private readonly pending: string[] = [];
  private greeted = false;
  private ready = false;
  private settled = false;
  private reported = false;
  private farewellAudio = false;
  private toolQueue: Promise<void> = Promise.resolve();
  private readonly toolCalls = new Set<string>();
  private readonly cancelledTools = new Set<string>();
  private finish: ((ready: boolean) => void) | null = null;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly format: 'pcmu' | 'pcm',
    private readonly instructions: string,
    private readonly greeting: string,
    private readonly handlers: RealtimeHandlers,
    private readonly tools?: RealtimeTools,
    socketFactory: (url: string, options: { perMessageDeflate: boolean }) => WebSocket = (url, options) => new WebSocket(url, options),
  ) {
    this.socket = socketFactory(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`,
      { perMessageDeflate: false },
    );
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.socket.on('open', () => this.configure());
    this.socket.on('message', (data) => this.take(data.toString()));
    this.socket.on('error', (error) => {
      const text = error instanceof Error ? error.message : '';
      this.report(publicMessage(text, 'Could not reach Gemini.'));
    });
    this.socket.on('close', (code, reason) => {
      if (!this.ready) {
        const text = Buffer.isBuffer(reason) ? reason.toString('utf8') : '';
        this.report(publicMessage(text, `Gemini closed the call (${code}).`));
      }
      this.stop(this.ready);
    });
  }

  sendAudio(audio: string) {
    if (!audio) return;
    const pcm = toGeminiInput(audio, this.format);
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) {
      this.pending.push(pcm);
      if (this.pending.length > 200) this.pending.shift();
      return;
    }
    this.push(pcm);
  }

  close() {
    this.stop(this.ready);
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  private configure() {
    const setup = geminiSetup(this.model, this.instructions).setup;
    this.socket.send(
      JSON.stringify({
        setup: this.tools ? { ...setup, tools: [{ functionDeclarations: this.tools.definitions.map((tool) => ({ ...tool, parameters: geminiSchema(tool.parameters), ...(this.nonBlocking(tool.name) ? { behavior: 'NON_BLOCKING' } : {}) })) }] } : setup,
      }),
    );
  }

  private push(audio: string) {
    this.socket.send(
      JSON.stringify({
        realtimeInput: { audio: { data: audio, mimeType: 'audio/pcm;rate=16000' } },
      }),
    );
  }

  private take(raw: string) {
    let event: GeminiMessage;
    try {
      event = JSON.parse(raw) as GeminiMessage;
    } catch {
      return;
    }
    if (event.error) {
      const message = typeof event.error.message === 'string' ? event.error.message : '';
      this.report(publicMessage(message, 'Gemini could not continue the call.'));
      return;
    }
    if ('setupComplete' in event && !this.greeted) {
      this.greeted = true;
      this.ready = true;
      this.handlers.onReady?.();
      const queued = this.pending.splice(0);
      for (const audio of queued) this.push(audio);
      this.socket.send(JSON.stringify({ realtimeInput: { text: `Begin at the current step. If it is a speech step, say its line then advance. Otherwise greet briefly in the selected language: ${this.greeting}` } }));
    }
    for (const id of event.toolCallCancellation?.ids ?? []) this.cancelledTools.add(id);
    if (event.toolCall?.functionCalls?.length && this.tools) {
      const calls = event.toolCall.functionCalls;
      this.toolQueue = this.toolQueue.then(() => this.answerTools(calls)).catch(() => this.report('The voice operation failed.'));
    }
    if (event.serverContent?.interrupted) this.handlers.onClear();
    for (const part of event.serverContent?.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (typeof audio === 'string' && audio) {
        if (this.tools?.finished?.()) this.farewellAudio = true;
        this.handlers.onAudio(fromGeminiOutput(audio, this.format));
      }
    }
    if (event.serverContent?.turnComplete && this.farewellAudio && this.tools?.finished?.()) {
      this.handlers.onFinished?.();
      this.close();
    }
  }

  private async answerTools(calls: GeminiCall[]) {
    const tools = this.tools;
    if (!tools || this.socket.readyState !== WebSocket.OPEN) return;
    const functionResponses = [];
    for (const call of calls) {
      if (!call.id || !call.name || this.toolCalls.has(call.id) || this.cancelledTools.has(call.id)) continue;
      if (this.toolCalls.size >= 500) { this.report('The call reached its tool limit.'); this.close(); return; }
      this.toolCalls.add(call.id);
      const result = await runVoiceTool(tools, call.name, call.args ?? {});
      if (this.cancelledTools.has(call.id)) continue;
      functionResponses.push({ id: call.id, name: call.name, response: { result }, ...(this.nonBlocking(call.name) ? { scheduling: 'WHEN_IDLE' } : {}) });
    }
    if (functionResponses.length && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
  }

  private nonBlocking(name: string) {
    return /^(gemini-2\.5-|gemini-3\.8-)/.test(this.model) && (name === 'run_step' || name === 'search_knowledge');
  }

  private report(message: string) {
    if (this.reported) return;
    this.reported = true;
    this.handlers.onError?.(message);
  }

  private stop(ready: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.finish?.(ready);
    this.finish = null;
  }
}

function geminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'additionalProperties').map(([key, item]) => [key, key === 'type' && typeof item === 'string' ? item.toUpperCase() : geminiSchema(item)]));
}
