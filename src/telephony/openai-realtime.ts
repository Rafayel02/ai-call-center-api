import { WebSocket } from 'ws';

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
  private turn = 0;
  private answering: number | null = null;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`, {
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
            input: {
              format: audioFormat,
              ...(this.lookup ? { transcription: { model: 'gpt-4o-mini-transcribe' } } : {}),
              turn_detection: this.lookup ? { type: 'server_vad', create_response: false } : { type: 'server_vad' },
            },
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
      this.turn += 1;
      if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
      this.handlers.onClear();
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    if (event.type === 'input_audio_buffer.speech_stopped' && this.lookup) {
      const turn = this.turn;
      if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
      this.transcriptTimer = setTimeout(() => {
        if (turn === this.turn) void this.answer(turn, '');
      }, 2500);
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && this.lookup) {
      const transcript = typeof (event as { transcript?: unknown }).transcript === 'string' ? (event as { transcript: string }).transcript : '';
      void this.answer(this.turn, transcript);
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

  private async answer(turn: number, transcript: string) {
    if (!this.lookup || turn !== this.turn || this.answering === turn || this.socket.readyState !== WebSocket.OPEN) return;
    this.answering = turn;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    const passages = await this.lookup(transcript).catch(() => 'No passage matches this question.');
    if (this.turn !== turn || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        type: 'response.create',
        response: {
          instructions: [
            this.instructions,
            `Passages from the documents:\n${passages}`,
            transcript.trim() ? `The caller said: ${transcript.trim()}` : 'The caller was unclear.',
            'Answer now in one or two short sentences. Use only the passages.',
          ].join('\n\n'),
        },
      }),
    );
  }

  private stop(ready: boolean) {
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    if (this.settled) return;
    this.settled = true;
    this.finish?.(ready);
    this.finish = null;
  }
}
