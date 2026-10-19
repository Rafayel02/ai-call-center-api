import { BLIP_MS, SAMPLE_RATE, SPEECH_HOLD_MS, SPEECH_RMS } from './call-timing';

export interface Utterance {
  samples: Int16Array;
  /** Clock time of the first frame kept. */
  startedMs: number;
  durationMs: number;
}

export type EarEvent = { type: 'speech' } | { type: 'discarded' } | ({ type: 'utterance' } & Utterance);

export type EarPhase = 'idle' | 'arming' | 'speaking';

function loud(frame: Int16Array) {
  if (frame.length === 0) return false;
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const value = frame[index] / 32768;
    sum += value * value;
  }
  return Math.sqrt(sum / frame.length) >= SPEECH_RMS;
}

/**
 * Speech detection on decoded frames, with the browser loop's rules. The first loud frame starts keeping audio
 * (arming). Speech is confirmed after SPEECH_HOLD_MS of loud frames, or dropped after BLIP_MS of quiet. Confirmed
 * speech becomes an utterance after `silenceMs` of quiet.
 */
export class Ear {
  private state: EarPhase = 'idle';
  private speechMs = 0;
  private quietMs = 0;
  private frames: Int16Array[] = [];
  private startedMs = 0;

  constructor(private readonly silenceMs: number) {}

  get phase(): EarPhase {
    return this.state;
  }

  /** Feeds one frame that started at `atMs` on the call clock. */
  hear(frame: Int16Array, atMs: number): EarEvent | null {
    const dt = (frame.length * 1000) / SAMPLE_RATE;
    const speaking = loud(frame);

    if (this.state === 'idle') {
      if (!speaking) return null;
      this.state = 'arming';
      this.frames = [frame];
      this.startedMs = atMs;
      this.speechMs = dt;
      this.quietMs = 0;
      return null;
    }

    this.frames.push(frame);
    if (this.state === 'arming') {
      if (speaking) {
        this.quietMs = 0;
        this.speechMs += dt;
        if (this.speechMs >= SPEECH_HOLD_MS) {
          this.state = 'speaking';
          return { type: 'speech' };
        }
      } else if ((this.quietMs += dt) >= BLIP_MS) {
        this.reset();
        return { type: 'discarded' };
      }
      return null;
    }

    if (speaking) {
      this.quietMs = 0;
      return null;
    }
    this.quietMs += dt;
    if (this.quietMs < this.silenceMs) return null;
    const utterance: EarEvent = {
      type: 'utterance',
      samples: concat(this.frames),
      startedMs: this.startedMs,
      durationMs: Math.round(atMs + dt - this.startedMs),
    };
    this.reset();
    return utterance;
  }

  /** Drops audio that has not been confirmed as speech yet. */
  discardUnconfirmed() {
    if (this.state === 'arming') this.reset();
  }

  reset() {
    this.state = 'idle';
    this.speechMs = 0;
    this.quietMs = 0;
    this.frames = [];
  }
}

function concat(frames: Int16Array[]) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}
