import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 60_000;

function sign(secret: string, body: string) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64url');
}

export function mintCallToken(secret: string, callId: string, now = Date.now(), ttlMs = TTL_MS) {
  const body = `${callId}.${now + ttlMs}`;
  return `${body}.${sign(secret, body)}`;
}

export function readCallToken(secret: string, token: string, now = Date.now()) {
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
