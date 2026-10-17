import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSamples } from './sample-selection';

const samples = ['s1', 's2', 's3', 's4', 's5'];
const engines = ['A', 'B'];

test('with nothing stored, the oldest samples are picked', () => {
  assert.deepEqual(pickSamples(samples, engines, [], 3), ['s1', 's2', 's3']);
});

test('fully checked samples come first, then partly checked, then new', () => {
  const stored = [
    { engineKey: 'A', sampleId: 's4' },
    { engineKey: 'A', sampleId: 's5' },
    { engineKey: 'B', sampleId: 's5' },
  ];
  assert.deepEqual(pickSamples(samples, engines, stored, 4), ['s5', 's4', 's1', 's2']);
});

test('checks by engines that are not selected do not count', () => {
  const stored = [{ engineKey: 'C', sampleId: 's3' }];
  assert.deepEqual(pickSamples(samples, engines, stored, 2), ['s1', 's2']);
});

test('a larger count keeps what a smaller count picked', () => {
  const stored = [{ engineKey: 'B', sampleId: 's3' }];
  const small = pickSamples(samples, engines, stored, 2);
  const large = pickSamples(samples, engines, stored, 4);
  assert.deepEqual(large.slice(0, small.length), small);
});

test('a count above the dataset size returns every sample', () => {
  assert.equal(pickSamples(samples, engines, [], 50).length, samples.length);
});
