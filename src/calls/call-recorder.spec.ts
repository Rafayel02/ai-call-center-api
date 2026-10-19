import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeUlaw } from '../common/audio/ulaw';
import { CallRecorder } from './call-recorder';

const tone = (ms: number, level: number) => encodeUlaw(new Int16Array(ms * 8).fill(level));

function samplesOf(wav: Buffer) {
  return new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
}

test('outbound audio sits where it played and stops where clear cut it', () => {
  const recorder = new CallRecorder();
  const placed = recorder.speak(tone(500, 8000), 100);
  recorder.cut(placed, 300);
  const { mix, caller } = recorder.build(1000);
  const samples = samplesOf(mix);
  assert.equal(samples.length, 8000);
  assert.equal(samples[99 * 8], 0, 'silent before the line starts');
  assert.ok(Math.abs(samples[200 * 8]) > 7000, 'audible while it plays');
  assert.equal(samples[301 * 8], 0, 'silent after the cut');
  assert.ok(samplesOf(caller).every((sample) => sample === 0), 'the caller track has no agent audio');
});

test('inbound frames are laid down one after another from the first one', () => {
  const recorder = new CallRecorder();
  const first = recorder.hear(tone(20, 4000), 250);
  const second = recorder.hear(tone(20, 4000), 250);
  assert.equal(first.atMs, 250);
  assert.equal(second.atMs, 270);
  const samples = samplesOf(recorder.build(400).caller);
  assert.equal(samples[249 * 8], 0);
  assert.ok(Math.abs(samples[260 * 8]) > 3000);
  assert.ok(Math.abs(samples[285 * 8]) > 3000);
  assert.equal(samples[291 * 8], 0);
});
