import { WebSocket } from 'ws';

const SILENCE = Buffer.alloc(160, 0xff);

export interface LiveTranscript {
  push(audio: Buffer): void;
  finish(): Promise<string>;
  cancel(): void;
}

export function readLiveMessage(raw: string): { type: 'partial' | 'committed' | 'ready' | 'error'; text: string } | null {
  let payload: { message_type?: unknown; text?: unknown; error?: unknown };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return null;
  }
  const type = typeof payload.message_type === 'string' ? payload.message_type : '';
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (type === 'session_started') return { type: 'ready', text: '' };
  if (type === 'partial_transcript') return { type: 'partial', text };
  if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') return { type: 'committed', text };
  if (type.includes('error') || type.includes('Error')) return { type: 'error', text: typeof payload.error === 'string' ? payload.error : type };
  return null;
}

/** Streams μ-law to ElevenLabs while the caller is still talking. */
export class ElevenLabsLiveTranscript implements LiveTranscript {
  private readonly socket: WebSocket;
  private readonly pending: Buffer[] = [];
  private readonly committed: string[] = [];
  private ready = false;
  private partial = '';
  private settled = false;
  private failed: string | null = null;
  private finishWait: ((text: string) => void) | null = null;
  private failWait: ((error: Error) => void) | null = null;

  constructor(apiKey: string, languageCode: string | null) {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'ulaw_8000',
      commit_strategy: 'manual',
    });
    if (languageCode) params.set('language_code', languageCode);
    this.socket = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${params.toString()}`, {
      headers: { 'xi-api-key': apiKey },
    });
    this.socket.on('open', () => undefined);
    this.socket.on('message', (data) => this.take(data.toString()));
    this.socket.on('error', () => this.fail(new Error('Could not stream speech to ElevenLabs.')));
    this.socket.on('close', () => {
      if (!this.settled) this.fail(new Error('ElevenLabs closed the live transcript.'));
    });
  }

  push(audio: Buffer) {
    if (!audio.length || this.settled) return;
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) {
      this.pending.push(audio);
      return;
    }
    this.send(audio, false);
  }

  finish() {
    if (this.settled) return Promise.resolve(this.committed.join(' ').trim() || this.partial.trim());
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const text = this.committed.join(' ').trim() || this.partial.trim();
        this.settled = true;
        this.finishWait = null;
        this.failWait = null;
        this.socket.close();
        if (text) resolve(text);
        else reject(new Error('The live transcript was not ready.'));
      }, 2500);
      this.finishWait = (text) => {
        clearTimeout(timer);
        resolve(text);
      };
      this.failWait = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      if (this.ready) this.commit();
    });
  }

  cancel() {
    this.settled = true;
    this.finishWait = null;
    this.failWait = null;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }

  private take(raw: string) {
    const message = readLiveMessage(raw);
    if (!message || this.settled) return;
    if (message.type === 'error') {
      this.fail(new Error(message.text || 'ElevenLabs could not transcribe the call.'));
      return;
    }
    if (message.type === 'ready') {
      this.ready = true;
      const queued = this.pending.splice(0);
      for (const audio of queued) this.send(audio, false);
      if (this.finishWait) this.commit();
      return;
    }
    if (message.type === 'partial') this.partial = message.text;
    if (message.type === 'committed') {
      if (message.text.trim()) this.committed.push(message.text.trim());
      if (this.finishWait) {
        this.settled = true;
        const wait = this.finishWait;
        this.finishWait = null;
        this.failWait = null;
        this.socket.close();
        wait(this.committed.join(' ').trim());
      }
    }
  }

  private commit() {
    if (this.socket.readyState !== WebSocket.OPEN) {
      this.fail(new Error('The live transcript was not connected.'));
      return;
    }
    const queued = this.pending.splice(0);
    for (const audio of queued) this.send(audio, false);
    this.send(SILENCE, true);
  }

  private send(audio: Buffer, commit: boolean) {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: audio.toString('base64'),
        commit,
        sample_rate: 8000,
      }),
    );
  }

  private fail(error: Error) {
    if (this.settled) return;
    this.settled = true;
    const wait = this.failWait;
    this.finishWait = null;
    this.failWait = null;
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
    wait?.(error);
  }
}
