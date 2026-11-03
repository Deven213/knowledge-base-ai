import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityRepository } from "@/server/auth/identity";
import { hashPassword } from "@/server/auth/password";
import { DocumentRepository } from "@/server/db/repositories";
import type { CreatedCustomerDTO, SessionDTO } from "@/lib/types";
import { body, call, FAST_PASSWORDS, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, cookie: undefined as string | undefined }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/auth/password", async (importOriginal) => (await import("./helpers")).withFastPasswords(await importOriginal<typeof import("@/server/auth/password")>()));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return {
    getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })),
    isFeatureEnabled: () => true,
    getFeatureAvailability: () => ({}),
    getFeatureFlagService: () => ({}),
    defaultFeatureFlags: () => [],
  };
});
// The server components read the session cookie through next/headers and redirect through next/navigation.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === "kb_session" && h.cookie ? { name, value: h.cookie } : undefined) }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import * as acceptRoute from "@/app/api/auth/accept-invite/route";
import * as changePasswordRoute from "@/app/api/auth/change-password/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as switchRoute from "@/app/api/auth/switch-org/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as orgInvitationsRoute from "@/app/api/org/invitations/route";
import * as orgMembersRoute from "@/app/api/org/members/route";
import * as platformOrgsRoute from "@/app/api/platform/organizations/route";
import * as platformOrgRoute from "@/app/api/platform/organizations/[id]/route";
import * as platformUserRoute from "@/app/api/platform/users/[userId]/route";
import * as platformCredentialsRoute from "@/app/api/platform/organizations/[id]/members/[userId]/credentials/route";
import { requireSession, requireSessionAllowingPasswordChange } from "@/server/auth/service";

const OWN = "My own new password 42";
let db: Database.Database;
let P: Seeded; // Super Admin
let acme: string;
let O: Seeded; // an existing customer's owner (has always had their own password)
let globex: string;
let G: Seeded;

let counter = 0;
const fresh = (prefix: string) => `${prefix}-${++counter}@customer.test`;
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const count = (table: string, where = "1=1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const audit = (where = "1=1") => db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all() as { action: string; actor_email: string | null; actor_org_id: string | null; outcome: string; details: string }[];
const userRow = (email: string) => db.prepare("SELECT * FROM users WHERE email = ?").get(email) as { id: string; password_hash: string; must_change_password: number; temp_password_expires_at: string | null; password_changed_at: string | null; status: string };

const login = (email: string, password: string, extra: Record<string, unknown> = {}) => call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email, password, ...extra } });
const me = (cookie?: string) => call(meRoute.GET, "/api/auth/me", { cookie });
const change = (cookie: string | undefined, currentPassword: unknown, newPassword: unknown, extra: Record<string, string> = {}) =>
  call(changePasswordRoute.POST, "/api/auth/change-password", { method: "POST", cookie, json: { currentPassword, newPassword }, headers: extra });

/** The Super Admin creates a customer through the real route; returns the credentials exactly as the console would show them. */
async function createCustomer(name: string, adminEmail = fresh("admin")) {
  const res = await call(platformOrgsRoute.POST, "/api/platform/organizations", { method: "POST", cookie: P.cookie, json: { name, adminEmail } });
  expect(res.status).toBe(201);
  const created = await body<CreatedCustomerDTO>(res);
  return { orgId: created.organization.id, email: adminEmail, temporary: created.credentials!.temporaryPassword };
}

/** A customer who has signed in with the temporary password (so they hold a session that must change the password). */
async function firstLogin(name: string) {
  const customer = await createCustomer(name);
  const res = await login(customer.email, customer.temporary);
  expect(res.status).toBe(200);
  return { ...customer, cookie: cookieFrom(res), userId: userRow(customer.email).id };
}

/** A customer who has also chosen their own password. */
async function activated(name: string) {
  const customer = await firstLogin(name);
  const res = await change(customer.cookie, customer.temporary, OWN);
  expect(res.status).toBe(200);
  return { ...customer, cookie: cookieFrom(res) };
}

