import assert from 'node:assert/strict';
import test from 'node:test';
import { FRAME_MS, FRAME_SAMPLES } from './call-timing';
import { Ear, EarEvent } from './ear';

const loudFrame = () => Int16Array.from({ length: FRAME_SAMPLES }, (_, index) => (index % 2 ? 3000 : -3000));
const quietFrame = () => new Int16Array(FRAME_SAMPLES);

function feed(ear: Ear, frames: Int16Array[], startMs = 0) {
  const events: Array<EarEvent & { atMs: number }> = [];
  frames.forEach((frame, index) => {
    const atMs = startMs + index * FRAME_MS;
    const event = ear.hear(frame, atMs);
    if (event) events.push({ ...event, atMs });
  });
  return events;
}

test('speech is confirmed after 320 ms and ends after the silence', () => {
  const ear = new Ear(1000);
  const frames = [...Array.from({ length: 30 }, loudFrame), ...Array.from({ length: 50 }, quietFrame)];
  const events = feed(ear, frames, 1000);
  assert.deepEqual(
    events.map((event) => [event.type, event.atMs]),
    [
      ['speech', 1000 + 15 * FRAME_MS],
      ['utterance', 1000 + 79 * FRAME_MS],
    ],
  );
  const utterance = events[1];
  assert.equal(utterance.type, 'utterance');
  if (utterance.type !== 'utterance') return;
  assert.equal(utterance.startedMs, 1000);
  assert.equal(utterance.durationMs, 80 * FRAME_MS);
  assert.equal(utterance.samples.length, 80 * FRAME_SAMPLES);
  assert.equal(ear.phase, 'idle');
});

test('a short blip is dropped and a pause shorter than the silence keeps the utterance going', () => {
  const blip = new Ear(1000);
  assert.deepEqual(
    feed(blip, [...Array.from({ length: 5 }, loudFrame), ...Array.from({ length: 13 }, quietFrame)]).map((event) => event.type),
    ['discarded'],
  );

  const ear = new Ear(500);
  const frames = [
    ...Array.from({ length: 20 }, loudFrame),
    ...Array.from({ length: 20 }, quietFrame),
    ...Array.from({ length: 10 }, loudFrame),
    ...Array.from({ length: 25 }, quietFrame),
  ];
  assert.deepEqual(
    feed(ear, frames).map((event) => event.type),
    ['speech', 'utterance'],
  );
});

test('unconfirmed audio can be dropped on purpose', () => {
  const ear = new Ear(1000);
  feed(ear, Array.from({ length: 5 }, loudFrame));
  assert.equal(ear.phase, 'arming');
  ear.discardUnconfirmed();
  assert.equal(ear.phase, 'idle');
});
