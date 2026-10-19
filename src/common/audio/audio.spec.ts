import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeUlaw, encodeUlaw, sampleToUlaw, ULAW_SILENCE, ulawToSample } from './ulaw';
import { ulawToWav, wavDurationMs, wavFile } from './wav';

test('μ-law matches the G.711 reference points', () => {
  assert.equal(sampleToUlaw(0), ULAW_SILENCE);
  assert.equal(ulawToSample(ULAW_SILENCE), 0);
  assert.equal(ulawToSample(0x00), -32124);
  assert.equal(ulawToSample(0x80), 32124);
  assert.equal(sampleToUlaw(32767), 0x80);
  assert.equal(sampleToUlaw(-32768), 0x00);
});

test('μ-law round trips within its quantization step', () => {
  const samples = Int16Array.from([0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000]);
  const decoded = decodeUlaw(encodeUlaw(samples));
  samples.forEach((sample, index) => {
    const error = Math.abs(decoded[index] - sample);
    assert.ok(error <= Math.max(8, Math.abs(sample) / 16), `sample ${sample} decoded as ${decoded[index]}`);
  });
});

test('a WAV file has a PCM header and the right length', () => {
  const file = wavFile(new Int16Array(8000));
  assert.equal(file.length, 44 + 16000);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt16LE(20), 1);
  assert.equal(file.readUInt32LE(24), 8000);
  assert.equal(wavDurationMs(file), 1000);
  assert.equal(wavDurationMs(ulawToWav(Buffer.alloc(4000, ULAW_SILENCE))), 500);
  assert.equal(wavDurationMs(Buffer.from('not a wav file at all, not even close to one')), null);
});
