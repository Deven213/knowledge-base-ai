import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isProtectedApi, isProtectedPage, loginUrlFor, safeRedirect, SESSION_COOKIE } from "@/lib/auth-routes";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import { IdentityRepository } from "@/server/auth/identity";
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from "@/server/auth/password";
import { AuthService } from "@/server/auth/service";
import { hashSessionToken, isSessionTokenValid, sessionState } from "@/server/auth/session-lookup";
import { clientIp, FailureThrottle, throttleKeys } from "@/server/auth/throttle";
import { openDatabase } from "@/server/db/client";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import { memoryDb, testConfig } from "./helpers";

/** Cheap scrypt settings: the real cost (about 100 ms per check) is pointless in tests. */
const FAST = { N: 1024, r: 8, p: 1 };

async function world() {
  const db = memoryDb();
  const identity = new IdentityRepository(db);
  const org = identity.createOrganization("Acme");
  const user = identity.createUser({ email: "Ana@Acme.test", passwordHash: await hashPassword("correct horse battery", FAST), displayName: "Ana" });
  identity.addMember(org.id, user.id, "owner");
  const auth = new AuthService(db, testConfig(), FAST);
  return { db, identity, org, user, auth };
}

describe("route rules", () => {
  it("protects the product and its APIs, not the landing page, /login, the invitation page or the sign-in API", () => {
    for (const p of ["/admin", "/admin/documents", "/admin/integrations/website-scraper", "/chat", "/settings/features", "/settings/team", "/app"]) {
      expect(isProtectedPage(p), p).toBe(true);
    }
    for (const p of ["/", "/login", "/invite", "/administrator", "/chatter"]) expect(isProtectedPage(p), p).toBe(false);
    expect(isProtectedApi("/api/documents")).toBe(true);
    expect(isProtectedApi("/api/org/members")).toBe(true);
    expect(isProtectedApi("/api/integrations/google-drive/callback")).toBe(true);
    expect(isProtectedApi("/api/auth/login")).toBe(false);
    expect(isProtectedApi("/api/auth/logout")).toBe(false);
    expect(isProtectedApi("/api/auth/accept-invite")).toBe(false);
  });

  it("only redirects back to product pages on this site (no open redirects)", () => {
    expect(safeRedirect("/admin/documents")).toBe("/admin/documents");
    expect(safeRedirect("/chat?x=1")).toBe("/chat?x=1");
    for (const bad of [null, "", "https://evil.example/admin", "//evil.example/admin", "/\\evil.example", "javascript:alert(1)", "/login", "/", "/admin\u0000x"]) {
      expect(safeRedirect(bad), String(bad)).toBe("/admin");
    }
    expect(loginUrlFor("/admin/documents")).toBe("/login?redirect=/admin/documents");
    expect(loginUrlFor("/admin")).toBe("/login?redirect=/admin");
  });
});

describe("password hashing", () => {
  it("never stores the password, salts every hash, and verifies in constant time", async () => {
    const a = await hashPassword("correct horse battery", FAST);
    const b = await hashPassword("correct horse battery", FAST);
    expect(a).toMatch(/^scrypt\$1024\$8\$1\$/);
    expect(a).not.toContain("correct horse");
    expect(a).not.toBe(b); // different salt each time
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("correct horse batterY", a)).toBe(false);
    expect(await verifyPassword("", a)).toBe(false);
  });

  it("rejects malformed or dangerous stored hashes instead of crashing", async () => {
    for (const bad of ["", "plain", "scrypt$1$2$3$x$y", "scrypt$1000000000$8$1$AAAA$AAAA", "scrypt$1024$8$1$$", "bcrypt$1024$8$1$AAAA$AAAA"]) {
      expect(await verifyPassword("whatever", bad), bad).toBe(false);
    }
  });

  it("checks a password policy and a fake hash for unknown users", async () => {
    expect(passwordProblem("abc", "a@b.test")).toMatch(/at least 4/);
    expect(passwordProblem("", "a@b.test")).toMatch(/at least 4/);
    expect(passwordProblem("abcd", "a@b.test")).toBeNull(); // the shortest allowed
    expect(passwordProblem("short", "a@b.test")).toBeNull();
    expect(passwordProblem("a@b.test    ", "a@b.test")).toMatch(/email/);
    expect(passwordProblem("aaaaaaaaaaaa", "a@b.test")).toMatch(/repetitive/);
    expect(passwordProblem("x".repeat(201), "a@b.test")).toMatch(/at most/);
    expect(passwordProblem("correct horse battery", "a@b.test")).toBeNull();
    expect(await burnPasswordCheck("anything", FAST)).toBeNull();
  });
});

