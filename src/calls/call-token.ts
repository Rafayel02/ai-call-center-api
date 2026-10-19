import { createHmac, timingSafeEqual } from 'node:crypto';

export const CALL_TOKEN_TTL_MS = 60_000;

function sign(secret: string, body: string) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

/** A token that names one call and expires. Using it once is enforced by whoever holds the pending call. */
export function mintCallToken(secret: string, callId: string, now = Date.now()) {
  const body = `${callId}.${now + CALL_TOKEN_TTL_MS}`;
  return `${body}.${sign(secret, body)}`;
}

/** The call id a valid, unexpired token names, or null. */
export function readCallToken(secret: string, token: string, now = Date.now()): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [callId, expires, signature] = parts;
  const expected = Buffer.from(sign(secret, `${callId}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const expiresAt = Number(expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now) return null;
  return callId;
}
