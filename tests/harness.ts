import type Database from "better-sqlite3";
import { IdentityRepository } from "@/server/auth/identity";
import { AuthService } from "@/server/auth/service";
import type { Role } from "@/server/db/constants";
import { testConfig } from "./helpers";

// Helpers for tests that call the REAL route handlers: they create organizations, users and genuine
// sessions in an in-memory database and send requests carrying the session cookie, exactly as a
// browser would. (The test file itself points getDb() at the in-memory database with vi.mock.)

/** Cheap scrypt settings: the real cost (about 100 ms per check) is pointless in tests. */
export const FAST_PASSWORDS = { N: 1024, r: 8, p: 1 };

export interface Seeded {
  orgId: string;
  userId: string;
  email: string;
  role: Role;
  /** Value for a Cookie header. */
  cookie: string;
}

export function seedOrganization(db: Database.Database, name: string): string {
  return new IdentityRepository(db).createOrganization(name).id;
}

/** Adds (or finds) a person, makes them a member of the organization with that role, and signs them in there. */
export function seedMember(db: Database.Database, orgId: string, email: string, role: Role, options: { platformAdmin?: boolean } = {}): Seeded {
  const identity = new IdentityRepository(db);
  const user = identity.findUserByEmail(email) ?? identity.createUser({ email, passwordHash: "x", isPlatformAdmin: options.platformAdmin });
  if (!identity.getMembership(orgId, user.id)) identity.addMember(orgId, user.id, role);
  const { token } = new AuthService(db, testConfig(), FAST_PASSWORDS).createSession(user.id, orgId);
  return { orgId, userId: user.id, email: user.email, role: identity.getMembership(orgId, user.id)!.role, cookie: `kb_session=${token}` };
}

type RouteHandler = (request: Request, ctx: { params: Promise<never> }) => Response | Promise<Response>;

export interface CallOptions {
  method?: string;
  cookie?: string;
  /** JSON body. */
  json?: unknown;
  /** Multipart body. */
  form?: FormData;
  /** Raw bytes (an audio part). */
  raw?: Uint8Array;
  headers?: Record<string, string>;
  /** Route parameters, e.g. { id: "…" }. */
  params?: Record<string, string>;
}

/** Calls a route handler the way Next.js would. */
export async function call(handler: unknown, url: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.json !== undefined) headers["content-type"] = "application/json";
  const request = new Request(`http://localhost:3000${url}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : (options.raw ? new Uint8Array(options.raw) : options.form),
  });
  return (handler as RouteHandler)(request, { params: Promise.resolve((options.params ?? {}) as never) });
}

/** JSON body of a response (null when there is none). */
export async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json().catch(() => null)) as T;
}