const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
const logged = () => JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));

beforeEach(() => {
  db = memoryDb();
  h.db = db;
  h.cookie = undefined;
  const hq = seedOrganization(db, "Platform HQ");
  acme = seedOrganization(db, "Acme");
  globex = seedOrganization(db, "Globex");
  P = seedMember(db, hq, "super@platform.test", "owner", { platformAdmin: true });
  O = seedMember(db, acme, "owner@acme.test", "owner");
  G = seedMember(db, globex, "owner@globex.test", "owner");
  new DocumentRepository(db, acme).create({ id: "doc-acme", filename: "ACME-SECRET-PLAN.pdf", mimeType: "application/pdf", sizeBytes: 1 });
  new DocumentRepository(db, globex).create({ id: "doc-globex", filename: "GLOBEX-PRICING.pdf", mimeType: "application/pdf", sizeBytes: 1 });
  consoleSpies.push(...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)));
});

afterEach(() => {
  vi.restoreAllMocks();
  consoleSpies.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────────

describe("first sign-in with the temporary password", () => {
  it("signs the customer in and sends them to choose a new password, whatever page they asked for", async () => {
    const { email, temporary } = await createCustomer("Initech", "Boss@Initech.test");

    const res = await login("BOSS@initech.test", temporary, { redirect: "/admin/documents" });

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ redirect: "/change-password", passwordChangeRequired: true });
    expect(cookieFrom(res)).toMatch(/^kb_session=[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(userRow(email.toLowerCase()).must_change_password).toBe(1); // signing in does not end the temporary state
  });

  it("knows the account is on a temporary password and in its own workspace as owner", async () => {
    const { cookie, orgId } = await firstLogin("Initech");
    const session = await body<SessionDTO>(await me(cookie));
    expect(session.passwordChangeRequired).toBe(true);
    expect(session.organization).toMatchObject({ id: orgId, name: "Initech", role: "owner" });
    expect(session.organizations).toHaveLength(1);
    expect(session.user.isPlatformAdmin).toBe(false);
  });

  it("answers a wrong password, an unknown email and a disabled account identically (no enumeration)", async () => {
    const { email, temporary } = await createCustomer("Initech");
    const disabled = await createCustomer("Disabled Co");
    db.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run(disabled.email);

    const answers = [await login(email, "not the password!!"), await login(fresh("nobody"), temporary), await login(disabled.email, disabled.temporary)];

    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await body(res)).toEqual({ error: "Invalid email or password." });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("rate-limits guessing the temporary password: ten wrong tries lock the account, even for the right one", async () => {
    const { email, temporary } = await createCustomer("Initech");
    for (let i = 0; i < 10; i++) expect((await login(email, `wrong guess number ${i}`)).status).toBe(401);
    const locked = await login(email, temporary);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("set-cookie")).toBeNull();
  });

  it("never writes the temporary password to the logs, whatever happens", async () => {
    const { email, temporary } = await createCustomer("Initech");
    await login(email, temporary);
    await login(email, "something else entirely");
    expect(logged()).not.toContain(temporary);
  });
});

describe("the password change is enforced on the server", () => {
  /** Every API route file, found on disk, so a route added later can't be forgotten. */
  const loaders = import.meta.glob("../src/app/api/**/route.ts");
  const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  const ALLOWED = new Set(["GET /api/auth/me", "POST /api/auth/change-password"]);
  const routeOf = (key: string) => "/" + path.posix.dirname(key).replace(/^\.\.\/src\/app\//, "");

  it("finds the routes (guards against this test silently checking nothing)", () => {
    expect(Object.keys(loaders).length).toBeGreaterThanOrEqual(38);
  });

  it("refuses EVERY other API route with 403 'password_change_required' for a session that still has a temporary password", async () => {
    const { cookie } = await firstLogin("Initech");
    const normal = O.cookie;
    const refused: string[] = [];
    const unprotected: string[] = [];
    let checked = 0;

    for (const [key, load] of Object.entries(loaders)) {
      const source = fs.readFileSync(path.join(process.cwd(), key.replace("../", "")), "utf8");
      if (source.includes("// public-route:")) continue; // sign-in, sign-out and invitations are checked separately below
      const mod = (await load()) as Record<string, unknown>;
      for (const method of METHODS) {
        if (typeof mod[method] !== "function") continue;
        const label = `${method} ${routeOf(key)}`;
        const params = Promise.resolve(new Proxy({}, { get: () => "00000000-0000-4000-8000-000000000001" }));
        const send = (cookieValue: string) =>
          (mod[method] as (r: Request, c: { params: Promise<unknown> }) => Promise<Response>)(
            new Request(`http://localhost:3000${routeOf(key)}`, { method, headers: { cookie: cookieValue, "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" }),
            { params },
          );
        checked++;
        const res = await send(cookie);
        const isLocked = res.status === 403 && (await res.clone().json().catch(() => ({})))?.code === "password_change_required";
        if (ALLOWED.has(label)) {
          if (isLocked) refused.push(`${label} was locked but is meant to stay reachable`);
          continue;
        }
        if (!isLocked) unprotected.push(`${label} answered ${res.status} to a session that must change its password`);
        // The same route is NOT locked for an ordinary session (so the answer above is about the password change, not about permissions).
        const ok = await send(normal);
        const okBody = (await ok.clone().json().catch(() => ({}))) as { code?: string };
        if (okBody.code === "password_change_required") refused.push(`${label} refused a normal session too`);
      }
    }

    expect(checked).toBeGreaterThanOrEqual(45);
    expect(unprotected).toEqual([]);
    expect(refused).toEqual([]);
  });

  it("switching workspace and joining through an invitation are refused too", async () => {
    const { cookie, orgId } = await firstLogin("Initech");
    expect((await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie, json: { orgId } })).status).toBe(403);
    const token = "x".repeat(43);
    expect((await call(acceptRoute.POST, "/api/auth/accept-invite", { method: "POST", cookie, json: { token } })).status).toBe(403);
  });

  it("lets them see that a change is required and sign out", async () => {
    const { cookie } = await firstLogin("Initech");
    expect((await me(cookie)).status).toBe(200);
    expect((await call(logoutRoute.POST, "/api/auth/logout", { method: "POST", cookie })).status).toBe(303);
    expect((await me(cookie)).status).toBe(401);
  });

  it("sends the person to the password page from every product page (server components), and nowhere else", async () => {
    const { cookie } = await firstLogin("Initech");
    h.cookie = cookie.replace("kb_session=", "");
    await expect(requireSession()).rejects.toThrow("REDIRECT:/change-password");
    await expect(requireSessionAllowingPasswordChange()).resolves.toMatchObject({ mustChangePassword: true, email: expect.stringContaining("@customer.test") });

    h.cookie = O.cookie.replace("kb_session=", ""); // an ordinary person is not redirected
    await expect(requireSession()).resolves.toMatchObject({ mustChangePassword: false });
    h.cookie = undefined;
    await expect(requireSession()).rejects.toThrow("REDIRECT:/login");
  });

  it("a Super Admin account and an ordinary customer are never on a temporary password", () => {
    expect(userRow("super@platform.test").must_change_password).toBe(0);
    expect(userRow("owner@acme.test").must_change_password).toBe(0);
    expect(userRow("owner@globex.test").temp_password_expires_at).toBeNull();
  });

  it("the database won't hold a temporary-password flag without an expiry", async () => {
    const { userId } = await firstLogin("Initech");
    expect(() => db.prepare("UPDATE users SET temp_password_expires_at = NULL WHERE id = ?").run(userId)).toThrow(/needs an expiry/);
    expect(() => db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(O.userId)).toThrow(/needs an expiry/);
    expect(() => db.prepare("INSERT INTO users (id, email, password_hash, must_change_password) VALUES ('u-x', 'x@x.test', 'h', 1)").run()).toThrow(/needs an expiry/);
  });
});

describe("choosing a new password", () => {
  it("replaces the temporary password: the product opens, and the temporary password is dead at once", async () => {
    const { email, temporary, cookie, userId, orgId } = await firstLogin("Initech");
    const before = userRow(email);

    const res = await change(cookie, temporary, OWN);

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ changed: true, redirect: "/admin" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const fresh = cookieFrom(res);
    expect(fresh).not.toBe(cookie);

    const after = userRow(email);
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(after.password_hash).toMatch(/^scrypt\$/);
    expect(after.password_hash).not.toContain(OWN);
    expect(after).toMatchObject({ must_change_password: 0, temp_password_expires_at: null });
    expect(after.password_changed_at).toMatch(/^\d{4}-\d\d-\d\dT/);

    // The old sign-in is gone; the new one is a normal session that reaches the product.
    expect((await me(cookie)).status).toBe(401);
    expect((await body<SessionDTO>(await me(fresh))).passwordChangeRequired).toBe(false);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: fresh })).status).toBe(200);
    const members = await body<{ members: { email: string; role: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie: fresh }));
    expect(members.members).toEqual([expect.objectContaining({ email: email.toLowerCase(), role: "owner" })]);

    // The temporary password can't be used again; the new one is the only way in.
    const reused = await login(email, temporary);
    expect(reused.status).toBe(401);
    expect(await body(reused)).toEqual({ error: "Invalid email or password." });
    const next = await login(email, OWN, { redirect: "/admin/documents" });
    expect(next.status).toBe(200);
    expect(await body(next)).toEqual({ redirect: "/admin/documents", passwordChangeRequired: false });
    expect(count("memberships", `user_id = '${userId}' AND org_id = '${orgId}' AND role = 'owner'`)).toBe(1);
  });

  it("ends every other sign-in of the account", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");
    const otherDevice = cookieFrom(await login(email, temporary));
    expect((await me(otherDevice)).status).toBe(200);

    await change(cookie, temporary, OWN);

    expect((await me(otherDevice)).status).toBe(401);
    expect((await me(cookie)).status).toBe(401);
  });

  it("makes the person prove the temporary password again, and rate-limits getting it wrong", async () => {
    const { cookie, email } = await firstLogin("Initech");
    for (let i = 0; i < 10; i++) {
      const res = await change(cookie, `not the temporary password ${i}`, OWN);
      expect(res.status).toBe(400);
      expect((await body<{ error: string }>(res)).error).toBe("The current password is not correct.");
    }
    expect((await change(cookie, "one more wrong one!", OWN)).status).toBe(429);
    expect(userRow(email).must_change_password).toBe(1); // nothing changed
  });

  it("enforces the password policy, and refuses to keep the same password", async () => {
    const { cookie, temporary, email } = await firstLogin("Initech");
    const refusals = [
      [temporary, "abc", /at least 4 characters/],
      [temporary, email, /email/i],
      [temporary, temporary, /different from the current/],
      [temporary, "x".repeat(300), null],
    ] as const;
    for (const [current, next, message] of refusals) {
      const res = await change(cookie, current, next);
      expect(res.status, String(next).slice(0, 20)).toBe(400);
      if (message) expect((await body<{ error: string }>(res)).error).toMatch(message);
    }
    expect((await change(cookie, temporary, undefined)).status).toBe(400);
    expect((await call(changePasswordRoute.POST, "/api/auth/change-password", { method: "POST", cookie, json: { currentPassword: temporary, newPassword: OWN, role: "owner" } })).status).toBe(400); // strict
    expect(userRow(email).must_change_password).toBe(1);
    expect((await change(cookie, temporary, OWN)).status).toBe(200); // and the ticket was not wasted by the refusals
  });

  it("needs a session, and refuses cross-site requests", async () => {
    const { cookie, temporary } = await firstLogin("Initech");
    expect((await change(undefined, temporary, OWN)).status).toBe(401);
    expect((await change(cookie, temporary, OWN, { origin: "https://evil.example", host: "localhost:3000" })).status).toBe(403);
    expect(count("users", "must_change_password = 1")).toBe(1);
  });

  it("two changes at once: one wins, the other is refused, and exactly one new password works", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");
    const [a, b] = await Promise.all([change(cookie, temporary, "First new password 1"), change(cookie, temporary, "Second new password 2")]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winners = [(await login(email, "First new password 1")).status, (await login(email, "Second new password 2")).status];
    expect(winners.filter((s) => s === 200)).toHaveLength(1);
  });

  it("records the change without any password in the audit trail or the logs", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");
    await change(cookie, temporary, OWN);

    const rows = audit("action = 'auth.password.change'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_email: email.toLowerCase(), outcome: "success" });
    expect(JSON.parse(rows[0]!.details)).toEqual({ forced: true });
    for (const secret of [temporary, OWN, "scrypt$"]) {
      expect(JSON.stringify(audit())).not.toContain(secret);
      expect(logged()).not.toContain(secret);
    }
  });

  it("works for anyone who is signed in, with the same checks, and then isn't 'forced'", async () => {
    const { email, cookie } = await activated("Initech");
    const res = await change(cookie, OWN, "Yet another new password 7");
    expect(res.status).toBe(200);
    expect(JSON.parse(audit("action = 'auth.password.change'")[1]!.details)).toEqual({ forced: false });
    expect((await login(email, OWN)).status).toBe(401);
    expect((await login(email, "Yet another new password 7")).status).toBe(200);
  });
});

