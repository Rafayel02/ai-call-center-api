import assert from 'node:assert/strict';
import test from 'node:test';
import { speechClipKey } from './speech-clip';

const base = {
  modelId: '287b9bcf-5d7c-4434-aaac-509f02240892',
  providerModelId: 'eleven_v3',
  voiceId: 'voice-1',
  text: 'Hello',
};

test('the same model and text always map to one clip', () => {
  assert.equal(speechClipKey(base), speechClipKey({ ...base }));
});

test('an MP3 clip keeps the key it had before formats, and a phone clip gets its own', () => {
  const key = speechClipKey(base);
  assert.equal(key, '0ff76eda945336d6e98d9fcb49f7e408afe06cd6249a123799a4462f0dc4567f');
  assert.equal(speechClipKey({ ...base, format: 'mp3_44100_128' }), key);
  assert.notEqual(speechClipKey({ ...base, format: 'ulaw_8000' }), key);
});

test('a different line, voice, provider model, or saved model is a new clip', () => {
  const key = speechClipKey(base);
  assert.notEqual(key, speechClipKey({ ...base, text: 'Hello.' }));
  assert.notEqual(key, speechClipKey({ ...base, voiceId: 'voice-2' }));
  assert.notEqual(key, speechClipKey({ ...base, providerModelId: 'eleven_flash_v2_5' }));
  assert.notEqual(key, speechClipKey({ ...base, modelId: '11111111-1111-4111-8111-111111111111' }));
});
