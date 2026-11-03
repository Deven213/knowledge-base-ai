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

export type SessionState = "none" | "ok" | "password_change_required";

/**
 * What the request gate needs to know about a token: no usable session ("none"), a normal one ("ok"), or one whose
 * account still has a temporary password that must be replaced first. A session of a disabled account, or of an
 * account whose temporary password expired or was revoked, is "none". Fails closed: any error (no database yet,
 * table missing, malformed token) means "not signed in".
 */
export function sessionState(token: string | null | undefined, db?: Database.Database): SessionState {
  if (!isWellFormedToken(token)) return "none";
  try {
    const row = (db ?? database())
      .prepare(
        `SELECT u.must_change_password AS mustChange
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id AND u.status = 'active'
              AND NOT (u.must_change_password = 1 AND (u.temp_password_expires_at IS NULL OR u.temp_password_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')))
         WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .get(hashSessionToken(token)) as { mustChange: number } | undefined;
    if (!row) return "none";
    return row.mustChange === 1 ? "password_change_required" : "ok";
  } catch {
    return "none";
  }
}

/** True for any usable session, including one that must change its password first. */
export function isSessionTokenValid(token: string | null | undefined, db?: Database.Database): boolean {
  return sessionState(token, db) !== "none";
}
