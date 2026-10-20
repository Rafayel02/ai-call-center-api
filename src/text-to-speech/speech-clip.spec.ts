import assert from 'node:assert/strict';
import test from 'node:test';
import { reusedSpeechPayload, speechClipKey, speechWasReused } from './speech-clip';

const base = {
  modelId: '287b9bcf-5d7c-4434-aaac-509f02240892',
  providerModelId: 'eleven_v3',
  voiceId: 'voice-1',
  text: 'Hello',
};

test('the same model and text always map to one clip', () => {
  assert.equal(speechClipKey(base), speechClipKey({ ...base }));
});

test('a later play of a saved line costs nothing, and the play that saved it keeps the cost', () => {
  const saved = new Date('2026-10-20T12:00:00.000Z');
  const again = new Date(saved.getTime() + 10_001);
  const first = new Date(saved.getTime() + 500);
  assert.equal(speechWasReused(again, saved), true);
  assert.equal(speechWasReused(first, saved), false);
  assert.deepEqual(reusedSpeechPayload({ text: 'Hello' }, again, saved), { text: 'Hello', cached: true });
  assert.equal(reusedSpeechPayload({ text: 'Hello', cached: true }, again, saved), null);
  assert.equal(reusedSpeechPayload({ text: 'Hello' }, first, saved), null);
});

test('a different line, voice, provider model, or saved model is a new clip', () => {
  const key = speechClipKey(base);
  assert.notEqual(key, speechClipKey({ ...base, text: 'Hello.' }));
  assert.notEqual(key, speechClipKey({ ...base, voiceId: 'voice-2' }));
  assert.notEqual(key, speechClipKey({ ...base, providerModelId: 'eleven_flash_v2_5' }));
  assert.notEqual(key, speechClipKey({ ...base, modelId: '11111111-1111-4111-8111-111111111111' }));
});
