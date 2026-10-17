import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreTranscript, transcriptWords } from './transcript-score';

test('an exact transcript scores 1', () => {
  assert.equal(scoreTranscript('Բարև ձեզ, ինչպե՞ս եք։', 'Բարև ձեզ, ինչպե՞ս եք։'), 1);
});

test('case, punctuation, and Armenian in-word marks do not count as errors', () => {
  assert.equal(scoreTranscript('Բարև ձեզ, ինչպե՞ս եք։', 'բարև ձեզ ինչպես եք'), 1);
  assert.equal(scoreTranscript('«Այո՛», ասաց նա։', 'այո ասաց նա'), 1);
});

test('the ligature և matches the spelling եւ', () => {
  assert.equal(scoreTranscript('Բարև', 'բարեւ'), 1);
});

test('in-word marks are removed without splitting the word', () => {
  assert.deepEqual(transcriptWords('ինչպե՞ս'), ['ինչպես']);
});

test('other punctuation separates words', () => {
  assert.deepEqual(transcriptWords('մեկ,երկու։երեք'), ['մեկ', 'երկու', 'երեք']);
});

test('substitutions, deletions, and insertions each cost one word', () => {
  assert.equal(scoreTranscript('one two three four', 'one too three four'), 0.75);
  assert.equal(scoreTranscript('one two three four', 'one three four'), 0.75);
  assert.equal(scoreTranscript('one two three four', 'one two three four five'), 0.75);
});

test('more errors than words scores 0, not below', () => {
  assert.equal(scoreTranscript('one two', 'three four five six seven'), 0);
});

test('an empty transcript scores 0', () => {
  assert.equal(scoreTranscript('one two', ''), 0);
  assert.equal(scoreTranscript('one two', ' ։ '), 0);
});
