import assert from 'node:assert/strict';
import test from 'node:test';
import { closingPrompt, readClosingChoice } from './closing-choice';

test('a clear goodbye ends the call, and anything else keeps it open', () => {
  assert.equal(readClosingChoice({ outcome: 'done' }), 'done');
  assert.equal(readClosingChoice({ outcome: 'questions' }), 'questions');
  assert.equal(readClosingChoice({ outcome: 'maybe' }), 'questions');
  assert.equal(readClosingChoice(null), 'questions');
});

test('the prompt includes the question that was asked and the answer that was heard', () => {
  const prompt = closingPrompt('Do you have other questions?', 'Yes, about the bill');
  assert.match(prompt, /Do you have other questions\?/);
  assert.match(prompt, /Yes, about the bill/);
});