describe("temporary passwords expire and can be revoked", () => {
  it("an expired temporary password is refused at sign-in, with a clear message only to someone who typed it correctly", async () => {
    const { email, temporary } = await createCustomer("Initech");
    db.prepare("UPDATE users SET temp_password_expires_at = '2020-01-01T00:00:00.000Z' WHERE email = ?").run(email);

    const expired = await login(email, temporary);
    expect(expired.status).toBe(403);
    expect(await body(expired)).toEqual({ error: "Your temporary password has expired. Ask your administrator for new credentials.", code: "temporary_password_expired" });
    expect(expired.headers.get("set-cookie")).toBeNull();
    expect(count("auth_sessions", `user_id = '${userRow(email).id}'`)).toBe(0);

    const wrong = await login(email, "a wrong guess entirely");
    expect([wrong.status, await body(wrong)]).toEqual([401, { error: "Invalid email or password." }]); // the expiry is not revealed to a guesser
  });

  it("a sign-in made with a temporary password stops working the moment it expires, mid-session", async () => {
    const { cookie, email, temporary } = await firstLogin("Initech");
    expect((await me(cookie)).status).toBe(200);

    db.prepare("UPDATE users SET temp_password_expires_at = ? WHERE email = ?").run(new Date(Date.now() - 1000).toISOString(), email);

    expect((await me(cookie)).status).toBe(401);
    expect((await change(cookie, temporary, OWN)).status).toBe(401); // nor can the change be completed on that session
    expect(userRow(email).must_change_password).toBe(1);
  });

  it("the Super Admin can revoke it (immediately) and reissue a new one", async () => {
    const { orgId, email, temporary, cookie, userId } = await firstLogin("Initech");
    const revoked = await call(platformCredentialsRoute.POST, `/api/platform/organizations/${orgId}/members/${userId}/credentials`, { method: "POST", cookie: P.cookie, json: { action: "revoke" }, params: { id: orgId, userId } });
    expect(revoked.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    expect((await login(email, temporary)).status).toBe(403);

    const reissued = await call(platformCredentialsRoute.POST, `/api/platform/organizations/${orgId}/members/${userId}/credentials`, { method: "POST", cookie: P.cookie, json: { action: "reissue" }, params: { id: orgId, userId } });
    const { credentials } = await body<{ credentials: { temporaryPassword: string } }>(reissued);
    expect((await login(email, temporary)).status).toBe(401); // the revoked one never comes back
    const again = await login(email, credentials.temporaryPassword);
    expect(again.status).toBe(200);
    expect(await body(again)).toMatchObject({ redirect: "/change-password", passwordChangeRequired: true });
  });

  it("once the customer has chosen their own password nothing can reissue or revoke it", async () => {
    const { orgId, userId, email } = await activated("Initech");
    for (const action of ["reissue", "revoke"]) {
      const res = await call(platformCredentialsRoute.POST, `/api/platform/organizations/${orgId}/members/${userId}/credentials`, { method: "POST", cookie: P.cookie, json: { action }, params: { id: orgId, userId } });
      expect(res.status, action).toBe(409);
    }
    expect((await login(email, OWN)).status).toBe(200); // still theirs
  });

  it("the customer can't touch the credentials endpoints, for themselves or anyone", async () => {
    const { cookie, orgId, userId } = await activated("Initech");
    const res = await call(platformCredentialsRoute.POST, `/api/platform/organizations/${orgId}/members/${userId}/credentials`, { method: "POST", cookie, json: { action: "reissue" }, params: { id: orgId, userId } });
    expect(res.status).toBe(403);
  });
});

describe("disabled users and suspended workspaces", () => {
  it("a disabled customer can't sign in with the temporary password, loses their session, and gets in again when enabled", async () => {
    const { cookie, email, temporary, userId } = await firstLogin("Initech");
    const setStatus = (status: string) => call(platformUserRoute.PATCH, `/api/platform/users/${userId}`, { method: "PATCH", cookie: P.cookie, json: { status }, params: { userId } });

    expect((await setStatus("disabled")).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    const blocked = await login(email, temporary);
    expect([blocked.status, await body(blocked)]).toEqual([401, { error: "Invalid email or password." }]);

    expect((await setStatus("active")).status).toBe(200);
    expect((await login(email, temporary)).status).toBe(200); // the temporary password is still valid and still has to be replaced
  });

  it("a disabled account can't change its password either", async () => {
    const { cookie, temporary, userId, email } = await firstLogin("Initech");
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
    expect((await change(cookie, temporary, OWN)).status).toBe(401);
    expect(userRow(email).must_change_password).toBe(1);
  });

  it("a suspended workspace blocks the temporary password, ends the session and the password change, and reopens on reactivation", async () => {
    const { cookie, orgId, email, temporary } = await firstLogin("Initech");
    const setStatus = (status: string) => call(platformOrgRoute.PATCH, `/api/platform/organizations/${orgId}`, { method: "PATCH", cookie: P.cookie, json: { status }, params: { id: orgId } });

    expect((await setStatus("suspended")).status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
    expect((await change(cookie, temporary, OWN)).status).toBe(401);
    const blocked = await login(email, temporary);
    expect(blocked.status).toBe(403);
    expect(await body(blocked)).toMatchObject({ code: "workspace_suspended" });
    expect(userRow(email).must_change_password).toBe(1);

    expect((await setStatus("active")).status).toBe(200);
    const back = await login(email, temporary);
    expect(back.status).toBe(200);
    expect(await body(back)).toMatchObject({ redirect: "/change-password" });
  });
});

describe("customers stay apart", () => {
  it("a customer who is still on a temporary password can read nothing, and one who has changed it reaches only their own workspace", async () => {
    const a = await firstLogin("Initech");
    const b = await activated("Hooli");

    // A (temporary): locked out of everything, including the other customers' data.
    for (const [route, url] of [[documentsRoute.GET, "/api/documents"], [orgMembersRoute.GET, "/api/org/members"]] as const) {
      const res = await call(route, url, { cookie: a.cookie });
      expect([res.status, (await body<{ code: string }>(res)).code]).toEqual([403, "password_change_required"]);
    }

    // A completes the change: now only Initech.
    const aCookie = cookieFrom(await change(a.cookie, a.temporary, OWN));
    const aMembers = await body<{ members: { email: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie: aCookie }));
    expect(aMembers.members.map((m) => m.email)).toEqual([a.email]);
    const bMembers = await body<{ members: { email: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie: b.cookie }));
    expect(bMembers.members.map((m) => m.email)).toEqual([b.email]);
    const docs = JSON.stringify(await body(await call(documentsRoute.GET, "/api/documents", { cookie: aCookie })));
    expect(docs).not.toMatch(/ACME-SECRET|GLOBEX-PRICING/);

    // Neither can use the Super Admin console, and their passwords are their own.
    for (const cookie of [aCookie, b.cookie]) expect((await call(platformOrgsRoute.GET, "/api/platform/organizations", { cookie })).status).toBe(403);
    expect(userRow(b.email).password_hash).not.toBe(userRow(a.email).password_hash);
    expect((await login(b.email, a.temporary)).status).toBe(401);
    expect((await login(a.email, b.temporary)).status).toBe(401);
  });

  it("changing one customer's password changes only that account", async () => {
    const a = await firstLogin("Initech");
    const b = await firstLogin("Hooli");
    const other = db.prepare("SELECT id, password_hash, must_change_password AS m FROM users WHERE id IN (?, ?, ?)").all(b.userId, O.userId, G.userId);

    await change(a.cookie, a.temporary, OWN);

    expect(db.prepare("SELECT id, password_hash, must_change_password AS m FROM users WHERE id IN (?, ?, ?)").all(b.userId, O.userId, G.userId)).toEqual(other);
    expect((await me(b.cookie)).status).toBe(200); // B's sign-in survives
    expect((await login(b.email, b.temporary)).status).toBe(200); // and B's temporary password still works until B changes it
    expect(count("memberships", `user_id = '${a.userId}'`)).toBe(1);
  });

  it("can't be used to gain a role in another workspace: the account belongs to exactly its own workspace, as owner", async () => {
    const a = await activated("Initech");
    expect(db.prepare("SELECT org_id AS org, role FROM memberships WHERE user_id = ?").all(a.userId)).toEqual([{ org: a.orgId, role: "owner" }]);
    const invite = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: a.cookie, json: { email: fresh("teammate"), role: "owner" } });
    expect(invite.status).toBe(400); // an owner invitation can't be created by a customer
    expect(count("memberships", `org_id = '${globex}'`)).toBe(1);
  });
});

describe("existing customers and data are untouched", () => {
  it("existing accounts keep their own passwords and carry no temporary state", async () => {
    await createCustomer("Initech");
    const existing = db.prepare("SELECT email, password_hash, must_change_password AS m, temp_password_expires_at AS e FROM users WHERE email IN ('owner@acme.test', 'owner@globex.test', 'super@platform.test') ORDER BY email").all();
    expect(existing).toEqual([
      { email: "owner@acme.test", password_hash: "x", m: 0, e: null },
      { email: "owner@globex.test", password_hash: "x", m: 0, e: null },
      { email: "super@platform.test", password_hash: "x", m: 0, e: null },
    ]);
    expect(count("documents")).toBe(2);
  });

  it("a person who already has a real password still signs in exactly as before", async () => {
    const identity = new IdentityRepository(db);
    const u = identity.createUser({ email: "ana@acme.test", passwordHash: await hashPassword("correct horse battery", FAST_PASSWORDS) });
    identity.addMember(acme, u.id, "member");
    const res = await login("ana@acme.test", "correct horse battery", { redirect: "/admin/documents" });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ redirect: "/admin/documents", passwordChangeRequired: false });
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: cookieFrom(res) })).status).toBe(200);
  });
});
