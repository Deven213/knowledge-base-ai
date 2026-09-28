import "server-only";
import type Database from "better-sqlite3";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth-routes";
import { getConfig, type AppConfig } from "../config";
import { getDb } from "../db/client";
import { hashSessionToken, isWellFormedToken } from "./session-lookup";

// Demo sign-in for this MVP: one account whose credentials come from the environment
// (DEMO_USER_EMAIL / DEMO_USER_PASSWORD). Sessions are server-side rows; the browser only holds a
// random token in an httpOnly cookie. Nothing about the session lives in localStorage or React state.

export interface Session {
  email: string;
  expiresAt: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Constant-time comparison (both sides hashed to the same length first). */
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export class AuthService {
  constructor(
    private readonly db: Database.Database,
    private readonly config: Pick<AppConfig, "DEMO_USER_EMAIL" | "DEMO_USER_PASSWORD" | "AUTH_SESSION_HOURS">,
  ) {}

  /** Checks email AND password together, always both, so the result reveals nothing about which was wrong. */
  verifyCredentials(email: unknown, password: unknown): string | null {
    if (typeof email !== "string" || typeof password !== "string") return null;
    const normalized = email.trim().toLowerCase();
    const emailOk = same(normalized, this.config.DEMO_USER_EMAIL);
    const passwordOk = same(password, this.config.DEMO_USER_PASSWORD);
    return emailOk && passwordOk ? this.config.DEMO_USER_EMAIL : null;
  }

  get demoEmail(): string {
    return this.config.DEMO_USER_EMAIL;
  }

  createSession(email: string): { token: string; expiresAt: Date } {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.AUTH_SESSION_HOURS * 3600_000);
    this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run();
    this.db.prepare(`INSERT INTO auth_sessions (token_hash, email, expires_at) VALUES (?, ?, ?)`).run(hashSessionToken(token), email, expiresAt.toISOString());
    return { token, expiresAt };
  }

  getSession(token: string | null | undefined): Session | null {
    if (!isWellFormedToken(token)) return null;
    const row = this.db
      .prepare(`SELECT email, expires_at FROM auth_sessions WHERE token_hash = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .get(hashSessionToken(token)) as { email: string; expires_at: string } | undefined;
    return row ? { email: row.email, expiresAt: row.expires_at } : null;
  }

  /** Ends a session everywhere: the row is deleted, so the cookie token stops working at once. */
  deleteSession(token: string | null | undefined): void {
    if (isWellFormedToken(token)) this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashSessionToken(token));
  }
}

export function getAuth(): AuthService {
  return new AuthService(getDb(), getConfig());
}

export function sessionCookie(token: string, expiresAt: Date) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: getConfig().APP_BASE_URL.startsWith("https://"),
    path: "/",
    expires: expiresAt,
  };
}

/** The signed-in session for this request, or null. */
export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getAuth().getSession(token);
}

/**
 * Server-side guard for product layouts (the proxy already redirects with ?redirect=…; this is the
 * authoritative check next to the data).
 */
export async function requireSession(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}

// Slows down password guessing: at most 10 failed sign-ins per client per 15 minutes (in memory;
// fine for this single-server demo).
const failures = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

export function tooManyFailures(client: string): boolean {
  const entry = failures.get(client);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_FAILURES;
}

export function recordFailure(client: string): void {
  const now = Date.now();
  const entry = failures.get(client);
  if (!entry || entry.resetAt < now) failures.set(client, { count: 1, resetAt: now + WINDOW_MS });
  else entry.count += 1;
}

export function clearFailures(client: string): void {
  failures.delete(client);
}

export function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}
