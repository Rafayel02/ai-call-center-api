import assert from 'node:assert/strict';
import test from 'node:test';
import { learnUserMessage, pageText, readLearnedPrompt, readTranslatedPrompt, readVoicePrompts, readVoiceSources } from './voice-context';
import { isPrivateAddress } from './voice-sources';

test('a private address cannot be used as a context link', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.1.2.3'), true);
  assert.equal(isPrivateAddress('192.168.1.8'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('::1'), true);
});

test('an older single prompt is kept as the Armenian context', () => {
  const prompts = readVoicePrompts({}, 'Բաց ենք 9-ից 6-ը։');
  assert.equal(prompts.hy, 'Բաց ենք 9-ից 6-ը։');
  assert.equal(prompts.en, '');
  assert.equal(prompts.ru, '');
  assert.equal(readVoicePrompts({ en: ' Open 9 to 6. ' }, 'Բաց').en, 'Open 9 to 6.');
});

test('a page keeps its words and drops the markup', () => {
  assert.equal(pageText('<html><style>a{}</style><p>Open &amp; welcome</p><script>no</script></html>'), 'Open & welcome');
});

test('learning reads every source and keeps the English prompt', () => {
  const message = learnUserMessage(
    { hy: 'Հին', en: '', ru: '' },
    [{ id: '1', kind: 'file', name: 'hours.txt', url: null, text: '9 to 6', createdAt: '2026-10-26T00:00:00.000Z' }],
  );
  assert.match(message, /Հին/);
  assert.match(message, /hours.txt/);
  assert.match(message, /9 to 6/);
  assert.equal(readLearnedPrompt('{"en":" Open 9 to 6. "}'), 'Open 9 to 6.');
  assert.equal(readLearnedPrompt('{"prompt":"Hours"}'), 'Hours');
  assert.throws(() => readLearnedPrompt('{"hy":"Հայ"}'));
  assert.equal(readTranslatedPrompt('{"text":" Բաց ենք 9-ից 6-ը։ "}'), 'Բաց ենք 9-ից 6-ը։');
  assert.throws(() => readTranslatedPrompt('{}'));
});

test('a stored source keeps its text and drops a broken row', () => {
  const sources = readVoiceSources([
    { id: '1', kind: 'link', name: ' Site ', url: 'https://example.com', text: ' Hours ', createdAt: '2026-10-26T00:00:00.000Z' },
    { kind: 'file' },
  ]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].text, 'Hours');
  assert.equal(sources[0].name, 'Site');
});
