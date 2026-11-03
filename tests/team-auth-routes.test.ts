import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import { IdentityRepository } from "@/server/auth/identity";
import { hashPassword } from "@/server/auth/password";
import { resetConfigForTests } from "@/server/config";
import { body, call, FAST_PASSWORDS, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
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

import * as acceptRoute from "@/app/api/auth/accept-invite/route";
import * as demoRoute from "@/app/api/auth/demo/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as switchRoute from "@/app/api/auth/switch-org/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as invitationRoute from "@/app/api/org/invitations/[id]/route";
import * as invitationsRoute from "@/app/api/org/invitations/route";
import * as memberRoute from "@/app/api/org/members/[userId]/route";
import * as membersRoute from "@/app/api/org/members/route";

const PASSWORD = "correct horse battery";
let db: Database.Database;
let acme: string;
let globex: string;
let O: Seeded; // owner of Acme
let D: Seeded; // admin of Acme
let M: Seeded; // member of Acme
let V: Seeded; // viewer of Acme
let G: Seeded; // owner of Globex

let counter = 0;
/** A unique email per test, because the sign-in throttle is process-wide. */
const fresh = (prefix: string) => `${prefix}-${++counter}@acme.test`;

const setCookieOf = (res: Response) => res.headers.get("set-cookie") ?? "";
const cookieFrom = (res: Response) => setCookieOf(res).split(";")[0]!;

async function user(email: string, extra: { status?: "disabled" } = {}) {
  const identity = new IdentityRepository(db);
  const u = identity.createUser({ email, passwordHash: await hashPassword(PASSWORD, FAST_PASSWORDS), displayName: "Test" });
  if (extra.status) db.prepare("UPDATE users SET status = ? WHERE id = ?").run(extra.status, u.id);
  return u;
}
const login = (email: unknown, password: unknown = PASSWORD, headers: Record<string, string> = {}) =>
  call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email, password }, headers });

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  db = memoryDb();
  h.db = db;
  acme = seedOrganization(db, "Acme");
  globex = seedOrganization(db, "Globex");
  O = seedMember(db, acme, "owner@acme.test", "owner");
  D = seedMember(db, acme, "admin@acme.test", "admin");
  M = seedMember(db, acme, "member@acme.test", "member");
  V = seedMember(db, acme, "viewer@acme.test", "viewer");
  G = seedMember(db, globex, "owner@globex.test", "owner");
});

