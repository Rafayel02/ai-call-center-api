import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio's request signature: HMAC-SHA1 with the auth token over the full URL followed by every POST parameter,
 * sorted by name, as name then value with no separator. Base64.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string> = {}) {
  const signed = Object.keys(params)
    .sort()
    .reduce((text, name) => text + name + params[name], url);
  return createHmac('sha1', authToken).update(Buffer.from(signed, 'utf8')).digest('base64');
}

/** True when `signature` matches one of the URLs Twilio may have signed. */
export function isTwilioSignature(authToken: string, urls: string[], params: Record<string, string>, signature: string | undefined) {
  if (!signature) return false;
  const given = Buffer.from(signature);
  return urls.some((url) => {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** A parsed form body as the flat string parameters Twilio sent. */
export function formParams(body: unknown): Record<string, string> {
  const params: Record<string, string> = {};
  if (!body || typeof body !== 'object') return params;
  for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') params[name] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') params[name] = String(value);
  }
  return params;
}
