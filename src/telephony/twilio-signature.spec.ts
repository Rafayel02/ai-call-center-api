import assert from 'node:assert/strict';
import test from 'node:test';
import { isTwilioSignature, twilioSignature } from './twilio-signature';

// Twilio's worked example from https://www.twilio.com/docs/usage/security
const authToken = '12345';
const url = 'https://example.com/myapp.php?foo=1&bar=2';
const params = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675310',
  Digits: '1234',
  From: '+14158675310',
  To: '+18005551212',
};

test("matches Twilio's documented signature", () => {
  assert.equal(twilioSignature(authToken, url, params), 'L/OH5YylLD5NRKLltdqwSvS0BnU=');
});

test('accepts the signature for any listed URL and refuses a changed request', () => {
  const signature = twilioSignature(authToken, `${url}/`, params);
  assert.equal(isTwilioSignature(authToken, [url, `${url}/`], params, signature), true);
  assert.equal(isTwilioSignature(authToken, [url], { ...params, To: '+18005550000' }, twilioSignature(authToken, url, params)), false);
  assert.equal(isTwilioSignature('another-token', [url], params, twilioSignature(authToken, url, params)), false);
  assert.equal(isTwilioSignature(authToken, [url], params, undefined), false);
});
