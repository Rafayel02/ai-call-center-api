import assert from 'node:assert/strict';
import test from 'node:test';
import { isTwilioSignature, twilioSignature } from './twilio-signature';

const authToken = '12345';
const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
const params = {
  CallSid: 'CA1234567890ABCDE',
  Caller: '+14158675309',
  Digits: '1234',
  From: '+14158675309',
  To: '+18005551212',
};

test('matches the signature Twilio documents', () => {
  assert.equal(twilioSignature(authToken, url, params), 'RSOYDt4T1cUTdK1PDd93/VVr8B8=');
});

test('refuses a changed field or a missing signature', () => {
  const signature = twilioSignature(authToken, url, params);
  assert.equal(isTwilioSignature(authToken, url, params, signature), true);
  assert.equal(isTwilioSignature(authToken, url, { ...params, To: '+18005550000' }, signature), false);
  assert.equal(isTwilioSignature(authToken, url, params, undefined), false);
});
