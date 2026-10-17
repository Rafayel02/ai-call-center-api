import assert from 'node:assert/strict';
import test from 'node:test';
import { readTopicChoice, topicRoutePrompt } from './topic-route';

test('the route prompt names each topic and the default path', () => {
  const prompt = topicRoutePrompt('the opening hours', [{ id: 'hours', description: 'User asks for working hours' }], 'default');
  assert.match(prompt, /the opening hours/);
  assert.match(prompt, /hours: User asks for working hours/);
  assert.match(prompt, /default: anything that does not match/);
});

test('an unknown topic falls back to default', () => {
  assert.equal(readTopicChoice({ topicId: 'hours' }, ['hours', 'default'], 'default'), 'hours');
  assert.equal(readTopicChoice({ topicId: 'other' }, ['hours', 'default'], 'default'), 'default');
  assert.equal(readTopicChoice(null, ['default'], 'default'), 'default');
});
