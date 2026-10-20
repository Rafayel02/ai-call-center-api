import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DtmfDecoder } from './dtmf';
import { decodeUlaw, encodeUlawSample } from './ulaw';

function tone(low: number, high: number, ms: number) {
  const count = Math.floor((8000 * ms) / 1000);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const time = index / 8000;
    samples[index] = Math.round(9000 * (Math.sin(2 * Math.PI * low * time) + Math.sin(2 * Math.PI * high * time)));
  }
  return samples;
}

function ulawRoundTrip(samples: Int16Array) {
  const bytes = Buffer.alloc(samples.length);
  for (let index = 0; index < samples.length; index += 1) bytes[index] = encodeUlawSample(samples[index] ?? 0);
  return decodeUlaw(bytes);
}

describe('phone keypad tones', () => {
  it('hears 1 after the tone has passed through phone audio', () => {
    const heard: string[] = [];
    const decoder = new DtmfDecoder((digit) => heard.push(digit));
    decoder.push(ulawRoundTrip(tone(697, 1209, 120)));
    decoder.push(new Int16Array(800));
    assert.deepEqual(heard, ['1']);
  });

  it('ignores speech that is not a keypad tone', () => {
    const heard: string[] = [];
    const decoder = new DtmfDecoder((digit) => heard.push(digit));
    const samples = new Int16Array(1600);
    for (let index = 0; index < samples.length; index += 1) {
      const time = index / 8000;
      samples[index] = Math.round(6000 * Math.sin(2 * Math.PI * 220 * time) + 4000 * Math.sin(2 * Math.PI * 440 * time));
    }
    decoder.push(samples);
    assert.deepEqual(heard, []);
  });
});
