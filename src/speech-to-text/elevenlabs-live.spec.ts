import assert from 'node:assert/strict';
import test from 'node:test';
import { readLiveMessage } from './elevenlabs-live';

test('a committed live transcript is kept and a socket error is recognized', () => {
  assert.deepEqual(readLiveMessage('{"message_type":"committed_transcript","text":"Բարև"}'), { type: 'committed', text: 'Բարև' });
  assert.equal(readLiveMessage('{"message_type":"auth_error","error":"no"}')?.type, 'error');
  assert.equal(readLiveMessage('{"message_type":"session_started"}')?.type, 'ready');
});
