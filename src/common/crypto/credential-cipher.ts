import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface EncryptedSecret {
  v: 1;
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptionKeyFromEnv(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be 32 bytes encoded as base64.');
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer): string {
  if (secret.v !== 1) {
    throw new Error('Unsupported credential format.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function secretHint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 4) return '••••';
  return trimmed.slice(-4);
}
