import "server-only";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth-routes";
import { getConfig, type AppConfig } from "../config";
import { getDb } from "../db/client";
import type { Role } from "../db/constants";
import { credentialStatus, IdentityRepository, type UserOrganization, type UserRow } from "./identity";
import { burnPasswordCheck, DEFAULT_SCRYPT_PARAMS, PASSWORD_MAX_LENGTH, verifyPassword, type ScryptParams } from "./password";
import { hashSessionToken, isWellFormedToken } from "./session-lookup";

// Accounts live in the users table; a sign-in creates a server-side session row bound to the user AND to
// the organization they are working in. The browser only holds a random token in an httpOnly cookie
// (nothing about the session lives in localStorage or React state), and the database stores only its hash.

export interface Session {
  userId: string;
  email: string;
  displayName: string | null;
  orgId: string;
  role: Role;
  isPlatformAdmin: boolean;
  /** The account only has a temporary password: until it is replaced, nothing but the password change is allowed. */
  mustChangePassword: boolean;
  expiresAt: string;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export class AuthService {
  readonly identity: IdentityRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly config: Pick<AppConfig, "AUTH_SESSION_HOURS" | "DEMO_USER_EMAIL" | "DEMO_USER_PASSWORD">,
    private readonly passwordParams: ScryptParams = DEFAULT_SCRYPT_PARAMS,
  ) {
    this.identity = new IdentityRepository(db);
  }

  /**
   * Checks an email and password. Always does the same amount of work (a real or a throwaway hash), and
   * returns null for every failure, so the result reveals neither which emails exist nor which part was wrong.
   */
  async authenticate(email: unknown, password: unknown): Promise<UserRow | null> {
    if (typeof email !== "string" || typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH) {
      return burnPasswordCheck(typeof password === "string" ? password.slice(0, PASSWORD_MAX_LENGTH) : "", this.passwordParams);
    }
    const user = this.identity.findUserByEmail(email);
    if (!user) return burnPasswordCheck(password, this.passwordParams);
    const matches = await verifyPassword(password, user.password_hash);
    if (!matches || user.status !== "active") return null;
    return user;
  }

  /**
   * True for an account whose temporary password has run out (or was revoked). Only meaningful AFTER the password was
   * verified: telling someone who typed the right temporary password that it expired reveals nothing to anyone else.
   */
  temporaryPasswordExpired(user: UserRow): boolean {
    return credentialStatus(user) === "expired";
  }

  /** The workspace a user lands in after signing in: the first one they joined that isn't suspended. */
  defaultOrganization(userId: string): UserOrganization | undefined {
    return this.identity.activeOrganizationsOf(userId)[0];
  }

  /** True when the person belongs to workspaces but every one of them is suspended (so sign-in can say why). */
  onlySuspendedWorkspaces(userId: string): boolean {
    const all = this.identity.organizationsOf(userId);
    return all.length > 0 && all.every((o) => o.status === "suspended");
  }

  /** True when the person belongs to no workspace at all (so sign-in can say why, once the password was right). */
  belongsToNoWorkspace(userId: string): boolean {
    return this.identity.organizationsOf(userId).length === 0;
  }

  /** The public demo account exists only when its password is set in the environment. */
  get demoEnabled(): boolean {
    return !!this.config.DEMO_USER_PASSWORD;
  }

  demoUser(): UserRow | undefined {
    return this.demoEnabled ? this.identity.findUserByEmail(this.config.DEMO_USER_EMAIL) : undefined;
  }

  /** Starts a session for a user inside an organization they belong to (and that isn't suspended). */
  createSession(userId: string, orgId: string): { token: string; expiresAt: Date } {
    const user = this.identity.findUserById(userId);
    if (
      !user ||
      user.status !== "active" ||
      credentialStatus(user) === "expired" ||
      !this.identity.getMembership(orgId, userId) ||
      this.identity.getOrganization(orgId)?.status !== "active"
    ) {
      throw new Error("Cannot start a session: not an active member of an active organization.");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.AUTH_SESSION_HOURS * 3600_000);
    this.db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ${NOW}`).run();
    this.db
      .prepare(`INSERT INTO auth_sessions (token_hash, email, user_id, org_id, expires_at) VALUES (?, ?, ?, ?, ?)`)
      .run(hashSessionToken(token), user.email, userId, orgId, expiresAt.toISOString());
    return { token, expiresAt };
  }

  /**
   * The session behind a token, or null. Everything is re-read from the database on every call, so a
   * disabled account, a removed membership, a suspended workspace, or a temporary password that has expired or been
   * revoked stops working immediately.
   */
  getSession(token: string | null | undefined): Session | null {
    if (!isWellFormedToken(token)) return null;
    const row = this.db
      .prepare(
        `SELECT s.user_id, s.org_id, s.expires_at, u.email, u.display_name, u.is_platform_admin, u.must_change_password, m.role
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id AND u.status = 'active'
              AND NOT (u.must_change_password = 1 AND (u.temp_password_expires_at IS NULL OR u.temp_password_expires_at <= ${NOW}))
         JOIN organizations o ON o.id = s.org_id AND o.status = 'active'
         JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
         WHERE s.token_hash = ? AND s.expires_at > ${NOW}`,
      )
      .get(hashSessionToken(token)) as
      | { user_id: string; org_id: string; expires_at: string; email: string; display_name: string | null; is_platform_admin: number; must_change_password: number; role: Role }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      orgId: row.org_id,
      role: row.role,
      isPlatformAdmin: row.is_platform_admin === 1,
      mustChangePassword: row.must_change_password === 1,
      expiresAt: row.expires_at,
    };
  }

  /** Moves a session to another organization the user belongs to. */
  switchOrganization(token: string | null | undefined, orgId: string): boolean {
    const session = this.getSession(token);
    if (!session || !isWellFormedToken(token) || !this.identity.getMembership(orgId, session.userId)) return false;
    if (this.identity.getOrganization(orgId)?.status !== "active") return false;
    this.db.prepare(`UPDATE auth_sessions SET org_id = ? WHERE token_hash = ?`).run(orgId, hashSessionToken(token));
    return true;
  }

  /** Ends a session everywhere: the row is deleted, so the cookie token stops working at once. */
  deleteSession(token: string | null | undefined): void {
    if (isWellFormedToken(token)) this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hashSessionToken(token));
  }

  deleteSessionsOfUser(userId: string): void {
    this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
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

/** The session token in a request's Cookie header, if any. */
export function sessionTokenFromRequest(request: Request): string | null {
  const raw = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The signed-in session for this page request (server components), or null. */
export async function currentSession(): Promise<Session | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return getAuth().getSession(token);
}

/**
 * Server-side guard for product layouts (the proxy already redirects with ?redirect=…; this is the
 * authoritative check next to the data). Someone who still has a temporary password is sent to choose a new one:
 * they can't reach any product page until they have.
 */
export async function requireSession(): Promise<Session> {
  const session = await requireSessionAllowingPasswordChange();
  if (session.mustChangePassword) redirect("/change-password");
  return session;
}

/** Like requireSession, but also lets through a person who must still change a temporary password (the change-password page itself). */
export async function requireSessionAllowingPasswordChange(): Promise<Session> {
  const session = await currentSession();
  if (!session) redirect("/login");
  return session;
}
