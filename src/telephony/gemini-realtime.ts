import { WebSocket } from 'ws';
import { fromGeminiOutput, toGeminiInput } from './gemini-audio';

interface RealtimeHandlers {
  onAudio: (payload: string) => void;
  onClear: () => void;
  onError?: (message: string) => void;
  onReady?: () => void;
}

interface GeminiPart {
  inlineData?: { data?: unknown };
}

interface GeminiCall {
  id?: string;
  name?: string;
  args?: { query?: unknown };
}

interface GeminiMessage {
  setupComplete?: unknown;
  error?: { message?: unknown };
  toolCall?: { functionCalls?: GeminiCall[] };
  serverContent?: {
    interrupted?: unknown;
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
  private finish: ((ready: boolean) => void) | null = null;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly format: 'pcmu' | 'pcm',
    private readonly instructions: string,
    private readonly greeting: string,
    private readonly handlers: RealtimeHandlers,
    private readonly lookup?: (query: string) => Promise<string>,
  ) {
    this.socket = new WebSocket(
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
        setup: this.lookup
          ? {
              ...setup,
              tools: [
                {
                  functionDeclarations: [
                    {
                      name: 'search_knowledge',
                      description: 'Search the line documents and return the passages that answer the caller. Call this before every factual answer.',
                      parameters: {
                        type: 'OBJECT',
                        properties: { query: { type: 'STRING', description: 'The caller question.' } },
                        required: ['query'],
                      },
                    },
                  ],
                },
              ],
            }
          : setup,
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
      this.socket.send(JSON.stringify({ realtimeInput: { text: `Greet the caller now, in one short sentence: ${this.greeting}` } }));
    }
    if (event.toolCall?.functionCalls?.length && this.lookup) void this.answerTools(event.toolCall.functionCalls);
    if (event.serverContent?.interrupted) this.handlers.onClear();
    for (const part of event.serverContent?.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (typeof audio === 'string' && audio) this.handlers.onAudio(fromGeminiOutput(audio, this.format));
    }
  }

  private async answerTools(calls: GeminiCall[]) {
    const lookup = this.lookup;
    if (!lookup || this.socket.readyState !== WebSocket.OPEN) return;
    const functionResponses = [];
    for (const call of calls) {
      const query = typeof call.args?.query === 'string' ? call.args.query : '';
      const passages = await lookup(query).catch(() => 'No passage matches this question.');
      functionResponses.push({ id: call.id, name: call.name || 'search_knowledge', response: { passages } });
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ toolResponse: { functionResponses } }));
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
