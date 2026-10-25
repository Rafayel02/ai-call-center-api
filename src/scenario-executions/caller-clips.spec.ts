import assert from 'node:assert/strict';
import test from 'node:test';
import { callerClips } from './caller-clips';

test('only stored caller audio with a transcript can be replayed', () => {
  const startedAt = new Date('2026-10-25T12:00:00.000Z');
  const items = callerClips([
    { id: 'spoken', executionId: 'exec-1', audioId: 'audio-1', payload: { transcript: ' What time do you close? ' }, startedAt },
    { id: 'blank', executionId: 'exec-1', audioId: 'audio-2', payload: { transcript: '   ' }, startedAt },
    { id: 'missing-audio', executionId: 'exec-1', audioId: null, payload: { transcript: 'Hello' }, startedAt },
    { id: 'agent', executionId: 'exec-1', audioId: 'audio-3', payload: { text: 'We close at six' }, startedAt },
  ]);
  assert.deepEqual(items, [
    {
      id: 'spoken',
      executionId: 'exec-1',
      startedAt: '2026-10-25T12:00:00.000Z',
      text: 'What time do you close?',
      audioUrl: '/scenario-executions/exec-1/audio/audio-1',
    },
  ]);
});
