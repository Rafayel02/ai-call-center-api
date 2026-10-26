import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkText, decodeVector, encodeVector, knowledgeGuide, searchPassages } from './knowledge';

test('passages cover the start and the end of a page', () => {
  const text = `${'alpha '.repeat(400)} ENDING FACT 9900`;
  const chunks = chunkText(text, 500, 80);
  assert.ok(chunks.length > 2);
  assert.match(chunks[0], /alpha/);
  assert.match(chunks[chunks.length - 1], /ENDING FACT 9900/);
  assert.equal(chunkText('  Be Free is 3500 AMD.  ').join(''), 'Be Free is 3500 AMD.');
});

test('search returns the passage closest to the question', () => {
  const price = encodeVector([1, 0]);
  const hours = encodeVector([0, 1]);
  const found = searchPassages(decodeVector(price), [
    { sourceName: 'hours', text: 'Open 9 to 6', vector: decodeVector(hours) },
    { sourceName: 'plans', text: 'Be Free is 3500 AMD', vector: decodeVector(price) },
  ]);
  assert.match(found, /Be Free is 3500 AMD/);
  assert.doesNotMatch(found, /Open 9 to 6/);
  assert.match(knowledgeGuide([' Plans ', 'Plans']), /Documents: Plans/);
});
