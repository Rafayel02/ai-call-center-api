import assert from 'node:assert/strict';
import test from 'node:test';
import { CALL_TOKEN_TTL_MS, mintCallToken, readCallToken } from './call-token';

const secret = 'a-long-random-secret-for-tests';
const callId = '11111111-1111-4111-8111-111111111111';

test('a token names its call until it expires', () => {
  const token = mintCallToken(secret, callId, 1_000);
  assert.equal(readCallToken(secret, token, 1_000 + CALL_TOKEN_TTL_MS), callId);
  assert.equal(readCallToken(secret, token, 1_001 + CALL_TOKEN_TTL_MS), null);
});

test('a token signed with another secret, or changed, is refused', () => {
  const token = mintCallToken(secret, callId, 1_000);
  assert.equal(readCallToken('another-secret', token, 1_000), null);
  assert.equal(readCallToken(secret, token.replace(callId, '22222222-2222-4222-8222-222222222222'), 1_000), null);
  assert.equal(readCallToken(secret, 'not-a-token', 1_000), null);
});