describe("signing in", () => {
  it("accepts the right email (any case) and password, and returns nothing useful otherwise", async () => {
    const { auth, user } = await world();
    expect((await auth.authenticate("  ana@acme.TEST ", "correct horse battery"))?.id).toBe(user.id);
    expect(await auth.authenticate("ana@acme.test", "wrong password!!")).toBeNull();
    expect(await auth.authenticate("nobody@acme.test", "correct horse battery")).toBeNull();
    expect(await auth.authenticate(undefined, undefined)).toBeNull();
    expect(await auth.authenticate("ana@acme.test", "x".repeat(5000))).toBeNull(); // oversized input is refused cheaply
  });

  it("refuses a disabled account even with the right password", async () => {
    const { auth, db, user } = await world();
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    expect(await auth.authenticate("ana@acme.test", "correct horse battery")).toBeNull();
  });

  it("has no built-in demo account or default password: it exists only when its password is configured", async () => {
    const { db } = await world();
    expect(new AuthService(db, testConfig({ DEMO_USER_PASSWORD: undefined }), FAST).demoEnabled).toBe(false);
    expect(new AuthService(db, testConfig({ DEMO_USER_PASSWORD: "x-demo-password-1" }), FAST).demoEnabled).toBe(true);
    expect(testConfig().DEMO_USER_PASSWORD).toBeUndefined();
  });
});

describe("server-side sessions", () => {
  it("binds a session to a user AND an organization, stores only a hash, and ends on logout", async () => {
    const { db, auth, user, org } = await world();
    const { token, expiresAt } = auth.createSession(user.id, org.id);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(auth.getSession(token)).toMatchObject({ userId: user.id, orgId: org.id, role: "owner", email: "ana@acme.test", isPlatformAdmin: false });
    expect(isSessionTokenValid(token, db)).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM auth_sessions").all())).not.toContain(token);

    auth.deleteSession(token);
    expect(auth.getSession(token)).toBeNull();
    expect(isSessionTokenValid(token, db)).toBe(false);
  });

  it("can only start a session in an organization the user belongs to", async () => {
    const { auth, user, identity } = await world();
    const other = identity.createOrganization("Other");
    expect(() => auth.createSession(user.id, other.id)).toThrow(/not an active member/);
    expect(() => auth.createSession("no-such-user", other.id)).toThrow();
  });

  it("stops working the moment membership is removed or the account is disabled", async () => {
    const { auth, db, identity, user, org } = await world();
    const second = identity.createUser({ email: "bo@acme.test", passwordHash: "x" });
    identity.addMember(org.id, second.id, "member");
    const { token } = auth.createSession(second.id, org.id);
    expect(auth.getSession(token)?.role).toBe("member");

    identity.removeMember(org.id, second.id);
    expect(auth.getSession(token)).toBeNull();

    identity.addMember(org.id, second.id, "member");
    const again = auth.createSession(second.id, org.id).token;
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(second.id);
    expect(auth.getSession(again)).toBeNull();
    expect(user.id).not.toBe(second.id);
  });

  it("reflects a changed role immediately", async () => {
    const { auth, identity, org } = await world();
    const bo = identity.createUser({ email: "bo@acme.test", passwordHash: "x" });
    identity.addMember(org.id, bo.id, "admin");
    const { token } = auth.createSession(bo.id, org.id);
    identity.changeRole(org.id, bo.id, "viewer");
    expect(auth.getSession(token)?.role).toBe("viewer");
  });

  it("switches organization only to one the user belongs to", async () => {
    const { auth, identity, user, org } = await world();
    const second = identity.createOrganization("Second");
    const stranger = identity.createOrganization("Stranger");
    identity.addMember(second.id, user.id, "member");
    const { token } = auth.createSession(user.id, org.id);

    expect(auth.switchOrganization(token, second.id)).toBe(true);
    expect(auth.getSession(token)).toMatchObject({ orgId: second.id, role: "member" });
    expect(auth.switchOrganization(token, stranger.id)).toBe(false);
    expect(auth.getSession(token)?.orgId).toBe(second.id); // unchanged
  });

  it("rejects expired, unknown and malformed tokens", async () => {
    const { db, auth, user, org } = await world();
    const { token } = auth.createSession(user.id, org.id);
    db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(hashSessionToken(token));
    expect(auth.getSession(token)).toBeNull();
    expect(isSessionTokenValid(token, db)).toBe(false);
    expect(isSessionTokenValid("x".repeat(43), db)).toBe(false);
    expect(isSessionTokenValid("not a token", db)).toBe(false);
    expect(isSessionTokenValid(undefined, db)).toBe(false);
  });
});

