import assert from 'node:assert/strict';
import test from 'node:test';
import { inquirySystemPrompt, readInquiryTurn } from './inquiry-turn';

test('confirmation without an inquiry is rejected', () => {
  assert.throws(() => readInquiryTurn({ reply: 'So you want that?', inquiry: '  ', phase: 'confirm' }), /did not name the inquiry/);
});

test('an empty confirmation question states the inquiry', () => {
  assert.deepEqual(readInquiryTurn({ reply: '  ', inquiry: 'move the appointment to 3', phase: 'confirm' }), {
    reply: 'So you want move the appointment to 3?',
    inquiry: 'move the appointment to 3',
    phase: 'confirm',
  });
});

test('accepted is kept only with an inquiry', () => {
  const turn = readInquiryTurn({ reply: 'Okay.', inquiry: 'a refund for order 12', phase: 'accepted' });
  assert.equal(turn.phase, 'accepted');
  assert.equal(turn.inquiry, 'a refund for order 12');
});

test('the system prompt includes the interruption note and the confirmation rule', () => {
  const prompt = inquirySystemPrompt('Find the booking they mean.', 'The caller spoke again before you answered.');
  assert.match(prompt, /Find the booking they mean/);
  assert.match(prompt, /So you want/);
  assert.match(prompt, /accepted/);
  assert.match(prompt, /The caller spoke again before you answered/);
});
