import assert from 'node:assert/strict';
import test from 'node:test';
import { inquirySystemPrompt, readInquiryTurn } from './inquiry-turn';

test('confirmation without an inquiry is rejected', () => {
  assert.throws(() => readInquiryTurn({ reply: 'So you want that?', inquiry: '  ', phase: 'confirm' }), /did not name the inquiry/);
});

test('a confirmation is accepted without being spoken back', () => {
  assert.deepEqual(readInquiryTurn({ reply: 'So you want move the appointment to 3?', inquiry: 'move the appointment to 3', phase: 'confirm' }), {
    reply: '',
    inquiry: 'move the appointment to 3',
    phase: 'accepted',
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
  assert.match(prompt, /Do not ask the caller to confirm/);
  assert.match(prompt, /accepted/);
  assert.match(prompt, /The caller spoke again before you answered/);
});

test('a return from closing asks for the question, or accepts a stated one without answering it', () => {
  const prompt = inquirySystemPrompt(undefined, undefined, undefined, true);
  assert.match(prompt, /ask what question they have/);
  assert.match(prompt, /You do not answer it/);
  assert.match(prompt, /reply must be an empty string/);
  assert.doesNotMatch(prompt, /answer that question in reply/);
  const turn = readInquiryTurn({ reply: 'The office is on Main Street.', inquiry: 'the office location', phase: 'accepted' });
  assert.equal(turn.reply, '');
  assert.equal(turn.inquiry, 'the office location');
  assert.equal(turn.phase, 'accepted');
});

test('the system prompt includes the topics the call can be routed to', () => {
  const prompt = inquirySystemPrompt(undefined, [{ id: 'hours', description: 'User asks for working hours' }], 'default');
  assert.match(prompt, /Do not give the address/);
  assert.match(prompt, /hours: User asks for working hours/);
  assert.match(prompt, /default: anything that does not match/);
  assert.equal(readInquiryTurn({ reply: 'Okay.', inquiry: 'the office location', phase: 'accepted', topicId: 'missing' }, ['hours', 'default'], 'default').topicId, 'default');
});
