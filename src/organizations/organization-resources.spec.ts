import assert from 'node:assert/strict';
import test from 'node:test';
import { readIndexState, resourceFileName } from './organization-resources';

test('a document name keeps its extension', () => {
  assert.equal(resourceFileName('folder/Visit fees.pdf'), 'Visit fees.pdf');
});

test('a file without a document extension is rejected', () => {
  assert.throws(() => resourceFileName('notes.exe'), /PDF, Word/);
});

test('a completed OpenAI file is ready', () => {
  assert.deepEqual(readIndexState({ status: 'completed', last_error: null }), { status: 'READY', errorMessage: null });
});

test('a failed OpenAI file keeps the reason', () => {
  assert.deepEqual(readIndexState({ status: 'failed', last_error: { message: 'File type is not supported.' } }), {
    status: 'FAILED',
    errorMessage: 'File type is not supported.',
  });
});

test('an in-progress OpenAI file stays indexing', () => {
  assert.equal(readIndexState({ status: 'in_progress' }).status, 'INDEXING');
});
