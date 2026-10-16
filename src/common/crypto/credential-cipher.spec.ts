import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { decryptSecret, encryptSecret, secretHint } from './credential-cipher';

test('encrypts and decrypts a provider credential', () => {
  const key = randomBytes(32);
  const encrypted = encryptSecret('sk_live_example_key_1234', key);
  assert.equal(encrypted.v, 1);
  assert.notEqual(encrypted.ciphertext, 'sk_live_example_key_1234');
  assert.equal(decryptSecret(encrypted, key), 'sk_live_example_key_1234');
});

test('rejects a ciphertext decrypted with the wrong key', () => {
  const encrypted = encryptSecret('secret', randomBytes(32));
  assert.throws(() => decryptSecret(encrypted, randomBytes(32)));
});

test('hint keeps only the last four characters', () => {
  assert.equal(secretHint('sk_abcdefghij'), 'ghij');
});
