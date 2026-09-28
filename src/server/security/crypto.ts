import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for secrets that must be stored (OAuth tokens for Sync Integrations).
// The key comes from INTEGRATIONS_ENCRYPTION_KEY; ciphertext, IV and auth tag are stored separately.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

function keyFromBase64(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes.");
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string): EncryptedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyFromBase64(base64Key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptSecret(secret: EncryptedSecret, base64Key: string): string {
  const decipher = createDecipheriv(ALGORITHM, keyFromBase64(base64Key), secret.iv);
  decipher.setAuthTag(secret.authTag);
  try {
    return Buffer.concat([decipher.update(secret.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Never include ciphertext or key material in the error.
    throw new Error("Stored credentials could not be decrypted (the encryption key may have changed). Reconnect the integration.");
  }
}
