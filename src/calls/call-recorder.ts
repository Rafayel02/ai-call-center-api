import { decodeUlaw } from '../common/audio/ulaw';
import { wavFile } from '../common/audio/wav';
import { SAMPLE_RATE } from './call-timing';

const PEAKS = 240;
const SAMPLES_PER_MS = SAMPLE_RATE / 1000;

interface Placed {
  startMs: number;
  samples: Int16Array;
  /** Where `clear` cut it off. Null when it played to the end. */
  cutMs: number | null;
}

/**
 * Builds the caller track and the mix on the call clock. Both start at t = 0, so a time in the file is a time on the
 * clock. Inbound audio is laid down frame after frame from when the stream started. Outbound audio sits where it
 * started playing, cut off where `clear` stopped it.
 */
export class CallRecorder {
  private inbound: Int16Array[] = [];
  private inboundSamples = 0;
  private inboundStartMs: number | null = null;
  private outbound: Placed[] = [];

  /** One inbound payload, decoded. Returns the clock time it starts at, which is where the ear should place it. */
  hear(ulaw: Uint8Array, atMs: number): { samples: Int16Array; atMs: number } {
    if (this.inboundStartMs === null) this.inboundStartMs = Math.max(0, atMs);
    const samples = decodeUlaw(ulaw);
    const startsAt = this.inboundStartMs + this.inboundSamples / SAMPLES_PER_MS;
    this.inbound.push(samples);
    this.inboundSamples += samples.length;
    return { samples, atMs: startsAt };
  }

  /** Audio sent to the caller, starting at `startMs`. Returns a handle for `cut`. */
  speak(ulaw: Uint8Array, startMs: number): Placed {
    const placed: Placed = { startMs: Math.max(0, startMs), samples: decodeUlaw(ulaw), cutMs: null };
    this.outbound.push(placed);
    return placed;
  }

  cut(placed: Placed, atMs: number) {
    placed.cutMs = Math.max(placed.startMs, atMs);
  }

  build(endMs: number) {
    const total = Math.max(0, Math.round(endMs * SAMPLES_PER_MS));
    const caller = new Int16Array(total);
    let offset = Math.round((this.inboundStartMs ?? 0) * SAMPLES_PER_MS);
    for (const chunk of this.inbound) {
      if (offset >= total) break;
      caller.set(chunk.subarray(0, total - offset), offset);
      offset += chunk.length;
    }

    const mixed = Int32Array.from(caller);
    for (const placed of this.outbound) {
      const from = Math.round(placed.startMs * SAMPLES_PER_MS);
      const until = placed.cutMs === null ? from + placed.samples.length : Math.min(from + placed.samples.length, Math.round(placed.cutMs * SAMPLES_PER_MS));
      for (let index = from; index < Math.min(until, total); index += 1) mixed[index] += placed.samples[index - from];
    }
    const mix = new Int16Array(total);
    for (let index = 0; index < total; index += 1) mix[index] = Math.max(-32768, Math.min(32767, mixed[index]));

    return { caller: wavFile(caller), mix: wavFile(mix), peaks: peaksOf(mix) };
  }
}

function peaksOf(samples: Int16Array) {
  const peaks = new Array<number>(PEAKS).fill(0);
  if (samples.length === 0) return peaks;
  const size = Math.max(1, Math.floor(samples.length / PEAKS));
  for (let bucket = 0; bucket < PEAKS; bucket += 1) {
    const start = bucket * size;
    const end = bucket === PEAKS - 1 ? samples.length : Math.min(samples.length, start + size);
    let peak = 0;
    for (let index = start; index < end; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
    peaks[bucket] = Math.min(1, peak / 32768);
  }
  return peaks;
}
