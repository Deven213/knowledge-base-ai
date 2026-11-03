import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Seals health information (patient labels, transcripts, clinical notes and the audio itself) before it is stored.
//
//   sealed = [ format version: 1 byte ][ IV: 12 bytes ][ GCM tag: 16 bytes ][ ciphertext ]
//
// AES-256-GCM with a fresh random IV for every value. Every value is also bound to a context string ("additional
// authenticated data": the organization, the consultation and what the value is). Opening it with a different context
// fails, so a sealed value copied into another row, another consultation or another customer's workspace is useless
// there even by someone with write access to the database file. The key comes from CONSULTATIONS_ENCRYPTION_KEY and never
// leaves the server. The leading version byte leaves room to rotate the key or the format later without guessing.
//
// Nothing here ever includes plaintext, ciphertext or key material in an error message or a log line.

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

export class VaultError extends Error {
  constructor(message = "A stored health record could not be opened. The encryption key may have changed, or the record was altered.") {
    super(message);
    this.name = "VaultError";
  }
}

export class Vault {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) throw new Error("The consultation encryption key must be 32 bytes (base64).");
    this.key = key;
  }

  seal(plaintext: Buffer | string, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer, context: string): Buffer {
    if (sealed.length < HEADER_BYTES || sealed[0] !== FORMAT_VERSION) throw new VaultError();
    const iv = sealed.subarray(1, 1 + IV_BYTES);
    const tag = sealed.subarray(1 + IV_BYTES, HEADER_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
    } catch {
      throw new VaultError();
    }
  }

  sealText(text: string, context: string): Buffer {
    return this.seal(text, context);
  }

  openText(sealed: Buffer, context: string): string {
    return this.open(sealed, context).toString("utf8");
  }

  sealJson(value: unknown, context: string): Buffer {
    return this.seal(JSON.stringify(value), context);
  }

  openJson<T>(sealed: Buffer, context: string): T {
    return JSON.parse(this.openText(sealed, context)) as T;
  }
}
