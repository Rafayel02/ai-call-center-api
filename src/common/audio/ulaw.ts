// G.711 μ-law, the audio format of every call transport.

const BIAS = 0x84;
const CLIP = 32635;

const DECODED = new Int16Array(256);
for (let byte = 0; byte < 256; byte += 1) {
  const inverted = ~byte & 0xff;
  const exponent = (inverted >> 4) & 0x07;
  const magnitude = ((((inverted & 0x0f) << 3) + BIAS) << exponent) - BIAS;
  DECODED[byte] = inverted & 0x80 ? -magnitude : magnitude;
}

export function ulawToSample(byte: number): number {
  return DECODED[byte & 0xff];
}

export function sampleToUlaw(sample: number): number {
  let value = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = value < 0 ? 0x80 : 0;
  if (sign) value = -value;
  value = Math.min(value, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function decodeUlaw(bytes: Uint8Array): Int16Array {
  const samples = new Int16Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) samples[index] = DECODED[bytes[index]];
  return samples;
}

export function encodeUlaw(samples: Int16Array): Buffer {
  const bytes = Buffer.alloc(samples.length);
  for (let index = 0; index < samples.length; index += 1) bytes[index] = sampleToUlaw(samples[index]);
  return bytes;
}

/** The μ-law byte for silence. */
export const ULAW_SILENCE = 0xff;
