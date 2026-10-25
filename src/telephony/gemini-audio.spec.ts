import assert from 'node:assert/strict';
import test from 'node:test';
import { fromGeminiOutput, resampleInt16, toGeminiInput } from './gemini-audio';
import { geminiSetup } from './gemini-realtime';

test('browser audio is resampled to the 16 kHz Gemini expects', () => {
  const input = new Int16Array(240);
  input.fill(1000);
  const output = resampleInt16(input, 24000, 16000);
  assert.equal(output.length, 160);
  assert.equal(output[0], 1000);
});

test('phone audio becomes 16 kHz PCM and Gemini audio comes back as μ-law', () => {
  const silence = Buffer.alloc(80, 0xff).toString('base64');
  const pcm = Buffer.from(toGeminiInput(silence, 'pcmu'), 'base64');
  assert.equal(pcm.length, 320);
  const spoken = Buffer.alloc(240 * 2).toString('base64');
  assert.equal(fromGeminiOutput(spoken, 'pcm'), spoken);
  assert.equal(Buffer.from(fromGeminiOutput(spoken, 'pcmu'), 'base64').length, 80);
});

test('Gemini setup asks for audio inside the generation config', () => {
  const message = geminiSetup('gemini-3.8-live', 'Stay on the menu.');
  assert.equal(message.setup.model, 'models/gemini-3.8-live');
  assert.deepEqual(message.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal('responseModalities' in message.setup, false);
});
