// Session check used by the request proxy (src/proxy.ts). It deliberately avoids the app's
// server-only modules (the proxy runs outside the React server environment): it opens the SQLite
// database read-only and looks up the SHA-256 hash of the cookie token.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";

/** Session tokens are 32 random bytes, base64url-encoded (43 characters). */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isWellFormedToken(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

let readonlyDb: Database.Database | null = null;

function database(): Database.Database {
  if (!readonlyDb) {
    // Same location the app uses (DATA_DIR, default ./data).
    const file = path.join(path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR?.trim() || "./data"), "kb.sqlite");
    readonlyDb = new Database(file, { readonly: true, fileMustExist: true });
  }
  return readonlyDb;
}

/**
 * True only for a token that belongs to an unexpired session. Fails closed: any error (no database
 * yet, table missing, malformed token) means "not signed in".
 */
export function isSessionTokenValid(token: string | null | undefined, db?: Database.Database): boolean {
  if (!isWellFormedToken(token)) return false;
  try {
    const row = (db ?? database())
      .prepare(`SELECT 1 FROM auth_sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .get(hashSessionToken(token));
    return row !== undefined;
  } catch {
    return false;
  }
}