describe("sign-in throttling", () => {
  it("blocks after 10 failures per key and unblocks when the window passes", () => {
    let now = 1_000_000;
    const throttle = new FailureThrottle(10, 15 * 60_000, () => now);
    const keys = ["acct:ana@acme.test"];
    for (let i = 0; i < 9; i++) throttle.recordFailure(keys);
    expect(throttle.isBlocked(keys)).toBe(false);
    throttle.recordFailure(keys);
    expect(throttle.isBlocked(keys)).toBe(true);
    expect(throttle.isBlocked(["acct:someone-else@acme.test"])).toBe(false);
    now += 15 * 60_000 + 1;
    expect(throttle.isBlocked(keys)).toBe(false);
  });

  it("ignores X-Forwarded-For unless the number of trusted proxies is known, and then uses the entry the proxy added", () => {
    const req = (xff: string) => new Request("http://x.test/", { headers: { "x-forwarded-for": xff } });
    // A client can put anything on the left; with no trusted proxy the header must not be used at all.
    expect(clientIp(req("1.1.1.1"), 0)).toBeNull();
    expect(throttleKeys(req("6.6.6.6"), 0, "a@b.test")).toEqual(["acct:a@b.test"]);
    // One trusted proxy appends the address it saw: the LAST entry, whatever the client claimed before it.
    expect(clientIp(req("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(req("6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(req("203.0.113.9"), 2)).toBeNull(); // fewer entries than trusted hops: don't guess
  });

  it("stays bounded in memory", () => {
    let now = 0;
    const throttle = new FailureThrottle(10, 1000, () => now);
    for (let i = 0; i < 6000; i++) throttle.recordFailure([`acct:${i}@x.test`]);
    now = 5000;
    throttle.recordFailure(["acct:trigger@x.test"]); // prunes the expired entries
    expect(throttle.isBlocked(["acct:1@x.test"])).toBe(false);
  });
});

describe("bootstrap", () => {
  const owner = { BOOTSTRAP_OWNER_EMAIL: "Owner@Acme.test", BOOTSTRAP_OWNER_PASSWORD: "a long owner passphrase", BOOTSTRAP_OWNER_NAME: "Olivia", DEMO_USER_EMAIL: "demo@knowledgebase.ai", DEMO_USER_PASSWORD: undefined } as const;

  it("creates the first owner, hands over the Default workspace and the author-less conversations, and makes them platform admin", async () => {
    const db = memoryDb();
    db.prepare("INSERT INTO conversations (id, title, org_id) VALUES ('legacy-chat', 'Old chat', ?)").run(LEGACY_ORG_ID);

    const summary = await ensureBootstrap(db, owner, FAST);

    expect(summary).toMatchObject({ owner: "created", demo: "disabled", legacyWorkspaceUnowned: false });
    const identity = new IdentityRepository(db);
    const user = identity.findUserByEmail("owner@acme.test")!;
    expect(user.is_platform_admin).toBe(1);
    expect(identity.getMembership(LEGACY_ORG_ID, user.id)?.role).toBe("owner");
    expect((db.prepare("SELECT user_id FROM conversations WHERE id = 'legacy-chat'").get() as { user_id: string }).user_id).toBe(user.id);
    expect(await verifyPassword("a long owner passphrase", user.password_hash)).toBe(true);
    expect(user.password_hash).not.toContain("passphrase");
  });

  it("is safe to repeat and never undoes later changes to who owns the workspace", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined); // the owner stepped down, so startup (rightly) says they can no longer sign in
    const db = memoryDb();
    await ensureBootstrap(db, owner, FAST);
    const identity = new IdentityRepository(db);
    const user = identity.findUserByEmail("owner@acme.test")!;
    const bo = identity.createUser({ email: "bo@acme.test", passwordHash: "x" });
    identity.addMember(LEGACY_ORG_ID, bo.id, "owner");
    identity.removeMember(LEGACY_ORG_ID, user.id); // the first owner steps down

    expect(await ensureBootstrap(db, owner, FAST)).toMatchObject({ owner: "existing" });
    expect(identity.getMembership(LEGACY_ORG_ID, user.id)).toBeUndefined(); // not re-added: the workspace already has an owner
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'owner@acme.test'").get() as { n: number }).n).toBe(1);
  });

  it("refuses a weak bootstrap password instead of creating a weak owner", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = memoryDb();
    const summary = await ensureBootstrap(db, { ...owner, BOOTSTRAP_OWNER_PASSWORD: "abc" }, FAST);
    expect(summary.owner).toBe("rejected");
    expect(new IdentityRepository(db).findUserByEmail("owner@acme.test")).toBeUndefined();
  });

  it("warns when the Default workspace holds data nobody can open", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = memoryDb();
    db.prepare("INSERT INTO documents (id, filename, mime_type, size_bytes, status, org_id) VALUES ('d', 'x', 'x', 1, 'ready', ?)").run(LEGACY_ORG_ID);
    const summary = await ensureBootstrap(db, { ...owner, BOOTSTRAP_OWNER_EMAIL: undefined, BOOTSTRAP_OWNER_PASSWORD: undefined }, FAST);
    expect(summary.legacyWorkspaceUnowned).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("has no owner"));
  });

  it("creates the demo account only when its password is set, in its OWN workspace (never the customers')", async () => {
    const db = memoryDb();
    const identity = new IdentityRepository(db);
    expect(await ensureBootstrap(db, owner, FAST)).toMatchObject({ demo: "disabled" });
    expect(identity.findUserByEmail("demo@knowledgebase.ai")).toBeUndefined();

    const summary = await ensureBootstrap(db, { ...owner, DEMO_USER_PASSWORD: "a public demo password" }, FAST);
    expect(summary.demo).toBe("created");
    const demo = identity.findUserByEmail("demo@knowledgebase.ai")!;
    expect(demo.is_platform_admin).toBe(0);
    const orgs = identity.organizationsOf(demo.id);
    expect(orgs.map((o) => o.name)).toEqual(["Demo workspace"]);
    expect(orgs.some((o) => o.orgId === LEGACY_ORG_ID)).toBe(false);

    // Changing the password in the environment takes effect.
    await ensureBootstrap(db, { ...owner, DEMO_USER_PASSWORD: "a different demo password" }, FAST);
    expect(await verifyPassword("a different demo password", identity.findUserByEmail("demo@knowledgebase.ai")!.password_hash)).toBe(true);
  });

  it("never repurposes a real account as the demo account (no password overwrite, no move into the public demo workspace)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const db = memoryDb();
    await ensureBootstrap(db, owner, FAST);
    const identity = new IdentityRepository(db);
    const ownerHashBefore = identity.findUserByEmail("owner@acme.test")!.password_hash;

    const summary = await ensureBootstrap(db, { ...owner, DEMO_USER_EMAIL: "OWNER@acme.test", DEMO_USER_PASSWORD: "a public demo password" }, FAST);

    expect(summary.demo).toBe("skipped");
    // The real owner's account is untouched: same password, still only in their own workspace.
    expect(identity.findUserByEmail("owner@acme.test")!.password_hash).toBe(ownerHashBefore);
    expect(identity.organizationsOf(identity.findUserByEmail("owner@acme.test")!.id).map((o) => o.orgId)).toEqual([LEGACY_ORG_ID]);
  });
});

