import { decodeUlaw } from './ulaw';

/** A mono 16-bit PCM WAV file. Calls use 8 kHz. */
export function wavFile(samples: Int16Array, sampleRate = 8000): Buffer {
  const dataBytes = samples.length * 2;
  const file = Buffer.alloc(44 + dataBytes);
  file.write('RIFF', 0, 'ascii');
  file.writeUInt32LE(36 + dataBytes, 4);
  file.write('WAVE', 8, 'ascii');
  file.write('fmt ', 12, 'ascii');
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(sampleRate * 2, 28);
  file.writeUInt16LE(2, 32);
  file.writeUInt16LE(16, 34);
  file.write('data', 36, 'ascii');
  file.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) file.writeInt16LE(samples[index], 44 + index * 2);
  return file;
}

export function ulawToWav(bytes: Uint8Array): Buffer {
  return wavFile(decodeUlaw(bytes));
}

/** The length of a WAV file built by `wavFile`, read from its header. Null when the header is not one. */
export function wavDurationMs(file: Uint8Array): number | null {
  const buffer = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  const byteRate = buffer.readUInt32LE(28);
  const dataBytes = buffer.readUInt32LE(40);
  if (!byteRate) return null;
  return Math.round((dataBytes * 1000) / byteRate);
}
