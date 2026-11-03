import "server-only";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";

// Password hashing with scrypt (built into Node, so no extra dependency). A stored hash looks like
//   scrypt$<N>$<r>$<p>$<salt, base64>$<hash, base64>
// and carries its own parameters, so the cost can be raised later without breaking old passwords.
// The work runs on libuv's thread pool, so a sign-in never blocks the server.

export interface ScryptParams {
  /** CPU/memory cost (a power of two). */
  N: number;
  r: number;
  p: number;
}

/** Interactive-login cost: about 32 MB and roughly 100 ms per check. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 32768, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;
/** Refuse stored parameters that could be used to exhaust memory or CPU. */
const MAX_N = 2 ** 20;

// The length rules live in lib/password-policy.ts so the forms use exactly the same numbers.
export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY };
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, KEY_BYTES, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const valid = [N, r, p].every(Number.isInteger) && N >= 2 && N <= MAX_N && (N & (N - 1)) === 0 && r >= 1 && r <= 32 && p >= 1 && p <= 16;
  if (!valid) return null;
  const salt = Buffer.from(parts[4]!, "base64");
  const key = Buffer.from(parts[5]!, "base64");
  return salt.length > 0 && key.length === KEY_BYTES ? { params: { N, r, p }, salt, key } : null;
}

/** True when `password` matches the stored hash. Constant-time comparison; false for a malformed hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

let dummy: Promise<string> | undefined;

/**
 * Runs a full password check against a throwaway hash. Sign-in calls this for an unknown email, so the
 * response takes as long as for a real account and reveals nothing about which emails are registered.
 */
export async function burnPasswordCheck(password: string, params: ScryptParams = DEFAULT_SCRYPT_PARAMS): Promise<null> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"), params);
  await verifyPassword(password, await dummy);
  return null;
}

/** A message the user can act on, or null when the password is acceptable. */
export function passwordProblem(password: unknown, email: string): string | null {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) return "The password can't be your email address.";
  if (/^(.)\1+$/.test(password)) return "Choose a less repetitive password.";
  return null;
}
