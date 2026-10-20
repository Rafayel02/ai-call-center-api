import { createHmac, timingSafeEqual } from 'node:crypto';

/** HMAC-SHA1 of the full URL plus every POST field, sorted by name, with the auth token. Base64. */
export function twilioSignature(authToken: string, url: string, params: Record<string, string> = {}) {
  const signed = Object.keys(params)
    .sort()
    .reduce((text, name) => text + name + params[name], url);
  return createHmac('sha1', authToken).update(Buffer.from(signed, 'utf8')).digest('base64');
}

export function isTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function formParams(body: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  if (!body || typeof body !== 'object') return params;
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') params[name] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') params[name] = String(value);
  }
  return params;
}
