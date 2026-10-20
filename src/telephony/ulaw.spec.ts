import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeUlawSample, encodeUlawSample, pcmWav } from './ulaw';

describe('ulaw', () => {
  it('round-trips a spoken sample close to the original', () => {
    const sample = 8000;
    const decoded = decodeUlawSample(encodeUlawSample(sample));
    assert.ok(Math.abs(decoded - sample) < 400);
  });

  it('writes a wav header for 8 kHz mono audio', () => {
    const wav = pcmWav(new Int16Array([1, -1]), 8000);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), 8000);
    assert.equal(wav.readUInt32LE(40), 4);
  });
});
