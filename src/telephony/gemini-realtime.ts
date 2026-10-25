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

interface GeminiMessage {
  setupComplete?: unknown;
  error?: { message?: unknown };
  serverContent?: {
    interrupted?: unknown;
    modelTurn?: { parts?: GeminiPart[] };
  };
}

/** Speech-to-speech session on Gemini Live. The caller still sends the existing phone or browser audio. */
export class GeminiRealtime {
  readonly done: Promise<boolean>;
  private readonly socket: WebSocket;
  private readonly pending: string[] = [];
  private greeted = false;
  private ready = false;
  private settled = false;
  private finish: ((ready: boolean) => void) | null = null;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly format: 'pcmu' | 'pcm',
    private readonly instructions: string,
    private readonly greeting: string,
    private readonly handlers: RealtimeHandlers,
  ) {
    this.socket = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`,
    );
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.socket.on('open', () => this.configure());
    this.socket.on('message', (data) => this.take(data.toString()));
    this.socket.on('error', () => this.handlers.onError?.('Could not reach Gemini.'));
    this.socket.on('close', () => this.stop(this.ready));
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
    this.socket.send(
      JSON.stringify({
        setup: {
          model: `models/${this.model}`,
          responseModalities: ['AUDIO'],
          systemInstruction: { parts: [{ text: this.instructions }] },
        },
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
      this.handlers.onError?.(message || 'Gemini could not continue the call.');
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
    if (event.serverContent?.interrupted) this.handlers.onClear();
    for (const part of event.serverContent?.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (typeof audio === 'string' && audio) this.handlers.onAudio(fromGeminiOutput(audio, this.format));
    }
  }

  private stop(ready: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.finish?.(ready);
    this.finish = null;
  }
}