describe("signing in", () => {
  it("signs in with the right email (any case) and password, sets a hardened session cookie, and lands in the person's workspace", async () => {
    const email = fresh("ana");
    const u = await user(email);
    new IdentityRepository(db).addMember(acme, u.id, "member");

    const res = await login(email.toUpperCase());

    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ redirect: "/admin", passwordChangeRequired: false });
    const cookie = setCookieOf(res);
    expect(cookie).toMatch(/^kb_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);

    const me = await body<{ user: { email: string }; organization: { id: string; role: string } }>(await call(meRoute.GET, "/api/auth/me", { cookie: cookieFrom(res) }));
    expect(me.user.email).toBe(email);
    expect(me.organization).toMatchObject({ id: acme, role: "member" });
  });

  it("gives the identical answer for a wrong password, an unknown email, a disabled account and (with a wrong password) an account with no workspace", async () => {
    const real = fresh("real");
    const u = await user(real);
    new IdentityRepository(db).addMember(acme, u.id, "member");
    const disabled = fresh("disabled");
    const d = await user(disabled, { status: "disabled" });
    new IdentityRepository(db).addMember(acme, d.id, "member");
    const homeless = fresh("homeless");
    await user(homeless); // no membership anywhere

    const answers = [await login(real, "wrong password!!"), await login(fresh("nobody")), await login(disabled), await login(homeless, "wrong password!!")];

    for (const res of answers) {
      expect(res.status).toBe(401);
      expect(await body(res)).toEqual({ error: "Invalid email or password." });
      expect(setCookieOf(res)).toBe("");
    }
  });

  it("tells someone who typed the RIGHT password that their account belongs to no workspace, instead of a message that looks like a wrong password", async () => {
    const homeless = fresh("homeless");
    await user(homeless); // no membership anywhere: for example an address added to .env after the first owner existed

    const res = await login(homeless);

    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({ code: "no_workspace", error: expect.stringMatching(/doesn't belong to any workspace/) });
    expect(setCookieOf(res)).toBe(""); // no session
    // The same holds for the failure counter: a right password is not a failed attempt.
    for (let i = 0; i < 12; i++) expect((await login(homeless)).status).toBe(403);
  });

  it("treats malformed requests like any other failed sign-in", async () => {
    const res = await call(loginRoute.POST, "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, form: undefined });
    expect(res.status).toBe(401);
    expect((await login(12345, { not: "a string" })).status).toBe(401);
  });

  it("locks an account after 10 wrong passwords, even for the right one, and spoofed X-Forwarded-For values don't help", async () => {
    const email = fresh("victim");
    const u = await user(email);
    new IdentityRepository(db).addMember(acme, u.id, "member");
    for (let i = 0; i < 10; i++) {
      expect((await login(email, "wrong password!!", { "x-forwarded-for": `6.6.6.${i}` })).status).toBe(401); // a new fake address each time
    }

    const locked = await login(email, PASSWORD, { "x-forwarded-for": "7.7.7.7" });
    expect(locked.status).toBe(429);
    expect((await login(fresh("someone-else"))).status).toBe(401); // other accounts are unaffected
  });

  it("rejects cross-site sign-in attempts", async () => {
    const res = await call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email: "a@b.test", password: "x" }, headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("ends the session on logout, on the server", async () => {
    const email = fresh("ana");
    const u = await user(email);
    new IdentityRepository(db).addMember(acme, u.id, "member");
    const cookie = cookieFrom(await login(email));
    expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(200);

    const res = await call(logoutRoute.POST, "/api/auth/logout", { method: "POST", cookie });
    expect(res.status).toBe(303);
    expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(401); // the old cookie is dead, not just cleared
  });
});

describe("the demo account", () => {
  const form = () => {
    const f = new FormData();
    f.append("redirect", "/admin");
    return f;
  };
  afterAll(() => {
    for (const k of ["DEMO_USER_PASSWORD", "DEMO_SHOW_CREDENTIALS", "DEMO_USER_EMAIL"]) delete process.env[k];
    resetConfigForTests();
  });

  it("does not exist unless it is deliberately enabled", async () => {
    for (const k of ["DEMO_USER_PASSWORD", "DEMO_SHOW_CREDENTIALS"]) delete process.env[k];
    resetConfigForTests();
    expect((await call(demoRoute.POST, "/api/auth/demo", { method: "POST", form: form() })).status).toBe(404);
  });

  it("signs in to its OWN workspace and can't see any customer's data", async () => {
    Object.assign(process.env, { DEMO_USER_PASSWORD: "a public demo password", DEMO_SHOW_CREDENTIALS: "true", DEMO_USER_EMAIL: "demo@knowledgebase.ai" });
    resetConfigForTests();
    await ensureBootstrap(db, { BOOTSTRAP_OWNER_EMAIL: undefined, BOOTSTRAP_OWNER_PASSWORD: undefined, BOOTSTRAP_OWNER_NAME: undefined, DEMO_USER_EMAIL: "demo@knowledgebase.ai", DEMO_USER_PASSWORD: "a public demo password" }, FAST_PASSWORDS);
    db.prepare("INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, status) VALUES ('secret-doc', ?, 'Acme secrets.txt', 'text/plain', 1, 'ready')").run(acme);

    const res = await call(demoRoute.POST, "/api/auth/demo", { method: "POST", form: form() });

    expect(res.status).toBe(303);
    const cookie = cookieFrom(res);
    const me = await body<{ organization: { name: string; role: string }; organizations: unknown[]; user: { isPlatformAdmin: boolean } }>(await call(meRoute.GET, "/api/auth/me", { cookie }));
    expect(me.organization.name).toBe("Demo workspace");
    expect(me.organizations).toHaveLength(1);
    expect(me.user.isPlatformAdmin).toBe(false);
    const docs = await body<{ documents: unknown[] }>(await call(documentsRoute.GET, "/api/documents", { cookie }));
    expect(docs.documents).toEqual([]);
    expect(JSON.stringify(docs)).not.toContain("Acme secrets");
  });
});

describe("who am I, and switching workspace", () => {
  it("reports the caller, the workspace and the permissions, and nothing about anyone else", async () => {
    const asViewer = await body<{ permissions: string[]; user: { email: string } }>(await call(meRoute.GET, "/api/auth/me", { cookie: V.cookie }));
    expect(asViewer.user.email).toBe("viewer@acme.test");
    expect(asViewer.permissions).toEqual(["chat", "documents:read"]);
    const asOwner = await body<{ permissions: string[] }>(await call(meRoute.GET, "/api/auth/me", { cookie: O.cookie }));
    expect(asOwner.permissions).toContain("members:manage");
    expect((asViewer as unknown as { passwordChangeRequired: boolean }).passwordChangeRequired).toBe(false);
    expect(JSON.stringify(asViewer)).not.toMatch(/password_hash|passwordHash|scrypt|globex/i);
  });

  it("switches only to a workspace the person belongs to; anything else is 'not found'", async () => {
    const both = seedMember(db, globex, "owner@acme.test", "viewer"); // the Acme owner is also a viewer in Globex
    const res = await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie: O.cookie, json: { orgId: globex } });
    expect(res.status).toBe(200);
    expect((await body<{ organization: { id: string; role: string } }>(res)).organization).toMatchObject({ id: globex, role: "viewer" });
    expect(both.userId).toBe(O.userId);

    const third = seedOrganization(db, "Initech");
    const denied = await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie: M.cookie, json: { orgId: third } });
    expect(denied.status).toBe(404);
    expect((await body<{ organization: { id: string } }>(await call(meRoute.GET, "/api/auth/me", { cookie: M.cookie }))).organization.id).toBe(acme);
    expect((await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie: M.cookie, json: { orgId: "not-a-uuid" } })).status).toBe(400);
  });
});