describe("what the request gate knows about a session", () => {
  const FAST_AUTH = { N: 1024, r: 8, p: 1 };
  const setup = () => {
    const db = memoryDb();
    const identity = new IdentityRepository(db);
    const auth = new AuthService(db, testConfig(), FAST_AUTH);
    const org = identity.createOrganization("Acme");
    const make = (email: string, temporaryUntil?: string) => {
      const user = identity.createUser({ email, passwordHash: "x", temporaryUntil });
      identity.addMember(org.id, user.id, "owner");
      return { user, token: auth.createSession(user.id, org.id).token };
    };
    return { db, auth, identity, make };
  };

  it("tells a normal session, a session that must change its password, and no session apart", () => {
    const { db, make } = setup();
    expect(sessionState(make("a@acme.test").token, db)).toBe("ok");
    expect(sessionState(make("b@acme.test", new Date(Date.now() + 60_000).toISOString()).token, db)).toBe("password_change_required");
    expect(sessionState("x".repeat(43), db)).toBe("none");
    expect(sessionState(undefined, db)).toBe("none");
  });

  it("ends a session the moment its temporary password expires, and the application's own lookup agrees", () => {
    const { db, auth, make } = setup();
    const { user, token } = make("a@acme.test", new Date(Date.now() + 60_000).toISOString());
    expect(auth.getSession(token)?.mustChangePassword).toBe(true);

    db.prepare("UPDATE users SET temp_password_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1).toISOString(), user.id);

    expect(sessionState(token, db)).toBe("none");
    expect(auth.getSession(token)).toBeNull();
    expect(() => auth.createSession(user.id, auth.identity.organizationsOf(user.id)[0]!.orgId)).toThrow(/Cannot start a session/);
  });

  it("an expired temporary password is reported (after the right password only) and a replaced one is not", async () => {
    const { auth, identity, db } = setup();
    const user = identity.createUser({ email: "a@acme.test", passwordHash: await hashPassword("a long enough password", FAST_AUTH), temporaryUntil: new Date(Date.now() + 60_000).toISOString() });
    identity.addMember(identity.createOrganization("Beta").id, user.id, "owner");
    expect(auth.temporaryPasswordExpired((await auth.authenticate("a@acme.test", "a long enough password"))!)).toBe(false);
    db.prepare("UPDATE users SET temp_password_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(user.id);
    expect(auth.temporaryPasswordExpired((await auth.authenticate("a@acme.test", "a long enough password"))!)).toBe(true);
    expect(await auth.authenticate("a@acme.test", "not the password")).toBeNull(); // a wrong password learns nothing
    identity.setOwnPassword(user.id, await hashPassword("my own new password", FAST_AUTH), new Date().toISOString());
    expect(auth.temporaryPasswordExpired((await auth.authenticate("a@acme.test", "my own new password"))!)).toBe(false);
    expect(await auth.authenticate("a@acme.test", "a long enough password")).toBeNull(); // the temporary one is gone for good
  });
});

describe("request proxy", () => {
  let dir: string;
  let token: string;
  let tempToken: string; // the account only has a temporary password
  let expiredToken: string; // its temporary password has run out
  let disabledToken: string;
  let proxy: (req: NextRequest) => Response;

  beforeAll(async () => {
    // The proxy reads the real database file from DATA_DIR (read-only).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-auth-"));
    process.env.DATA_DIR = dir;
    const db = openDatabase(path.join(dir, "kb.sqlite"));
    const identity = new IdentityRepository(db);
    const org = identity.createOrganization("Acme");
    const user = identity.createUser({ email: "ana@acme.test", passwordHash: "x" });
    identity.addMember(org.id, user.id, "owner");
    token = new AuthService(db, testConfig(), FAST).createSession(user.id, org.id).token;
    const auth = new AuthService(db, testConfig(), FAST);
    const temp = identity.createUser({ email: "new@acme.test", passwordHash: "x", temporaryUntil: new Date(Date.now() + 3600_000).toISOString() });
    identity.addMember(org.id, temp.id, "owner");
    tempToken = auth.createSession(temp.id, org.id).token;
    const lapsed = identity.createUser({ email: "lapsed@acme.test", passwordHash: "x", temporaryUntil: new Date(Date.now() + 3600_000).toISOString() });
    identity.addMember(org.id, lapsed.id, "owner");
    expiredToken = auth.createSession(lapsed.id, org.id).token;
    db.prepare("UPDATE users SET temp_password_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(lapsed.id);
    const gone = identity.createUser({ email: "gone@acme.test", passwordHash: "x" });
    identity.addMember(org.id, gone.id, "member");
    disabledToken = auth.createSession(gone.id, org.id).token;
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(gone.id); // (a bare UPDATE, so the session row is still there)
    db.close();
    proxy = (await import("@/proxy")).proxy;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  const request = (url: string, withSession = false) =>
    new NextRequest(new URL(url, "http://localhost:3000"), withSession ? { headers: { cookie: `${SESSION_COOKIE}=${token}` } } : undefined);

  it("sends signed-out visitors of product pages to /login with the page to return to", () => {
    const res = proxy(request("/admin/documents"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login?redirect=/admin/documents");
    expect(proxy(request("/chat")).headers.get("location")).toContain("/login?redirect=/chat");
  });

  it("answers signed-out API calls with 401 (no data)", async () => {
    const res = proxy(request("/api/documents"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("lets a valid session through, and leaves public routes alone", () => {
    expect(proxy(request("/admin/documents", true)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/documents", true)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/auth/login")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/login")).headers.get("x-middleware-next")).toBe("1");
  });

  it("the proxy is invoked for every protected page prefix (a prefix missing from its matcher would skip the gate)", async () => {
    const { config } = await import("@/proxy");
    const { PROTECTED_PAGE_PREFIXES } = await import("@/lib/auth-routes");
    for (const prefix of PROTECTED_PAGE_PREFIXES) expect(config.matcher, prefix).toContain(`${prefix}/:path*`);
    expect(config.matcher).toContain("/api/:path*");
  });

  it("sends signed-out visitors of the Super Admin console to /login", () => {
    expect(proxy(request("/platform")).headers.get("location")).toContain("/login?redirect=/platform");
    expect(proxy(request("/api/platform/organizations")).status).toBe(401);
  });

  const as = (url: string, value: string) => new NextRequest(new URL(url, "http://localhost:3000"), { headers: { cookie: `${SESSION_COOKIE}=${value}` } });

  it("sends someone who still has a temporary password to the password page from every product page", () => {
    for (const page of ["/admin", "/admin/documents", "/chat", "/settings/team", "/platform", "/app"]) {
      const res = proxy(as(page, tempToken));
      expect(res.status, page).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname, page).toBe("/change-password");
    }
    expect(proxy(as("/change-password", tempToken)).headers.get("x-middleware-next")).toBe("1"); // the one page they may open
  });

  it("answers every product API with 403 for someone who still has a temporary password, and leaves the sign-in routes alone", async () => {
    for (const api of ["/api/documents", "/api/ask", "/api/org/members", "/api/platform/organizations", "/api/stats"]) {
      const res = proxy(as(api, tempToken));
      expect(res.status, api).toBe(403);
      expect(await res.json()).toMatchObject({ code: "password_change_required" });
    }
    for (const api of ["/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/login"]) {
      expect(proxy(as(api, tempToken)).headers.get("x-middleware-next"), api).toBe("1"); // these routes enforce the rule themselves
    }
    expect(proxy(as("/admin", token)).headers.get("x-middleware-next")).toBe("1"); // an ordinary session is not affected
  });

  it("treats an expired temporary password and a disabled account as signed out", async () => {
    for (const value of [expiredToken, disabledToken]) {
      const page = proxy(as("/admin", value));
      expect(page.status).toBe(307);
      expect(new URL(page.headers.get("location")!).pathname).toBe("/login");
      expect((await proxy(as("/api/documents", value)).json()).code).toBe("unauthenticated");
    }
  });

  it("a forged cookie does not get in", () => {
    const forged = new NextRequest(new URL("/admin", "http://localhost:3000"), { headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` } });
    expect(proxy(forged).status).toBe(307);
  });
});
