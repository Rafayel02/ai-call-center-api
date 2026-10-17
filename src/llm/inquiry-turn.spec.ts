import assert from 'node:assert/strict';
import test from 'node:test';
import { inquirySystemPrompt, readInquiryTurn, withoutVerification } from './inquiry-turn';

test('confirmation without an inquiry is rejected', () => {
  assert.throws(() => readInquiryTurn({ reply: 'So you want that?', inquiry: '  ', phase: 'confirm' }), /did not name the inquiry/);
});

test('an empty confirmation question states the inquiry', () => {
  assert.deepEqual(readInquiryTurn({ reply: '  ', inquiry: 'move the appointment to 3', phase: 'confirm' }), {
    reply: 'So you want move the appointment to 3?',
    inquiry: 'move the appointment to 3',
    phase: 'confirm',
    topicId: null,
  });
});

test('accepted is kept only with an inquiry', () => {
  const turn = readInquiryTurn({ reply: 'Okay.', inquiry: 'a refund for order 12', phase: 'accepted' });
  assert.equal(turn.phase, 'accepted');
  assert.equal(turn.inquiry, 'a refund for order 12');
});

test('the system prompt keeps earlier lines in mind and notes an interruption', () => {
  const prompt = inquirySystemPrompt('The caller spoke again before you answered.');
  assert.match(prompt, /Do not answer their question/);
  assert.match(prompt, /Do not greet again/);
  assert.match(prompt, /So you want/);
  assert.match(prompt, /accepted/);
  assert.match(prompt, /The caller spoke again before you answered/);
});

test('without verification a clear inquiry is accepted and not spoken back', () => {
  const prompt = inquirySystemPrompt(undefined, [{ id: 'hours', description: 'User asks for working hours' }], 'default', false);
  assert.match(prompt, /Do not use phase "confirm"/);
  assert.match(prompt, /accept now and set topicId/);
  assert.doesNotMatch(prompt, /So you want \{inquiry\}/);
  assert.deepEqual(
    withoutVerification({ reply: 'So you want the office location?', inquiry: 'the office location', phase: 'confirm', topicId: 'default' }),
    { reply: '', inquiry: 'the office location', phase: 'accepted', topicId: 'default' },
  );
});

test('the system prompt includes the topics the call can be routed to', () => {
  const prompt = inquirySystemPrompt(undefined, [{ id: 'hours', description: 'User asks for working hours' }], 'default');
  assert.match(prompt, /Do not give the address/);
  assert.match(prompt, /hours: User asks for working hours/);
  assert.match(prompt, /default: anything that does not match/);
  assert.equal(readInquiryTurn({ reply: 'Okay.', inquiry: 'the office location', phase: 'accepted', topicId: 'missing' }, ['hours', 'default'], 'default').topicId, 'default');
});