describe("invitations", () => {
  const invite = (who: Seeded, email: string, role: string) => call(invitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: who.cookie, json: { email, role } });
  const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;
  const accept = (json: unknown, cookie?: string) => call(acceptRoute.POST, "/api/auth/accept-invite", { method: "POST", json, cookie });

  it("creates a single-use link that is shown once, stores only its hash, and never grants ownership", async () => {
    const email = fresh("newbie");
    const res = await invite(D, email, "member");
    expect(res.status).toBe(201);
    const data = await body<{ invitation: { email: string; role: string; status: string }; url: string }>(res);
    expect(data.url).toMatch(/^http:\/\/localhost:3000\/invite\?token=[A-Za-z0-9_-]{43}$/);
    expect(data.invitation).toMatchObject({ email, role: "member", status: "pending" });

    const token = tokenOf(data.url);
    expect(JSON.stringify(db.prepare("SELECT * FROM invitations").all())).not.toContain(token);
    const listed = await body<{ invitations: unknown[] }>(await call(invitationsRoute.GET, "/api/org/invitations", { cookie: O.cookie }));
    expect(JSON.stringify(listed)).not.toContain(token); // the link can't be shown again

    expect((await invite(O, fresh("x"), "owner")).status).toBe(400); // an invitation can never grant ownership
  });

  it("a new person accepts with a strong password, gets an account in the inviting workspace with the invited role, and the link is used up", async () => {
    const email = fresh("newbie");
    const { url } = await body<{ url: string }>(await invite(D, email, "member"));
    const token = tokenOf(url);

    const peek = await body<{ organization: string; email: string; role: string; hasAccount: boolean }>(await call(acceptRoute.GET, `/api/auth/accept-invite?token=${token}`));
    expect(peek).toEqual({ organization: "Acme", email, role: "member", hasAccount: false });

    expect((await accept({ token, password: "abc" })).status).toBe(400); // weak password: nothing is consumed
    expect((await call(acceptRoute.GET, `/api/auth/accept-invite?token=${token}`)).status).toBe(200);

    const res = await accept({ token, password: "a long enough password", name: "Newbie" });
    expect(res.status).toBe(200);
    const me = await body<{ organization: { id: string; role: string }; user: { email: string; displayName: string } }>(await call(meRoute.GET, "/api/auth/me", { cookie: cookieFrom(res) }));
    expect(me.user).toMatchObject({ email, displayName: "Newbie" });
    expect(me.organization).toMatchObject({ id: acme, role: "member" });
    expect((await login(email, "a long enough password")).status).toBe(200); // the new account really works

    expect((await accept({ token, password: "a long enough password" })).status).toBe(404); // single use
    expect((await call(acceptRoute.GET, `/api/auth/accept-invite?token=${token}`)).status).toBe(404);
  });

  it("an existing account must be signed in as the invited address, and then joins without a new password", async () => {
    const { url } = await body<{ url: string }>(await invite(O, "owner@globex.test", "viewer")); // Globex's owner is invited to Acme
    const token = tokenOf(url);

    expect((await accept({ token })).status).toBe(401); // not signed in
    expect((await accept({ token }, M.cookie)).status).toBe(403); // signed in as someone else
    expect((await accept({ token, password: "a long enough password" })).status).toBe(401); // a password can't be used to take over an existing account

    const res = await accept({ token }, G.cookie);
    expect(res.status).toBe(200);
    const me = await body<{ organization: { id: string; role: string }; organizations: { id: string }[] }>(await call(meRoute.GET, "/api/auth/me", { cookie: cookieFrom(res) }));
    expect(me.organization).toMatchObject({ id: acme, role: "viewer" });
    expect(me.organizations.map((o) => o.id).sort()).toEqual([acme, globex].sort());
  });

  it("expired, revoked, used, malformed and made-up links all look the same and change nothing", async () => {
    const expired = await body<{ url: string; invitation: { id: string } }>(await invite(O, fresh("a"), "member"));
    db.prepare("UPDATE invitations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(expired.invitation.id);
    const revoked = await body<{ url: string; invitation: { id: string } }>(await invite(O, fresh("b"), "member"));
    expect((await call(invitationRoute.DELETE, "/x", { method: "DELETE", cookie: O.cookie, params: { id: revoked.invitation.id } })).status).toBe(204);

    const membersBefore = (db.prepare("SELECT COUNT(*) AS n FROM memberships").get() as { n: number }).n;
    const usersBefore = (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const responses = [
      await accept({ token: tokenOf(expired.url), password: "a long enough password" }),
      await accept({ token: tokenOf(revoked.url), password: "a long enough password" }),
      await accept({ token: "x".repeat(43), password: "a long enough password" }),
      await accept({ token: "short", password: "a long enough password" }),
    ];
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(await body(res)).toEqual({ error: "This invitation link is invalid or has expired." });
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM memberships").get() as { n: number }).n).toBe(membersBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n).toBe(usersBefore);
  });

  it("only people who can manage members may invite, and nobody above their own role", async () => {
    expect((await invite(V, fresh("x"), "viewer")).status).toBe(403);
    expect((await invite(M, fresh("x"), "viewer")).status).toBe(403);
    expect((await invite(D, fresh("x"), "admin")).status).toBe(201); // an admin may invite another admin, not an owner
  });

  it("refuses to invite someone who is already a member", async () => {
    expect((await invite(O, "member@acme.test", "viewer")).status).toBe(409);
  });

  it("a second invitation for the same address replaces the first", async () => {
    const email = fresh("twice");
    const first = tokenOf((await body<{ url: string }>(await invite(O, email, "member"))).url);
    const second = tokenOf((await body<{ url: string }>(await invite(O, email, "viewer"))).url);
    expect((await accept({ token: first, password: "a long enough password" })).status).toBe(404);
    expect((await accept({ token: second, password: "a long enough password" })).status).toBe(200);
  });

  it("invitations of one organization can't be listed or withdrawn by another", async () => {
    const mine = await body<{ invitation: { id: string } }>(await invite(O, fresh("mine"), "member"));
    const theirs = await body<{ invitation: { id: string } }>(await invite(G, fresh("theirs"), "member"));

    const seenByGlobex = await body<{ invitations: { id: string }[] }>(await call(invitationsRoute.GET, "/api/org/invitations", { cookie: G.cookie }));
    expect(seenByGlobex.invitations.map((i) => i.id)).toEqual([theirs.invitation.id]);
    expect((await call(invitationRoute.DELETE, "/x", { method: "DELETE", cookie: G.cookie, params: { id: mine.invitation.id } })).status).toBe(404);
    expect((db.prepare("SELECT revoked_at FROM invitations WHERE id = ?").get(mine.invitation.id) as { revoked_at: string | null }).revoked_at).toBeNull();
  });
});

describe("team management", () => {
  const list = (who: Seeded) => call(membersRoute.GET, "/api/org/members", { cookie: who.cookie });
  const setRole = (who: Seeded, userId: string, role: string) => call(memberRoute.PATCH, "/x", { method: "PATCH", cookie: who.cookie, params: { userId }, json: { role } });
  const remove = (who: Seeded, userId: string) => call(memberRoute.DELETE, "/x", { method: "DELETE", cookie: who.cookie, params: { userId } });

  it("lists only the caller's own workspace's members", async () => {
    const members = await body<{ members: { email: string; role: string }[] }>(await list(D));
    expect(members.members.map((m) => m.email).sort()).toEqual(["admin@acme.test", "member@acme.test", "owner@acme.test", "viewer@acme.test"]);
    expect(JSON.stringify(members)).not.toMatch(/globex|password|hash/i);
  });

  it("changes roles within the rules: an admin can promote a member to admin but never to owner, and can't touch another admin or an owner", async () => {
    expect((await setRole(D, M.userId, "admin")).status).toBe(200);
    expect((await setRole(D, V.userId, "owner")).status).toBe(403);
    expect((await setRole(D, O.userId, "member")).status).toBe(403);
    const other = seedMember(db, acme, "admin2@acme.test", "admin");
    expect((await setRole(D, other.userId, "viewer")).status).toBe(403);
    const plainMember = seedMember(db, acme, "plain@acme.test", "member"); // (M was promoted above)
    expect((await setRole(plainMember, V.userId, "member")).status).toBe(403); // members can't manage at all
    expect((db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(acme, O.userId) as { role: string }).role).toBe("owner");
  });

  it("an owner can make another owner, and a role change applies to that person's very next request", async () => {
    expect((await setRole(O, M.userId, "owner")).status).toBe(200);
    expect((await body<{ organization: { role: string } }>(await call(meRoute.GET, "/api/auth/me", { cookie: M.cookie }))).organization.role).toBe("owner");
    expect((await setRole(O, V.userId, "admin")).status).toBe(200);
    expect((await call(membersRoute.GET, "/api/org/members", { cookie: V.cookie })).status).toBe(200); // the viewer is an admin now
  });

  it("never leaves a workspace without an owner", async () => {
    expect((await setRole(O, O.userId, "admin")).status).toBe(409);
    expect((await remove(O, O.userId)).status).toBe(409);
    expect((db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(acme, O.userId) as { role: string }).role).toBe("owner");
    // With a second owner, the first may step down.
    await setRole(O, M.userId, "owner");
    expect((await setRole(O, O.userId, "admin")).status).toBe(200);
  });

  it("removing someone ends their access at once and deletes their sessions in this workspace", async () => {
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: V.cookie })).status).toBe(200);
    expect((await remove(D, V.userId)).status).toBe(200);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: V.cookie })).status).toBe(401);
    expect((await remove(D, O.userId)).status).toBe(403); // an admin can't remove an owner
  });

  it("people of other workspaces can't be seen, changed or removed: they are 'not found'", async () => {
    expect((await setRole(O, G.userId, "viewer")).status).toBe(404);
    expect((await remove(O, G.userId)).status).toBe(404);
    expect((await setRole(O, "00000000-0000-4000-8000-00000000dead", "viewer")).status).toBe(404);
    expect((db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(globex, G.userId) as { role: string }).role).toBe("owner");
    // ...and the other workspace's team page shows only its own people.
    const theirs = await body<{ members: { email: string }[] }>(await list(G));
    expect(theirs.members.map((m) => m.email)).toEqual(["owner@globex.test"]);
  });

  it("rejects unknown roles", async () => {
    expect((await setRole(O, M.userId, "superuser")).status).toBe(400);
  });
});
