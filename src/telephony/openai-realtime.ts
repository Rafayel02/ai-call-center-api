import { WebSocket } from 'ws';
import { RealtimeTools, readToolArgs, runVoiceTool } from './realtime-tools';

interface RealtimeHandlers {
  onAudio: (payload: string) => void;
  onClear: () => void;
  onError?: (message: string) => void;
  onReady?: () => void;
  onFinished?: () => void;
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
  private readonly toolCalls = new Set<string>();
  private toolsBusy = false;
  private toolQueue: Promise<void> = Promise.resolve();
  private responseActive = false;
  private responsePending = false;
  private finish: ((ready: boolean) => void) | null = null;

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly format: 'pcmu' | 'pcm',
    private readonly instructions: string,
    private readonly greeting: string,
    private readonly handlers: RealtimeHandlers,
    private readonly tools?: RealtimeTools,
    socketFactory: (url: string, options: { headers: Record<string, string> }) => WebSocket = (url, options) => new WebSocket(url, options),
  ) {
    this.socket = socketFactory(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`, {
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
              turn_detection: { type: 'server_vad' },
            },
            output: { format: audioFormat, voice: 'marin' },
          },
          instructions: this.instructions,
          ...(this.tools ? { tools: this.tools.definitions.map((tool) => ({ type: 'function', ...tool })), tool_choice: 'auto' } : {}),
        },
      }),
    );
  }

  private take(raw: string) {
    let event: { type?: string; delta?: unknown; response?: { status?: string; output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }> }; error?: { message?: unknown } };
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
          response: { instructions: `${this.instructions}\n\nBegin at the current step. If it is a speech step, say its line then advance. Otherwise greet briefly in the selected language: ${this.greeting}` },
        }),
      );
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      this.turn += 1;
      this.responsePending = false;
      this.handlers.onClear();
      if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'response.cancel' }));
    }
    if (event.type === 'response.created') this.responseActive = true;
    if (event.type === 'response.done') {
      this.responseActive = false;
      if (event.response?.status === 'completed' && this.tools) {
        const calls = (event.response.output ?? []).filter((item) => item.type === 'function_call' && item.call_id && item.name);
        if (calls.length) {
          this.toolsBusy = true;
          const callTurn = this.turn;
          this.toolQueue = this.toolQueue.then(() => this.answerTools(calls, callTurn)).catch(() => this.handlers.onError?.('The voice operation failed.'));
        }
      }
      if (event.response?.status === 'completed' && this.tools?.finished?.() && event.response.output?.some((item) => item.type === 'message')) {
        this.handlers.onFinished?.();
        this.close();
      }
      this.flushResponse();
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

  private async answerTools(calls: Array<{ call_id?: string; name?: string; arguments?: string }>, turn: number) {
    const tools = this.tools;
    if (!tools) return;
    let outputs = 0;
    this.toolsBusy = true;
    try {
      for (const call of calls) {
        if (!call.call_id || !call.name || this.toolCalls.has(call.call_id)) continue;
        if (this.toolCalls.size >= 500) { this.handlers.onError?.('The call reached its tool limit.'); this.close(); return; }
        this.toolCalls.add(call.call_id);
        let output: unknown;
        try {
          output = turn === this.turn ? await runVoiceTool(tools, call.name, readToolArgs(call.arguments ?? '{}')) : { status: 'interrupted', message: 'The caller has started a new turn. Re-evaluate their request.' };
        } catch {
          output = { status: 'invalid_arguments', message: 'Provide valid JSON arguments.' };
        }
        if (this.settled || this.socket.readyState !== WebSocket.OPEN) return;
        outputs += 1;
        this.socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) } }));
      }
      // Keep the result in history, but never start a stale answer over a new caller turn.
      if (outputs && turn === this.turn) this.responsePending = true;
    } finally {
      this.toolsBusy = false;
      this.flushResponse();
    }
  }

  private flushResponse() {
    if (!this.responsePending || this.responseActive || this.toolsBusy || this.socket.readyState !== WebSocket.OPEN) return;
    this.responsePending = false;
    this.responseActive = true;
    this.socket.send(JSON.stringify({ type: 'response.create' }));
  }

  private stop(ready: boolean) {
    if (this.settled) return;
    this.settled = true;
    this.finish?.(ready);
    this.finish = null;
  }
}
