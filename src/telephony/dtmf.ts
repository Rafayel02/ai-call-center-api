const RATE = 8000;
const WINDOW = 205;
const STEP = 160;
const LOWS = [697, 770, 852, 941];
const HIGHS = [1209, 1336, 1477, 1633];
const DIGITS = ['123A', '456B', '789C', '*0#D'];

function goertzel(samples: Int16Array, frequency: number) {
  const k = Math.round((samples.length * frequency) / RATE);
  const coefficient = 2 * Math.cos((2 * Math.PI * k) / samples.length);
  let previous = 0;
  let prior = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const next = samples[index] + coefficient * previous - prior;
    prior = previous;
    previous = next;
  }
  return previous * previous + prior * prior - coefficient * previous * prior;
}

function rowDigit(samples: Int16Array) {
  const low = LOWS.map((frequency) => goertzel(samples, frequency));
  const high = HIGHS.map((frequency) => goertzel(samples, frequency));
  const lowIndex = strongest(low);
  const highIndex = strongest(high);
  if (lowIndex < 0 || highIndex < 0) return '';
  return DIGITS[lowIndex]?.[highIndex] ?? '';
}

function strongest(powers: number[]) {
  let best = 0;
  let second = 0;
  let index = -1;
  for (let cursor = 0; cursor < powers.length; cursor += 1) {
    const power = powers[cursor] ?? 0;
    if (power > best) {
      second = best;
      best = power;
      index = cursor;
    } else if (power > second) second = power;
  }
  if (best < 1e8 || best < second * 6) return -1;
  return index;
}

/** Hears a keypad tone in the call audio when Twilio does not send a digit event. */
export class DtmfDecoder {
  private pending = new Int16Array(0);
  private held = '';
  private heldFrames = 0;
  private quietFrames = 0;
  private ready = true;

  constructor(private readonly onDigit: (digit: string) => void) {}

  push(samples: Int16Array) {
    if (samples.length === 0) return;
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    while (offset + WINDOW <= merged.length) {
      this.hear(rowDigit(merged.subarray(offset, offset + WINDOW)));
      offset += STEP;
    }
    this.pending = merged.subarray(Math.min(offset, merged.length));
  }

  private hear(digit: string) {
    if (!digit) {
      this.held = '';
      this.heldFrames = 0;
      this.quietFrames += 1;
      if (this.quietFrames >= 3) this.ready = true;
      return;
    }
    this.quietFrames = 0;
    if (digit !== this.held) {
      this.held = digit;
      this.heldFrames = 1;
      return;
    }
    this.heldFrames += 1;
    if (this.heldFrames >= 3 && this.ready && digit >= '0' && digit <= '9') {
      this.ready = false;
      this.onDigit(digit);
    }
  }
}
