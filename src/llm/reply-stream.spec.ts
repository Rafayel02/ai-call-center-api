import assert from 'node:assert/strict';
import test from 'node:test';
import { ReplyAssembler } from './reply-stream';

test('a streaming reply speaks each finished sentence before the JSON ends', () => {
  const assembler = new ReplyAssembler();
  const chunks = ['{"reply":"One moment. How can I', ' help?","inquiry":null,"phase":"clarify"}'];
  const first = assembler.push(chunks[0]);
  assert.deepEqual(first, ['One moment.']);
  const rest = assembler.push(chunks[1]);
  assert.deepEqual(rest, ['How can I help?']);
});

test('an Armenian sentence boundary is spoken as its own line', () => {
  const assembler = new ReplyAssembler();
  const spoken = assembler.push('{"reply":"Մեկ րոպե։ Ինչպե՞ս կարող եմ օգնել։","inquiry":null}');
  assert.deepEqual(spoken, ['Մեկ րոպե։', 'Ինչպե՞ս կարող եմ օգնել։']);
});
