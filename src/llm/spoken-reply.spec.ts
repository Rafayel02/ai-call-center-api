import assert from 'node:assert/strict';
import test from 'node:test';
import { readSpokenReply } from './spoken-reply';

test('a json reply becomes the spoken sentence', () => {
  assert.equal(
    readSpokenReply('{"reply":"The Cosmo package includes 10 GB and costs 5000 dram."}'),
    'The Cosmo package includes 10 GB and costs 5000 dram.',
  );
});

test('a plain sentence is kept', () => {
  assert.equal(readSpokenReply('The Cosmo package includes 10 GB.'), 'The Cosmo package includes 10 GB.');
});

test('json without a sentence is rejected', () => {
  assert.throws(() => readSpokenReply('{"status":"ok"}'), /spoken reply/);
});
