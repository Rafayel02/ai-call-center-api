import { WebSocket } from 'ws';

const MODEL = 'gpt-realtime';

interface RealtimeHandlers {
  onAudio: (payload: string) => void;
  onClear: () => void;
    onError?: (message: string) => void;
    onReady?: () => void;
  }

/** One speech-to-speech session. Audio goes in and comes back without a separate transcript or voice model. */
export class OpenAiRealtime {
  readonly done: Promise<boolean>;
  private readonly socket: WebSocket;
  private readonly pending: string[] = [];
  private greeted = false;
  private ready = false;
  private settled = false;
  private finish: ((ready: boolean) => void) | null = null;

  constructor(
    apiKey: string,
    private readonly format: 'pcmu' | 'pcm',
    private readonly instructions: string,
    private readonly greeting: string,
    private readonly handlers: RealtimeHandlers,
  ) {
    this.socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.socket.on('open', () => {
      this.configure();
      const queued = this.pending.splice(0);
      for (const audio of queued) this.sendAudio(audio);
    });
    this.socket.on('message', (data) => this.take(data.toString()));
    this.socket.on('error', () => this.handlers.onError?.('Could not reach OpenAI.'));
    this.socket.on('close', () => this.stop(this.ready));
  }

  sendAudio(audio: string) {
    if (!audio) return;
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.pending.push(audio);
      if (this.pending.length > 200) this.pending.shift();
      return;
    }
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio }));
  }

  close() {
    this.stop(this.ready);
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  private configure() {
    const audioFormat = this.format === 'pcmu' ? { type: 'audio/pcmu' } : { type: 'audio/pcm', rate: 24000 };
    this.socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: {
            input: { format: audioFormat, turn_detection: { type: 'server_vad' } },
            output: { format: audioFormat, voice: 'marin' },
          },
          instructions: this.instructions,
        },
      }),
    );
  }

  private take(raw: string) {
    let event: { type?: string; delta?: unknown; error?: { message?: unknown } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      return;
    }
    if (event.type === 'session.updated' && !this.greeted) {
      this.greeted = true;
      this.ready = true;
      this.handlers.onReady?.();
      this.socket.send(
        JSON.stringify({
          type: 'response.create',
          response: { instructions: `Greet the caller now, in one short sentence: ${this.greeting}` },
        }),
      );
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.handlers.onClear();
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    if ((event.type === 'response.output_audio.delta' || event.type === 'response.audio.delta') && typeof event.delta === 'string' && event.delta) {
      this.handlers.onAudio(event.delta);
    }
    if (event.type === 'error') {
      const message = typeof event.error?.message === 'string' ? event.error.message : '';
      if (/no active response|cancellation failed/i.test(message)) return;
      this.handlers.onError?.(message || 'OpenAI could not continue the call.');
    }
  }

  private stop(ready: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.finish?.(ready);
    this.finish = null;
  }
}
