import assert from 'node:assert/strict';
import test from 'node:test';
import { speechSegments } from './speech-segments';

test('a delay line, an interrupted reply, and a caller utterance become segments in clock order', () => {
  const segments = speechSegments([
    {
      id: 'reply',
      type: 'tts.played',
      offsetMs: 2400,
      payload: { text: 'The office is downtown', kind: 'reply', endMs: 3100, interrupted: true },
    },
    {
      id: 'barge',
      type: 'barge_in',
      offsetMs: 3100,
      payload: { during: 'reply', note: 'reply_cut_off' },
    },
    {
      id: 'unused-delay',
      type: 'tts.ready',
      offsetMs: 400,
      payload: { text: 'Let me look that up', kind: 'delay' },
    },
    {
      id: 'empty',
      type: 'stt.completed',
      offsetMs: 1800,
      payload: { transcript: '   ', utteranceStartMs: 900, utteranceDurationMs: 400 },
    },
    {
      id: 'caller',
      type: 'stt.completed',
      offsetMs: 1900,
      payload: { transcript: 'Where is the office?', utteranceStartMs: 200, utteranceDurationMs: 1100 },
    },
    {
      id: 'delay',
      type: 'tts.played',
      offsetMs: 1400,
      payload: { text: 'One moment', kind: 'delay', endMs: 2100, interrupted: false },
    },
    {
      id: 'failed',
      type: 'stt.failed',
      offsetMs: 100,
      payload: { error: 'empty' },
    },
  ]);

  assert.deepEqual(segments, [
    {
      eventId: 'caller',
      speaker: 'caller',
      kind: null,
      text: 'Where is the office?',
      startMs: 200,
      endMs: 1300,
      interrupted: false,
    },
    {
      eventId: 'delay',
      speaker: 'agent',
      kind: 'delay',
      text: 'One moment',
      startMs: 1400,
      endMs: 2100,
      interrupted: false,
    },
    {
      eventId: 'reply',
      speaker: 'agent',
      kind: 'reply',
      text: 'The office is downtown',
      startMs: 2400,
      endMs: 3100,
      interrupted: true,
    },
  ]);
});

test('a generated clip that was never played is not a segment', () => {
  assert.deepEqual(
    speechSegments([
      { id: 'ready', type: 'tts.ready', offsetMs: 10, payload: { text: 'Just a moment', kind: 'delay' } },
      { id: 'step', type: 'tts.played', offsetMs: 50, payload: { text: 'Hello', kind: 'step', endMs: 90, interrupted: false } },
    ]),
    [
      {
        eventId: 'step',
        speaker: 'agent',
        kind: 'step',
        text: 'Hello',
        startMs: 50,
        endMs: 90,
        interrupted: false,
      },
    ],
  );
});
