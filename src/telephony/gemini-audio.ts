import { decodeUlaw, encodeUlawSample } from './ulaw';

export function resampleInt16(samples: Int16Array, from: number, to: number) {
  if (from === to || samples.length === 0) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const output = new Int16Array(length);
  const ratio = from / to;
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const mix = position - left;
    const start = samples[left] ?? 0;
    const end = samples[Math.min(left + 1, samples.length - 1)] ?? start;
    output[index] = Math.round(start + (end - start) * mix);
  }
  return output;
}

function int16From(payload: string) {
  const bytes = Buffer.from(payload, 'base64');
  const length = bytes.length - (bytes.length % 2);
  const samples = new Int16Array(length / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2);
  return samples;
}

function base64Of(samples: Int16Array) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

/** Browser audio is 24 kHz PCM. Phone audio is 8 kHz μ-law. Gemini Live wants 16 kHz PCM. */
export function toGeminiInput(payload: string, format: 'pcmu' | 'pcm') {
  const samples = format === 'pcmu' ? decodeUlaw(Buffer.from(payload, 'base64')) : int16From(payload);
  return base64Of(resampleInt16(samples, format === 'pcmu' ? 8000 : 24000, 16000));
}

/** Gemini speaks 24 kHz PCM. The browser plays that. The phone needs 8 kHz μ-law. */
export function fromGeminiOutput(payload: string, format: 'pcmu' | 'pcm') {
  if (format === 'pcm') return payload;
  const samples = resampleInt16(int16From(payload), 24000, 8000);
  const ulaw = Buffer.alloc(samples.length);
  for (let index = 0; index < samples.length; index += 1) ulaw[index] = encodeUlawSample(samples[index]);
  return ulaw.toString('base64');
}
