import { pcmWav } from './ulaw';

const RATE = 8000;
const MAX_SAMPLES = RATE * 60 * 12;
const PEAKS = 240;

/** Caller and agent audio for one phone call, placed on one clock. */
export class CallRecording {
  private caller = new Int16Array(0);
  private agent = new Int16Array(0);
  private end = 0;
  private callerCursor = 0;
  private readonly started: number;

  constructor(private readonly clock: () => number = Date.now) {
    this.started = this.clock();
  }

  elapsedMs() {
    return Math.max(0, this.clock() - this.started);
  }

  addCaller(samples: Int16Array) {
    const now = this.sampleNow();
    if (now > this.callerCursor) this.callerCursor = now;
    this.write('caller', this.callerCursor, samples);
    this.callerCursor += samples.length;
  }

  addAgent(samples: Int16Array) {
    this.write('agent', this.sampleNow(), samples);
  }

  mix() {
    const total = Math.max(this.end, 1);
    const mixed = new Int16Array(total);
    for (let index = 0; index < total; index += 1) {
      const sum = (index < this.caller.length ? this.caller[index] : 0) + (index < this.agent.length ? this.agent[index] : 0);
      mixed[index] = Math.max(-32768, Math.min(32767, sum));
    }
    return { wav: pcmWav(mixed), peaks: peaks(mixed), durationMs: Math.round((total / RATE) * 1000) };
  }

  private sampleNow() {
    return Math.min(Math.floor((this.elapsedMs() * RATE) / 1000), MAX_SAMPLES - 1);
  }

  private write(track: 'caller' | 'agent', index: number, samples: Int16Array) {
    if (samples.length === 0) return;
    const count = Math.min(samples.length, MAX_SAMPLES - index);
    if (count <= 0) return;
    this.grow(track, index + count);
    this[track].set(samples.subarray(0, count), index);
    this.end = Math.max(this.end, index + count);
  }

  private grow(track: 'caller' | 'agent', length: number) {
    if (this[track].length >= length) return;
    let next = Math.max(this[track].length, 160);
    while (next < length) next *= 2;
    const grown = new Int16Array(Math.min(next, MAX_SAMPLES));
    grown.set(this[track].subarray(0, grown.length));
    this[track] = grown;
  }
}

function peaks(samples: Int16Array) {
  const buckets = new Array<number>(PEAKS).fill(0);
  const size = Math.max(1, Math.ceil(samples.length / PEAKS));
  for (let index = 0; index < samples.length; index += 1) {
    const bucket = Math.min(PEAKS - 1, Math.floor(index / size));
    buckets[bucket] = Math.max(buckets[bucket], Math.abs(samples[index]) / 32768);
  }
  return buckets;
}
