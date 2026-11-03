import { randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeDetails } from "@/server/audit/audit";
import { IdentityRepository } from "@/server/auth/identity";
import { hashInviteToken } from "@/server/auth/invitations";
import { hashPassword } from "@/server/auth/password";
import type { Role } from "@/server/db/constants";
import { ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import type { AuditEntryDTO, CreatedCustomerDTO, IssuedCredentialsDTO, PlatformOrganizationDetailDTO, PlatformOrganizationDTO } from "@/lib/types";
import { body, call, FAST_PASSWORDS, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
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

import * as acceptRoute from "@/app/api/auth/accept-invite/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as switchRoute from "@/app/api/auth/switch-org/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as orgInvitationRoute from "@/app/api/org/invitations/[id]/route";
import * as orgInvitationsRoute from "@/app/api/org/invitations/route";
import * as orgMemberRoute from "@/app/api/org/members/[userId]/route";
import * as orgMembersRoute from "@/app/api/org/members/route";
import * as auditRoute from "@/app/api/platform/audit/route";
import * as platformInvitationRoute from "@/app/api/platform/organizations/[id]/invitations/[invitationId]/route";
import * as platformAdminsRoute from "@/app/api/platform/organizations/[id]/admins/route";
import * as platformCredentialsRoute from "@/app/api/platform/organizations/[id]/members/[userId]/credentials/route";
import * as platformOrgRoute from "@/app/api/platform/organizations/[id]/route";
import * as platformOrgsRoute from "@/app/api/platform/organizations/route";
import * as platformUserRoute from "@/app/api/platform/users/[userId]/route";

const PASSWORD = "correct horse battery";
let db: Database.Database;
let hq: string; // the Super Admin's own workspace
let acme: string;
let globex: string;
let P: Seeded; // Super Admin (platform administrator, owner of HQ)
let O: Seeded; // Customer Admin (owner) of Acme
let M: Seeded; // member of Acme
let G: Seeded; // Customer Admin (owner) of Globex

interface AuditRow {
  id: number;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_org_id: string | null;
  action: string;
  target_org_id: string | null;
  target_user_id: string | null;
  target_label: string | null;
  outcome: string;
  details: string;
}
const audit = (where = "1=1", ...params: unknown[]) => db.prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY id`).all(...params) as AuditRow[];
const count = (table: string, where = "1=1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

let counter = 0;
/** A unique email per call, because the sign-in throttle is process-wide. */
const fresh = (prefix: string) => `${prefix}-${++counter}@people.test`;
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

/** An account with a real password (so it can sign in through the login route). */
async function user(email: string) {
  return new IdentityRepository(db).createUser({ email, passwordHash: await hashPassword(PASSWORD, FAST_PASSWORDS), displayName: "Test" });
}
const login = (email: string, password = PASSWORD) => call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email, password } });

/** Someone who belongs to the workspace and is signed in through the real login route. */
async function signedIn(orgId: string, role: Role = "member") {
  const email = fresh("person");
  const u = await user(email);
  new IdentityRepository(db).addMember(orgId, u.id, role);
  const res = await login(email);
  expect(res.status).toBe(200);
  return { email, userId: u.id, cookie: cookieFrom(res) };
}

const platform = {
  list: (cookie?: string) => call(platformOrgsRoute.GET, "/api/platform/organizations", { cookie }),
  create: (cookie: string | undefined, json: unknown) => call(platformOrgsRoute.POST, "/api/platform/organizations", { method: "POST", cookie, json }),
  get: (cookie: string | undefined, id: string) => call(platformOrgRoute.GET, `/api/platform/organizations/${id}`, { cookie, params: { id } }),
  setStatus: (cookie: string | undefined, id: string, status: unknown) =>
    call(platformOrgRoute.PATCH, `/api/platform/organizations/${id}`, { method: "PATCH", cookie, json: { status }, params: { id } }),
  /** Permanently deletes a customer; `json` is the request body as sent (normally { confirmName }). */
  remove: (cookie: string | undefined, id: string, json?: unknown) =>
    call(platformOrgRoute.DELETE, `/api/platform/organizations/${id}`, { method: "DELETE", cookie, json, params: { id } }),
  addAdmin: (cookie: string | undefined, id: string, email: unknown) =>
    call(platformAdminsRoute.POST, `/api/platform/organizations/${id}/admins`, { method: "POST", cookie, json: { email }, params: { id } }),
  credentials: (cookie: string | undefined, id: string, userId: string, action: unknown) =>
    call(platformCredentialsRoute.POST, `/api/platform/organizations/${id}/members/${userId}/credentials`, { method: "POST", cookie, json: { action }, params: { id, userId } }),
  revoke: (cookie: string | undefined, id: string, invitationId: string) =>
    call(platformInvitationRoute.DELETE, `/api/platform/organizations/${id}/invitations/${invitationId}`, { method: "DELETE", cookie, params: { id, invitationId } }),
  setUser: (cookie: string | undefined, userId: string, status: unknown) =>
    call(platformUserRoute.PATCH, `/api/platform/users/${userId}`, { method: "PATCH", cookie, json: { status }, params: { userId } }),
  audit: (cookie: string | undefined, query = "") => call(auditRoute.GET, `/api/platform/audit${query}`, { cookie }),
};

const tokenOf = (setupUrl: string) => new URL(setupUrl).searchParams.get("token")!;
const peek = (token: string) => call(acceptRoute.GET, `/api/auth/accept-invite?token=${token}`);
const accept = (token: string, json: Record<string, unknown> = {}, cookie?: string) =>
  call(acceptRoute.POST, "/api/auth/accept-invite", { method: "POST", cookie, json: { token, ...json } });

/** Creates a customer through the real route: workspace + Customer Admin account + a temporary password, returned once. */
async function createCustomer(name = "Initech", adminEmail = "Boss@Initech.test", extra: { reference?: string; requestId?: string } = {}) {
  const res = await platform.create(P.cookie, { name, adminEmail, ...extra });
  expect(res.status).toBe(201);
  const created = await body<CreatedCustomerDTO>(res);
  return { res, created, orgId: created.organization.id, adminEmail: adminEmail.toLowerCase(), password: created.credentials!.temporaryPassword };
}

/** A workspace as the EARLIER onboarding left it: no account yet, only an unused invitation LINK. Such links must keep working. */
function legacyCustomer(name = "Initech", email = "boss@initech.test") {
  const orgId = seedOrganization(db, name);
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at) VALUES (?, ?, ?, 'admin', 1, ?, ?, ?)").run(
    randomUUID(),
    orgId,
    email,
    hashInviteToken(token),
    P.userId,
    new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
  );
  issuedTokens.push(token);
  return { orgId, token, adminEmail: email };
}

/** Every setup link and invitation token issued in a test, so the audit log can be searched for them. */
const issuedTokens: string[] = [];

beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());

beforeEach(() => {
  issuedTokens.length = 0;
  db = memoryDb();
  h.db = db;
  hq = seedOrganization(db, "Platform HQ");
  acme = seedOrganization(db, "Acme");
  globex = seedOrganization(db, "Globex");
  P = seedMember(db, hq, "super@platform.test", "owner", { platformAdmin: true });
  O = seedMember(db, acme, "owner@acme.test", "owner");
  M = seedMember(db, acme, "member@acme.test", "member");
  G = seedMember(db, globex, "owner@globex.test", "owner");
  // Customer content that must never show up in anything the Super Admin console returns.
  new DocumentRepository(db, acme).create({ id: "doc-acme", filename: "ACME-SECRET-PLAN.pdf", mimeType: "application/pdf", sizeBytes: 1 });
  new DocumentRepository(db, globex).create({ id: "doc-globex", filename: "GLOBEX-PRICING.pdf", mimeType: "application/pdf", sizeBytes: 1 });
  new ConversationRepository(db, acme, O.userId).create("ACME-PRIVATE-CHAT");
});

// ─────────────────────────────────────────────────────────────────────────────

describe("only a Super Admin can use the console", () => {
  const endpoints: { name: string; run: (cookie?: string) => Promise<Response> }[] = [
    { name: "list workspaces", run: (c) => platform.list(c) },
    { name: "view a workspace", run: (c) => platform.get(c, acme) },
    { name: "create a customer", run: (c) => platform.create(c, { name: "Hooli", adminEmail: "gavin@hooli.test" }) },
    { name: "suspend a workspace", run: (c) => platform.setStatus(c, acme, "suspended") },
    { name: "reactivate a workspace", run: (c) => platform.setStatus(c, acme, "active") },
    { name: "delete a customer", run: (c) => platform.remove(c, acme, { confirmName: "Acme" }) },
    { name: "add a Customer Admin", run: (c) => platform.addAdmin(c, acme, "new@acme.test") },
    { name: "reissue a temporary password", run: (c) => platform.credentials(c, acme, M.userId, "reissue") },
    { name: "revoke a temporary password", run: (c) => platform.credentials(c, acme, M.userId, "revoke") },
    { name: "revoke an invitation", run: (c) => platform.revoke(c, acme, "00000000-0000-4000-8000-000000000009") },
    { name: "disable a person", run: (c) => platform.setUser(c, M.userId, "disabled") },
    { name: "read the audit log", run: (c) => platform.audit(c) },
  ];

  it.each(endpoints)("$name: signed-out callers get 401", async ({ run }) => {
    expect((await run(undefined)).status).toBe(401);
  });

  it("refuses owners, admins and members of customer workspaces (403), changes nothing, and records each attempt", async () => {
    const admin = seedMember(db, acme, "admin@acme.test", "admin");
    const before = { orgs: count("organizations"), users: count("users", "status = 'disabled'"), suspended: count("organizations", "status = 'suspended'"), invitations: count("invitations") };
    const callers = [O, admin, M, G];

    for (const caller of callers) {
      for (const { name, run } of endpoints) expect((await run(caller.cookie)).status, `${name} as ${caller.email}`).toBe(403);
    }

    expect({ orgs: count("organizations"), users: count("users", "status = 'disabled'"), suspended: count("organizations", "status = 'suspended'"), invitations: count("invitations") }).toEqual(before);
    const denied = audit("action = 'platform.access_denied'");
    expect(denied).toHaveLength(callers.length * endpoints.length);
    expect(denied.every((r) => r.outcome === "denied" && r.actor_email && r.actor_org_id)).toBe(true);
    expect(new Set(denied.map((r) => r.actor_email))).toEqual(new Set(callers.map((c) => c.email)));
  });

  it("still answers 403 when the audit record itself can't be written", async () => {
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");
    expect((await platform.list(O.cookie)).status).toBe(403);
    db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");
  });

  it("rejects cross-site requests to change anything", async () => {
    const res = await call(platformOrgsRoute.POST, "/api/platform/organizations", {
      method: "POST",
      cookie: P.cookie,
      json: { name: "Hooli", adminEmail: "gavin@hooli.test" },
      headers: { origin: "https://evil.example", host: "localhost:3000" },
    });
    expect(res.status).toBe(403);
    expect(count("organizations", "name = 'Hooli'")).toBe(0);
  });
});

describe("viewing all customer workspaces", () => {
  it("lists every workspace with counts, and nothing a customer owns", async () => {
    const res = await platform.list(P.cookie);
    expect(res.status).toBe(200);
    const { organizations } = await body<{ organizations: PlatformOrganizationDTO[] }>(res);
    const byName = Object.fromEntries(organizations.map((o) => [o.name, o]));

    expect(Object.keys(byName).sort()).toEqual(["Acme", "Default workspace", "Globex", "Platform HQ"]);
    expect(byName.Acme).toMatchObject({ status: "active", memberCount: 2, ownerCount: 1, pendingAdminInvites: 0 });
    expect(byName.Globex).toMatchObject({ memberCount: 1, ownerCount: 1 });

    const text = JSON.stringify(organizations);
    expect(text).not.toMatch(/ACME-SECRET|GLOBEX-PRICING|ACME-PRIVATE|filename|password|hash|token/i);
    expect(Object.keys(organizations[0]!).sort()).toEqual(["activation", "createdAt", "id", "lastLoginAt", "memberCount", "name", "ownerCount", "pendingAdminInvites", "reference", "slug", "status"]);
  });

  it("shows one workspace's people and invitations, and no documents, chats or integrations", async () => {
    const res = await platform.get(P.cookie, acme);
    expect(res.status).toBe(200);
    const detail = await body<PlatformOrganizationDetailDTO>(res);

    expect(Object.keys(detail).sort()).toEqual(["data", "invitations", "members", "organization"]);
    expect(detail.data).toEqual({ documents: 1, conversations: 1, integrations: 0, consultations: 0 }); // how much there is (for the delete warning), never what it says
    expect(detail.members.map((m) => [m.email, m.role, m.userStatus]).sort()).toEqual([
      ["member@acme.test", "member", "active"],
      ["owner@acme.test", "owner", "active"],
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/ACME-SECRET|ACME-PRIVATE|GLOBEX|password|hash/i);
    expect((await platform.get(P.cookie, "00000000-0000-4000-8000-000000000009")).status).toBe(404);
  });

  it("the Super Admin's own workspace session doesn't open customers' content: documents and chats stay behind their workspace", async () => {
    const docs = await body<{ documents: { filename: string }[] }>(await call(documentsRoute.GET, "/api/documents", { cookie: P.cookie }));
    expect(docs.documents).toEqual([]); // HQ has none; Acme's and Globex's are not visible from here
    expect((await call(orgMembersRoute.GET, "/api/org/members", { cookie: P.cookie })).status).toBe(200);
    const members = await body<{ members: { email: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie: P.cookie }));
    expect(members.members.map((m) => m.email)).toEqual(["super@platform.test"]);
  });

  it("records every look at customer records as sensitive access", async () => {
    await platform.list(P.cookie);
    await platform.get(P.cookie, acme);
    const rows = audit("actor_email = 'super@platform.test'");
    expect(rows.map((r) => r.action)).toEqual(["platform.organizations.list", "platform.organization.view"]);
    expect(rows[1]).toMatchObject({ target_org_id: acme, target_label: "Acme", actor_org_id: hq, outcome: "success" });
  });
});

describe("creating a customer and its first Customer Admin", () => {
  it("creates the workspace, the Customer Admin's account (owner) and a one-time temporary password", async () => {
    const { res, created, orgId, password } = await createCustomer();

    expect(res.headers.get("cache-control")).toBe("no-store");
    const credentials = created.credentials as IssuedCredentialsDTO;
    expect(credentials).toMatchObject({ workspaceName: "Initech", loginId: "boss@initech.test", loginUrl: "http://localhost:3000/login" });
    expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/); // 16 random characters, no look-alikes
    const hours = (new Date(credentials.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73); // TEMPORARY_PASSWORD_HOURS (72)
    expect(created).toMatchObject({ workspaceName: "Initech", loginId: "boss@initech.test", alreadyCreated: false });
    expect(created.organization).toMatchObject({ name: "Initech", status: "active", memberCount: 1, ownerCount: 1, activation: { status: "pending", loginId: "boss@initech.test" } });

    // The account exists, belongs to this workspace only, with the owner role, and is flagged as having a temporary password.
    const user = db.prepare("SELECT id, email, password_hash, must_change_password AS m, temp_password_expires_at AS e, is_platform_admin AS p FROM users WHERE email = 'boss@initech.test'").get() as { id: string; password_hash: string; m: number; e: string; p: number };
    expect(user).toMatchObject({ m: 1, p: 0 });
    expect(user.e).toBe(credentials.expiresAt);
    expect(db.prepare("SELECT org_id AS org, role FROM memberships WHERE user_id = ?").all(user.id)).toEqual([{ org: orgId, role: "owner" }]);
    expect(count("invitations", `org_id = '${orgId}'`)).toBe(0); // no invitation, no link
    expect(JSON.stringify(created)).not.toMatch(/token|setupUrl|\/invite/i);
  });

  it("stores only a scrypt hash: the temporary password is in no table, in no audit record and in no log", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "info"), vi.spyOn(console, "warn"), vi.spyOn(console, "debug")].map((spy) => spy.mockImplementation(() => undefined));
    const { password, orgId } = await createCustomer();

    const hash = (db.prepare("SELECT password_hash FROM users WHERE email = 'boss@initech.test'").get() as { password_hash: string }).password_hash;
    expect(hash).toMatch(/^scrypt\$/);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    const everything = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join("\n");
    expect(everything).not.toContain(password);
    expect(everything).not.toContain(password.replaceAll("-", ""));
    expect(JSON.stringify(audit())).not.toMatch(/temporary|password/i);
    expect(JSON.stringify([...logs, vi.mocked(console.error)].flatMap((s) => s.mock.calls))).not.toContain(password);
    expect(count("users", `email = 'boss@initech.test' AND password_hash LIKE '%${password}%'`)).toBe(0);
    expect(orgId).toBeTruthy();
  });

  it("gives every customer a different password, drawn from a secure random source", async () => {
    const passwords = new Set<string>();
    for (let i = 0; i < 8; i++) passwords.add((await createCustomer(`Customer ${i}`, `admin-${i}@customer.test`)).password);
    expect(passwords.size).toBe(8);
  });

  it("validates the input and refuses duplicates, including an email that already has an account", async () => {
    expect((await platform.create(P.cookie, { name: "X", adminEmail: "a@b.test" })).status).toBe(400);
    expect((await platform.create(P.cookie, { name: "Valid Name", adminEmail: "not-an-email" })).status).toBe(400);
    expect((await platform.create(P.cookie, { name: "Valid Name" })).status).toBe(400);
    expect((await platform.create(P.cookie, { name: "Valid Name", adminEmail: "a@b.test", role: "owner" })).status).toBe(400); // unknown fields are refused
    expect((await platform.create(P.cookie, { name: "Valid Name", adminEmail: "a@b.test", requestId: "not-a-uuid" })).status).toBe(400);
    expect((await platform.create(P.cookie, { name: "  acme  ", adminEmail: "a@b.test" })).status).toBe(409);

    const before = { orgs: count("organizations"), users: count("users") };
    for (const email of ["owner@globex.test", "OWNER@acme.test", "super@platform.test"]) {
      // Another customer's administrator, a member, and the Super Admin themself: never silently attached to a new workspace.
      const res = await platform.create(P.cookie, { name: "Hooli", adminEmail: email });
      expect(res.status, email).toBe(409);
      expect((await body<{ error: string }>(res)).error).toMatch(/already exists/);
    }
    expect({ orgs: count("organizations"), users: count("users") }).toEqual(before);
    expect(count("memberships", "role = 'owner'")).toBe(3); // Globex, Acme and HQ: unchanged
  });

  it("keeps an optional customer reference as plain metadata: validated, unique, shown, and never a way to sign in", async () => {
    const { created } = await createCustomer("Initech", "boss@initech.test", { reference: "CUST-0042" });
    expect(created.organization.reference).toBe("CUST-0042");
    const listed = await body<{ organizations: PlatformOrganizationDTO[] }>(await platform.list(P.cookie));
    expect(listed.organizations.find((o) => o.name === "Initech")?.reference).toBe("CUST-0042");

    expect((await platform.create(P.cookie, { name: "Hooli", adminEmail: "g@hooli.test", reference: "cust-0042" })).status).toBe(409); // unique, any case
    expect((await platform.create(P.cookie, { name: "Hooli", adminEmail: "g@hooli.test", reference: "bad ref!" })).status).toBe(400);
    expect(count("organizations", "name = 'Hooli'")).toBe(0);
    expect((await login("CUST-0042")).status).toBe(401); // the reference is not a login ID
  });

  it("is safe to retry: the same request id returns the existing customer, never a second workspace and never the password", async () => {
    const requestId = randomUUID();
    const first = await platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test", requestId });
    expect(first.status).toBe(201);
    const original = await body<CreatedCustomerDTO>(first);
    const password = original.credentials!.temporaryPassword;

    const retry = await platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test", requestId });
    expect(retry.status).toBe(200);
    const again = await body<CreatedCustomerDTO>(retry);
    expect(again).toMatchObject({ alreadyCreated: true, credentials: null, workspaceName: "Initech", loginId: "boss@initech.test" });
    expect(again.organization.id).toBe(original.organization.id);
    expect(JSON.stringify(again)).not.toContain(password);
    expect(retry.headers.get("cache-control")).toBe("no-store");

    // A retry that carries different details still can't create anything or reveal anything.
    const odd = await platform.create(P.cookie, { name: "Something else", adminEmail: "other@initech.test", requestId });
    expect(await body(odd)).toMatchObject({ alreadyCreated: true, credentials: null, workspaceName: "Initech" });

    expect(count("organizations", "name = 'Initech'")).toBe(1);
    expect(count("organizations", "name = 'Something else'")).toBe(0);
    expect(count("users", "email LIKE '%@initech.test'")).toBe(1);
    expect((await login("boss@initech.test", password)).status).toBe(200); // the first password is still the one that works
  });

  it("recognises a retry before looking at anything else: it doesn't re-validate the payload or hash another password", async () => {
    const requestId = randomUUID();
    await createCustomer("Initech", "boss@initech.test", { requestId });

    // A reference the service would refuse, and a name/email that are taken: none of it matters for a request that already succeeded.
    const retry = await platform.create(P.cookie, { name: "Acme", adminEmail: "owner@acme.test", reference: "not a valid reference!", requestId });
    expect(retry.status).toBe(200);
    expect(await body(retry)).toMatchObject({ alreadyCreated: true, credentials: null, workspaceName: "Initech" });
    expect(count("organizations", "name = 'Initech'")).toBe(1);
  });

  it("two requests racing with the same id create one customer", async () => {
    const requestId = randomUUID();
    const [a, b] = await Promise.all([
      platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test", requestId }),
      platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test", requestId }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(count("organizations", "name = 'Initech'")).toBe(1);
    expect(count("users", "email = 'boss@initech.test'")).toBe(1);
    const created = [await body<CreatedCustomerDTO>(a), await body<CreatedCustomerDTO>(b)];
    expect(created.filter((c) => c.credentials !== null)).toHaveLength(1); // only one response ever carries the password
  });

  it("without a request id a repeated request still can't duplicate the workspace or the account", async () => {
    await createCustomer();
    const again = await platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test" });
    expect(again.status).toBe(409);
    expect(JSON.stringify(await again.json())).not.toMatch(/[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-/); // and no password in the refusal
    expect(count("organizations", "name = 'Initech'")).toBe(1);
  });

  it("records the creation, without any secret", async () => {
    const { orgId } = await createCustomer("Initech", "boss@initech.test", { reference: "CUST-0042" });
    const created = audit("action = 'platform.organization.create'");
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ actor_email: "super@platform.test", target_org_id: orgId, target_label: "Initech", outcome: "success" });
    expect(JSON.parse(created[0]!.details)).toEqual({ adminEmail: "boss@initech.test", reference: "CUST-0042" });
  });

  it("rolls the whole creation back if the audit record can't be written", async () => {
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");
    const res = await platform.create(P.cookie, { name: "Initech", adminEmail: "boss@initech.test" });
    db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");
    expect(res.status).toBe(500);
    expect(count("organizations", "name = 'Initech'")).toBe(0);
    expect(count("users", "email = 'boss@initech.test'")).toBe(0);
  });
});

describe("invitation links issued before temporary passwords existed", () => {
  it("still let the Customer Admin set a password and sign in as the workspace's owner", async () => {
    const { orgId, token, adminEmail } = legacyCustomer();

    const peeked = await body<{ organization: string; email: string; role: string; hasAccount: boolean }>(await peek(token));
    expect(peeked).toEqual({ organization: "Initech", email: "boss@initech.test", role: "owner", hasAccount: false });
    expect((await accept(token, { password: "abc" })).status).toBe(400); // the password policy applies
    expect(count("users", "email = 'boss@initech.test'")).toBe(0);

    const res = await accept(token, { password: "a long enough password", name: "Bill Boss" });
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    const me = await body<{ user: { email: string }; organization: { id: string; name: string; role: string }; permissions: string[]; passwordChangeRequired: boolean }>(await call(meRoute.GET, "/api/auth/me", { cookie }));
    expect(me.user.email).toBe(adminEmail);
    expect(me.organization).toMatchObject({ id: orgId, name: "Initech", role: "owner" });
    expect(me.permissions).toContain("members:manage");
    expect(me.permissions).not.toContain("platform:admin");
    expect(me.passwordChangeRequired).toBe(false); // they chose this password themselves: no forced change

    const detail = await body<PlatformOrganizationDetailDTO>(await platform.get(P.cookie, orgId));
    expect(detail.members.map((m) => [m.email, m.lastLoginAt !== null, m.credential.status])).toEqual([["boss@initech.test", true, "set"]]);
    expect(detail.organization.activation.status).toBe("activated");
    expect((await login("boss@initech.test", "a long enough password")).status).toBe(200);
    expect((await login("boss@initech.test", "some other password!!")).status).toBe(401);
  });

  it("work once only, and a bad or malformed link reveals nothing", async () => {
    const { token } = legacyCustomer();
    expect((await accept(token, { password: "a long enough password" })).status).toBe(200);
    expect((await accept(token, { password: "another long password" })).status).toBe(404);
    expect((await peek(token)).status).toBe(404);
    expect((await peek("x".repeat(43))).status).toBe(404);
    expect((await peek("short")).status).toBe(404);
  });

  it("give a Customer Admin who joined that way only their own workspace, and the means to manage people there", async () => {
    const { orgId, token } = legacyCustomer();
    const cookie = cookieFrom(await accept(token, { password: "a long enough password" }));

    const docs = await body<{ documents: unknown[] }>(await call(documentsRoute.GET, "/api/documents", { cookie }));
    expect(docs.documents).toEqual([]);
    const members = await body<{ members: { email: string; role: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie }));
    expect(members.members).toEqual([expect.objectContaining({ email: "boss@initech.test", role: "owner" })]);

    const invite = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie, json: { email: "teammate@initech.test", role: "member" } });
    expect(invite.status).toBe(201);
    expect(count("invitations", `org_id = '${orgId}' AND email = 'teammate@initech.test'`)).toBe(1);

    for (const attempt of [platform.list(cookie), platform.get(cookie, acme), platform.audit(cookie), platform.setStatus(cookie, acme, "suspended")]) {
      expect((await attempt).status).toBe(403); // and the Super Admin console stays closed to them
    }
  });

  it("record the first sign-up in the audit trail without the link or the password", async () => {
    const { orgId, token } = legacyCustomer();
    await accept(token, { password: "a long enough password" });

    const joined = audit("action = 'auth.invitation.accept'");
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({ actor_email: "boss@initech.test", target_org_id: orgId });
    expect(JSON.parse(joined[0]!.details)).toEqual({ role: "owner", newAccount: true });
    const everything = JSON.stringify(audit());
    expect(everything).not.toContain(token);
    expect(everything).not.toContain("a long enough password");
    expect(everything).not.toMatch(/scrypt\$/);
  });

  it("an existing account (a Customer Admin elsewhere) must be signed in to use a link, and becomes an owner of the new workspace too", async () => {
    const { orgId, token } = legacyCustomer("Hooli", "owner@globex.test");
    expect(await body(await peek(token))).toMatchObject({ hasAccount: true, role: "owner" });

    expect((await accept(token)).status).toBe(401); // not signed in
    expect((await accept(token, {}, O.cookie)).status).toBe(403); // signed in as somebody else
    expect(count("memberships", `org_id = '${orgId}'`)).toBe(0);

    const res = await accept(token, {}, G.cookie);
    expect(res.status).toBe(200);
    const me = await body<{ organization: { name: string; role: string }; organizations: { name: string }[] }>(await call(meRoute.GET, "/api/auth/me", { cookie: cookieFrom(res) }));
    expect(me.organization).toMatchObject({ name: "Hooli", role: "owner" });
    expect(me.organizations.map((o) => o.name).sort()).toEqual(["Globex", "Hooli"]);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: G.cookie })).status).toBe(401); // that session moved to the new one
    expect(count("documents", `org_id = '${globex}'`)).toBe(1);
  });

  it("show on the console as waiting for a first sign-in until they are used, and can be withdrawn", async () => {
    const { orgId } = legacyCustomer();
    const detail = await body<PlatformOrganizationDetailDTO>(await platform.get(P.cookie, orgId));
    expect(detail.invitations).toEqual([expect.objectContaining({ email: "boss@initech.test", role: "owner", status: "pending", invitedBy: "super@platform.test" })]);
    expect(detail.organization).toMatchObject({ pendingAdminInvites: 1, activation: { status: "pending", loginId: "boss@initech.test" } });
    expect(JSON.stringify(detail)).not.toMatch(/token/i);

    const invitationId = detail.invitations[0]!.id;
    expect((await platform.revoke(P.cookie, orgId, invitationId)).status).toBe(204);
    expect((await platform.revoke(P.cookie, orgId, invitationId)).status).toBe(404); // already withdrawn
    expect(audit("action = 'platform.invitation.revoke'")).toHaveLength(1);
  });

  it("can't be withdrawn through another workspace's path", async () => {
    const a = legacyCustomer("Initech", "boss@initech.test");
    const b = legacyCustomer("Hooli", "gavin@hooli.test");
    const idOf = (orgId: string) => (db.prepare("SELECT id FROM invitations WHERE org_id = ?").get(orgId) as { id: string }).id;
    expect((await platform.revoke(P.cookie, a.orgId, idOf(b.orgId))).status).toBe(404);
    expect(count("invitations", `org_id = '${b.orgId}' AND revoked_at IS NULL`)).toBe(1);
  });

  it("can't be created any more: the database still refuses an owner invitation from anyone but a platform administrator", async () => {
    const viaApi = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: "x@acme.test", role: "owner" } });
    expect(viaApi.status).toBe(400);
    expect(() =>
      db
        .prepare(`INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at) VALUES ('i1', ?, 'x@acme.test', 'admin', 1, 'h1', ?, '2999-01-01T00:00:00.000Z')`)
        .run(acme, O.userId),
    ).toThrow(/only a platform administrator/);
  });
});

describe("Customer Admin accounts (Super Admin side)", () => {
  it("adds another Customer Admin with a temporary password, shown once", async () => {
    const res = await platform.addAdmin(P.cookie, acme, "Second@Acme.test");
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { credentials } = await body<{ credentials: IssuedCredentialsDTO }>(res);

    expect(credentials).toMatchObject({ workspaceName: "Acme", loginId: "second@acme.test", loginUrl: "http://localhost:3000/login" });
    expect(credentials.temporaryPassword).toMatch(/^[A-Za-z2-9-]{19}$/);
    expect(db.prepare("SELECT m.role, u.must_change_password AS must FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'second@acme.test'").all()).toEqual([{ role: "owner", must: 1 }]);
    expect(count("memberships", `org_id = '${acme}'`)).toBe(3); // O, M and the new one
    expect(JSON.stringify(audit())).not.toContain(credentials.temporaryPassword);
    expect(audit("action = 'platform.customer_admin.add'")).toHaveLength(1);
  });

  it("refuses an email that already has an account, in this workspace or another, and changes nothing", async () => {
    const before = db.prepare("SELECT email, password_hash FROM users ORDER BY email").all();
    expect((await platform.addAdmin(P.cookie, acme, "owner@acme.test")).status).toBe(409); // already here
    expect((await platform.addAdmin(P.cookie, acme, "member@acme.test")).status).toBe(409);
    const other = await platform.addAdmin(P.cookie, acme, "owner@globex.test"); // another customer's administrator
    expect(other.status).toBe(409);
    expect((await body<{ error: string }>(other)).error).toMatch(/already exists/);
    expect((await platform.addAdmin(P.cookie, "00000000-0000-4000-8000-000000000009", "x@y.test")).status).toBe(404);
    expect((await platform.addAdmin(P.cookie, acme, "nope")).status).toBe(400);
    expect(db.prepare("SELECT email, password_hash FROM users ORDER BY email").all()).toEqual(before); // nobody's password was touched
    expect(db.prepare("SELECT 1 FROM memberships WHERE org_id = ? AND user_id = ?").get(acme, G.userId)).toBeUndefined(); // Globex's owner did not become Acme's
  });

  it("reissues a temporary password: the earlier one stops working at once, the sessions end, and the new one works", async () => {
    const { orgId, password: first, adminEmail } = await createCustomer();
    const userId = (db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail) as { id: string }).id;
    const signedIn = await login(adminEmail, first);
    expect(signedIn.status).toBe(200);

    const res = await platform.credentials(P.cookie, orgId, userId, "reissue");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { credentials } = await body<{ credentials: IssuedCredentialsDTO }>(res);

    expect(credentials.temporaryPassword).not.toBe(first);
    expect(credentials.loginId).toBe(adminEmail);
    expect(count("auth_sessions", `user_id = '${userId}'`)).toBe(0); // signed out
    expect((await login(adminEmail, first)).status).toBe(401); // the earlier password is dead
    expect((await login(adminEmail, credentials.temporaryPassword)).status).toBe(200);
    expect(JSON.stringify(audit())).not.toContain(credentials.temporaryPassword);
    expect(audit("action = 'platform.credentials.reissue'")).toHaveLength(1);
  });

  it("revokes a temporary password: it stops working immediately and the person is told it expired", async () => {
    const { orgId, password, adminEmail } = await createCustomer();
    const userId = (db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail) as { id: string }).id;
    const cookie = cookieFrom(await login(adminEmail, password));

    const res = await platform.credentials(P.cookie, orgId, userId, "revoke");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ revoked: true, loginId: adminEmail });

    expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(401); // the open session is gone
    const blocked = await login(adminEmail, password);
    expect(blocked.status).toBe(403);
    expect(await body(blocked)).toMatchObject({ code: "temporary_password_expired" });
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect((await login(adminEmail, "a wrong password!!")).status).toBe(401); // a wrong password learns nothing about the expiry
    const detail = await body<PlatformOrganizationDetailDTO>(await platform.get(P.cookie, orgId));
    expect(detail.members[0]!.credential.status).toBe("expired");
    expect(detail.organization.activation.status).toBe("expired");
    expect(audit("action = 'platform.credentials.revoke'")).toHaveLength(1);

    // Reissuing brings the account back.
    const again = await body<{ credentials: IssuedCredentialsDTO }>(await platform.credentials(P.cookie, orgId, userId, "reissue"));
    expect((await login(adminEmail, again.credentials.temporaryPassword)).status).toBe(200);
  });

  it("only touches accounts that still have a temporary password, in the workspace named, and never a Super Admin", async () => {
    const { orgId, adminEmail } = await createCustomer();
    const customerAdmin = (db.prepare("SELECT id FROM users WHERE email = ?").get(adminEmail) as { id: string }).id;

    // An account that chose its own password can't be reissued or revoked from here (that would be taking it over).
    for (const action of ["reissue", "revoke"]) {
      const res = await platform.credentials(P.cookie, acme, O.userId, action);
      expect(res.status, action).toBe(409);
      expect((await body<{ error: string }>(res)).error).toMatch(/already chosen their own password/);
    }
    expect(db.prepare("SELECT must_change_password AS m FROM users WHERE id = ?").get(O.userId)).toEqual({ m: 0 });
    expect(count("auth_sessions", `user_id = '${O.userId}'`)).toBeGreaterThan(0); // and their sign-in is untouched

    expect((await platform.credentials(P.cookie, hq, P.userId, "reissue")).status).toBe(409); // a Super Admin (here: themself)
    // Even a Super Admin account that carried a temporary-password flag could not be reissued from here.
    const second = seedMember(db, hq, "second-super@platform.test", "admin", { platformAdmin: true });
    db.prepare("UPDATE users SET must_change_password = 1, temp_password_expires_at = ? WHERE id = ?").run(new Date(Date.now() + 3600_000).toISOString(), second.userId);
    const refused = await platform.credentials(P.cookie, hq, second.userId, "reissue");
    expect(refused.status).toBe(409);
    expect((await body<{ error: string }>(refused)).error).toMatch(/Platform administrators/);
    expect((await platform.credentials(P.cookie, acme, customerAdmin, "reissue")).status).toBe(404); // the person isn't in that workspace
    expect((await platform.credentials(P.cookie, orgId, "00000000-0000-4000-8000-000000000009", "reissue")).status).toBe(404);
    expect((await platform.credentials(P.cookie, orgId, customerAdmin, "delete")).status).toBe(400);
    db.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(orgId);
    expect((await platform.credentials(P.cookie, orgId, customerAdmin, "reissue")).status).toBe(409); // suspended workspace
  });

  it("the console shows who is waiting for a first sign-in, whose password expired, and who has set their own", async () => {
    const waiting = await createCustomer("Waiting Co", "w@waiting.test");
    const lapsed = await createCustomer("Lapsed Co", "l@lapsed.test");
    db.prepare("UPDATE users SET temp_password_expires_at = '2020-01-01T00:00:00.000Z' WHERE email = 'l@lapsed.test'").run();
    const empty = seedOrganization(db, "Empty Co");

    const { organizations } = await body<{ organizations: PlatformOrganizationDTO[] }>(await platform.list(P.cookie));
    const status = (id: string) => organizations.find((o) => o.id === id)!.activation;
    expect(status(waiting.orgId)).toMatchObject({ status: "pending", loginId: "w@waiting.test" });
    expect(status(lapsed.orgId)).toMatchObject({ status: "expired", loginId: "l@lapsed.test" });
    expect(status(empty)).toMatchObject({ status: "none", loginId: null });
    expect(status(acme)).toMatchObject({ status: "activated", loginId: null });
  });
});

describe("workspace status", () => {
  it("suspending a workspace signs everyone in it out at once, blocks sign-in, and keeps its data", async () => {
    const sam = await signedIn(acme);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: sam.cookie })).status).toBe(200);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(200);

    const res = await platform.setStatus(P.cookie, acme, "suspended");
    expect(res.status).toBe(200);
    expect((await body<{ organization: PlatformOrganizationDTO }>(res)).organization.status).toBe("suspended");

    for (const cookie of [sam.cookie, O.cookie]) {
      expect((await call(documentsRoute.GET, "/api/documents", { cookie })).status).toBe(401);
      expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(401);
    }
    const blocked = await login(sam.email);
    expect(blocked.status).toBe(403);
    expect(await body(blocked)).toMatchObject({ code: "workspace_suspended" });
    expect(blocked.headers.get("set-cookie")).toBeNull();
    expect((await login(sam.email, "wrong password!!")).status).toBe(401); // a wrong password learns nothing about the suspension

    expect(count("documents", `org_id = '${acme}'`)).toBe(1); // nothing deleted
    expect(count("memberships", `org_id = '${acme}'`)).toBeGreaterThanOrEqual(3);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: G.cookie })).status).toBe(200); // other customers unaffected
    expect((await body<{ organizations: PlatformOrganizationDTO[] }>(await platform.list(P.cookie))).organizations.find((o) => o.id === acme)?.status).toBe("suspended");
  });

  it("a sign-in can't be used while its workspace is suspended, even if the status was changed behind the application's back", async () => {
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(200);
    db.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(acme); // no session is deleted this way
    expect(count("auth_sessions", `org_id = '${acme}'`)).toBeGreaterThan(0);

    expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(401);
    expect((await call(meRoute.GET, "/api/auth/me", { cookie: O.cookie })).status).toBe(401);
  });

  it("suspending ends the sign-ins for good: reactivating doesn't bring old ones back", async () => {
    await platform.setStatus(P.cookie, acme, "suspended");
    expect(count("auth_sessions", `org_id = '${acme}'`)).toBe(0);

    await platform.setStatus(P.cookie, acme, "active");
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(401); // they sign in again
    expect(count("auth_sessions", `org_id = '${globex}'`)).toBeGreaterThan(0); // other customers' sign-ins were never touched
  });

  it("reactivating restores sign-in", async () => {
    const sam = await signedIn(acme);
    await platform.setStatus(P.cookie, acme, "suspended");
    expect((await login(sam.email)).status).toBe(403);

    expect((await platform.setStatus(P.cookie, acme, "active")).status).toBe(200);

    const back = await login(sam.email);
    expect(back.status).toBe(200);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: cookieFrom(back) })).status).toBe(200);
    expect(audit("action IN ('platform.organization.suspend','platform.organization.reactivate')").map((r) => r.action)).toEqual([
      "platform.organization.suspend",
      "platform.organization.reactivate",
    ]);
  });

  it("someone in two workspaces lands in the one that works, and can't switch to the suspended one", async () => {
    const email = fresh("both");
    const u = await user(email);
    new IdentityRepository(db).addMember(acme, u.id, "member");
    new IdentityRepository(db).addMember(globex, u.id, "member");
    await platform.setStatus(P.cookie, acme, "suspended");

    const res = await login(email);
    expect(res.status).toBe(200);
    const cookie = cookieFrom(res);
    const me = await body<{ organization: { id: string }; organizations: { id: string }[] }>(await call(meRoute.GET, "/api/auth/me", { cookie }));
    expect(me.organization.id).toBe(globex);
    expect(me.organizations.map((o) => o.id)).toEqual([globex]); // the suspended one isn't offered
    expect((await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie, json: { orgId: acme } })).status).toBe(404);
  });

  it("invitations to a suspended workspace stop working until it is reactivated", async () => {
    const invited = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: "late@acme.test", role: "viewer" } });
    const token = tokenOf((await body<{ url: string }>(invited)).url);
    expect((await peek(token)).status).toBe(200);

    await platform.setStatus(P.cookie, acme, "suspended");
    expect((await peek(token)).status).toBe(404);
    expect((await accept(token, { password: "a long enough password" })).status).toBe(404);
    expect(count("users", "email = 'late@acme.test'")).toBe(0);
    expect((await platform.addAdmin(P.cookie, acme, "boss@acme.test")).status).toBe(409);

    await platform.setStatus(P.cookie, acme, "active");
    expect((await peek(token)).status).toBe(200);
  });

  it("nobody can suspend the workspace they are signed in to, and repeating a change is harmless", async () => {
    expect((await platform.setStatus(P.cookie, hq, "suspended")).status).toBe(409);
    expect(count("organizations", `id = '${hq}' AND status = 'active'`)).toBe(1);
    expect((await call(meRoute.GET, "/api/auth/me", { cookie: P.cookie })).status).toBe(200);

    await platform.setStatus(P.cookie, acme, "suspended");
    expect((await platform.setStatus(P.cookie, acme, "suspended")).status).toBe(200);
    expect(audit("action = 'platform.organization.suspend'")).toHaveLength(1); // no second record for a no-op
  });

  it("rejects unknown workspaces and unknown statuses", async () => {
    expect((await platform.setStatus(P.cookie, "00000000-0000-4000-8000-000000000009", "suspended")).status).toBe(404);
    expect((await platform.setStatus(P.cookie, acme, "deleted")).status).toBe(400);
    expect((await platform.setStatus(P.cookie, acme, undefined)).status).toBe(400);
    expect(count("organizations", `id = '${acme}' AND status = 'active'`)).toBe(1);
  });
});

describe("customer users", () => {
  it("disabling a person signs them out at once and stops them signing in; enabling restores it", async () => {
    const sam = await signedIn(acme);
    const res = await platform.setUser(P.cookie, sam.userId, "disabled");
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ user: { userId: sam.userId, email: sam.email, status: "disabled" } });

    expect((await call(documentsRoute.GET, "/api/documents", { cookie: sam.cookie })).status).toBe(401);
    const blocked = await login(sam.email);
    expect(blocked.status).toBe(401);
    expect(await body(blocked)).toEqual({ error: "Invalid email or password." });
    const detail = await body<PlatformOrganizationDetailDTO>(await platform.get(P.cookie, acme));
    expect(detail.members.find((m) => m.userId === sam.userId)?.userStatus).toBe("disabled");

    expect((await platform.setUser(P.cookie, sam.userId, "active")).status).toBe(200);
    expect((await login(sam.email)).status).toBe(200);
    expect(audit("action IN ('platform.user.disable','platform.user.enable')").map((r) => [r.action, r.target_label])).toEqual([
      ["platform.user.disable", sam.email],
      ["platform.user.enable", sam.email],
    ]);
  });

  it("a disabled person is cut off in every workspace they belong to", async () => {
    const both = await signedIn(acme);
    new IdentityRepository(db).addMember(globex, both.userId, "member");
    await platform.setUser(P.cookie, both.userId, "disabled");
    expect((await login(both.email)).status).toBe(401);
    expect(count("auth_sessions", `user_id = '${both.userId}'`)).toBe(0);
  });

  it("protects the Super Admin accounts, and rejects unknown people and statuses", async () => {
    const second = seedMember(db, hq, "second-super@platform.test", "admin", { platformAdmin: true });
    expect((await platform.setUser(P.cookie, P.userId, "disabled")).status).toBe(409); // not yourself
    expect((await platform.setUser(P.cookie, second.userId, "disabled")).status).toBe(409); // nor another Super Admin
    expect((await platform.setUser(P.cookie, "00000000-0000-4000-8000-000000000009", "disabled")).status).toBe(404);
    expect((await platform.setUser(P.cookie, M.userId, "banned")).status).toBe(400);
    expect(count("users", "status = 'disabled'")).toBe(0);
  });
});

describe("Customer Admins manage only their own organization", () => {
  it("lists only their own people", async () => {
    const members = await body<{ members: { email: string }[] }>(await call(orgMembersRoute.GET, "/api/org/members", { cookie: O.cookie }));
    expect(members.members.map((m) => m.email).sort()).toEqual(["member@acme.test", "owner@acme.test"]);
  });

  it("can't change or remove another workspace's people", async () => {
    const patch = await call(orgMemberRoute.PATCH, `/api/org/members/${G.userId}`, { method: "PATCH", cookie: O.cookie, json: { role: "viewer" }, params: { userId: G.userId } });
    const del = await call(orgMemberRoute.DELETE, `/api/org/members/${G.userId}`, { method: "DELETE", cookie: O.cookie, params: { userId: G.userId } });
    expect([patch.status, del.status]).toEqual([404, 404]);
    expect(db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(globex, G.userId)).toEqual({ role: "owner" });
  });

  it("can't revoke another workspace's invitation", async () => {
    const made = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: G.cookie, json: { email: "x@globex.test", role: "member" } });
    const id = (await body<{ invitation: { id: string } }>(made)).invitation.id;
    const res = await call(orgInvitationRoute.DELETE, `/api/org/invitations/${id}`, { method: "DELETE", cookie: O.cookie, params: { id } });
    expect(res.status).toBe(404);
    expect(count("invitations", `id = '${id}' AND revoked_at IS NULL`)).toBe(1);
  });

  it("can't suspend, disable or inspect anything outside their own workspace, and a suspended workspace's admin is cut off", async () => {
    expect((await platform.setStatus(O.cookie, globex, "suspended")).status).toBe(403);
    expect((await platform.setUser(O.cookie, G.userId, "disabled")).status).toBe(403);
    expect((await platform.get(O.cookie, globex)).status).toBe(403);
    expect(count("organizations", "status = 'suspended'")).toBe(0);
    expect(count("users", "status = 'disabled'")).toBe(0);
  });
});

describe("audit trail", () => {
  it("records Customer Admin changes in their own workspace: who, what, which workspace", async () => {
    const invited = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: "new@acme.test", role: "viewer" } });
    const { invitation, url } = await body<{ invitation: { id: string }; url: string }>(invited);
    issuedTokens.push(tokenOf(url));
    await call(orgInvitationRoute.DELETE, `/api/org/invitations/${invitation.id}`, { method: "DELETE", cookie: O.cookie, params: { id: invitation.id } });
    await call(orgMemberRoute.PATCH, `/api/org/members/${M.userId}`, { method: "PATCH", cookie: O.cookie, json: { role: "admin" }, params: { userId: M.userId } });
    await call(orgMemberRoute.DELETE, `/api/org/members/${M.userId}`, { method: "DELETE", cookie: O.cookie, params: { userId: M.userId } });

    const rows = audit("actor_email = 'owner@acme.test'");
    expect(rows.map((r) => r.action)).toEqual(["org.invitation.create", "org.invitation.revoke", "org.member.role_change", "org.member.remove"]);
    expect(rows.every((r) => r.target_org_id === acme && r.actor_org_id === acme && r.outcome === "success")).toBe(true);
    expect(JSON.parse(rows[0]!.details)).toEqual({ role: "viewer" });
    expect(rows[0]).toMatchObject({ target_label: "new@acme.test" });
    expect(JSON.parse(rows[2]!.details)).toEqual({ from: "member", to: "admin" });
    expect(rows[2]).toMatchObject({ target_user_id: M.userId });
    expect(rows[3]).toMatchObject({ target_user_id: M.userId });
    expect(JSON.stringify(audit())).not.toContain(issuedTokens[0]!);
  });

  it("a refused or failed change leaves no 'success' record", async () => {
    await call(orgMemberRoute.PATCH, `/api/org/members/${O.userId}`, { method: "PATCH", cookie: O.cookie, json: { role: "member" }, params: { userId: O.userId } }); // last owner: 409
    await call(orgMemberRoute.PATCH, `/api/org/members/${G.userId}`, { method: "PATCH", cookie: O.cookie, json: { role: "viewer" }, params: { userId: G.userId } }); // other workspace: 404
    expect(audit("action LIKE 'org.%'")).toEqual([]);
  });

  it("a change and its record succeed or fail together: no record, no change", async () => {
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");

    expect((await platform.create(P.cookie, { name: "Hooli", adminEmail: "gavin@hooli.test" })).status).toBe(500);
    expect(count("organizations", "name = 'Hooli'")).toBe(0);
    expect(count("invitations", "email = 'gavin@hooli.test'")).toBe(0);

    expect((await platform.setStatus(P.cookie, acme, "suspended")).status).toBe(500);
    expect(count("organizations", `id = '${acme}' AND status = 'active'`)).toBe(1);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(200); // sessions were not ended either

    expect((await platform.setUser(P.cookie, M.userId, "disabled")).status).toBe(500);
    expect(count("users", `id = '${M.userId}' AND status = 'active'`)).toBe(1);

    const role = await call(orgMemberRoute.PATCH, `/api/org/members/${M.userId}`, { method: "PATCH", cookie: O.cookie, json: { role: "admin" }, params: { userId: M.userId } });
    expect(role.status).toBe(500);
    expect(db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").get(acme, M.userId)).toEqual({ role: "member" });

    expect((await platform.list(P.cookie)).status).toBe(500); // even a read needs its record

    db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");
    expect((await platform.list(P.cookie)).status).toBe(200);
  });

  it("an invitation is not used up when its record can't be written", async () => {
    const { orgId, token } = legacyCustomer();
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");
    const res = await accept(token, { password: "a long enough password" });
    db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");

    expect(res.status).toBe(500);
    expect(count("users", "email = 'boss@initech.test'")).toBe(0);
    expect(count("memberships", `org_id = '${orgId}'`)).toBe(0);
    expect((await peek(token)).status).toBe(200); // still usable
  });

  it("is append-only", () => {
    db.prepare("INSERT INTO audit_log (action) VALUES ('x')").run();
    expect(() => db.prepare("UPDATE audit_log SET action = 'y'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_log").run()).toThrow(/append-only/);
  });

  it("records Super Admin sign-ins (and only theirs)", async () => {
    const superEmail = fresh("boss");
    const s = await user(superEmail);
    new IdentityRepository(db).addMember(hq, s.id, "owner");
    new IdentityRepository(db).setPlatformAdmin(s.id, true);
    await login(superEmail);
    await signedIn(acme); // an ordinary sign-in

    const rows = audit("action = 'auth.platform_admin.login'");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_email: superEmail, actor_org_id: hq });
  });

  it("never stores a password, token, hash or cookie, whatever a caller tries to put in the details", () => {
    const clean = sanitizeDetails({
      role: "viewer",
      count: 3,
      ok: true,
      none: null,
      password: "hunter2hunter2",
      newPassword: "x",
      inviteToken: "abc",
      apiKey: "k",
      cookie: "kb_session=abc",
      password_hash: "scrypt$1",
      Authorization: "Bearer x",
      link: "A".repeat(43),
      note: "word ".repeat(100),
      nested: { a: 1 },
      list: [1, 2],
      id: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(clean).toEqual({ role: "viewer", count: 3, ok: true, none: null, link: "[redacted]", note: "word ".repeat(100).slice(0, 200), id: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("nothing in the log holds any link, token or password issued during a busy session", async () => {
    const a = await createCustomer();
    const b = await createCustomer("Hooli", "gavin@hooli.test");
    const extra = await body<{ credentials: IssuedCredentialsDTO }>(await platform.addAdmin(P.cookie, b.orgId, "second@hooli.test"));
    const c = legacyCustomer("Pied Piper", "richard@piedpiper.test");
    await accept(c.token, { password: "a long enough password" });
    await platform.setStatus(P.cookie, b.orgId, "suspended");
    issuedTokens.push(a.password, b.password, extra.credentials.temporaryPassword);

    const everything = JSON.stringify(audit());
    for (const token of issuedTokens) expect(everything).not.toContain(token);
    expect(everything).not.toMatch(/a long enough password|scrypt|kb_session/);
  });

  describe("reading it", () => {
    async function seedActivity() {
      await createCustomer();
      await platform.setStatus(P.cookie, acme, "suspended");
      await platform.setStatus(P.cookie, acme, "active");
    }

    it("shows newest first, with who/what/where, and nothing sensitive", async () => {
      await seedActivity();
      const res = await platform.audit(P.cookie);
      expect(res.status).toBe(200);
      const { entries } = await body<{ entries: AuditEntryDTO[] }>(res);

      expect(entries.map((e) => e.action).slice(0, 3)).toEqual(["platform.organization.reactivate", "platform.organization.suspend", "platform.organization.create"]);
      expect(entries[0]).toMatchObject({ actorEmail: "super@platform.test", targetLabel: "Acme", outcome: "success" });
      expect(entries.map((e) => e.id)).toEqual([...entries.map((e) => e.id)].sort((x, y) => y - x));
      expect(Object.keys(entries[0]!).sort()).toEqual(["action", "actorEmail", "at", "details", "id", "ip", "outcome", "targetLabel", "targetOrgId"]);
    });

    it("filters by workspace and action, and pages with limit and before", async () => {
      await seedActivity();
      const only = await body<{ entries: AuditEntryDTO[] }>(await platform.audit(P.cookie, `?workspace=${acme}`));
      expect(only.entries.length).toBeGreaterThan(0);
      expect(only.entries.every((e) => e.targetOrgId === acme)).toBe(true);

      const byAction = await body<{ entries: AuditEntryDTO[] }>(await platform.audit(P.cookie, "?action=platform.organization.create"));
      expect(byAction.entries.map((e) => e.action)).toEqual(["platform.organization.create"]);

      const page1 = await body<{ entries: AuditEntryDTO[] }>(await platform.audit(P.cookie, "?limit=2"));
      expect(page1.entries).toHaveLength(2);
      const page2 = await body<{ entries: AuditEntryDTO[] }>(await platform.audit(P.cookie, `?limit=2&before=${page1.entries[1]!.id}`));
      expect(page2.entries.every((e) => e.id < page1.entries[1]!.id)).toBe(true);
    });

    it("rejects nonsense parameters, and reading the log is itself recorded", async () => {
      expect((await platform.audit(P.cookie, "?limit=0")).status).toBe(400);
      expect((await platform.audit(P.cookie, "?limit=100000")).status).toBe(400);
      expect((await platform.audit(P.cookie, "?before=abc")).status).toBe(400);
      await platform.audit(P.cookie, "?limit=5");
      expect(audit("action = 'platform.audit.view'")).toHaveLength(1);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Suspending, reactivating and deleting a customer.

const FUTURE = () => new Date(Date.now() + 86_400_000).toISOString();

/** One row in every kind of table a customer's data lives in (the platform's own tables are never part of this). */
function fillWorkspace(orgId: string, authorId: string, tag: string) {
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
  run("INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, status, chunk_count) VALUES (?, ?, ?, 'text/plain', 5, 'ready', 2)", `${tag}-doc`, orgId, `${tag}.txt`);
  for (const i of [0, 1]) {
    run("INSERT INTO chunks (id, document_id, chunk_index, content, embedding, embedding_model, org_id) VALUES (?, ?, ?, ?, x'00', 'm', ?)", `${tag}-chunk-${i}`, `${tag}-doc`, i, `${tag} secret text ${i}`, orgId);
  }
  run("INSERT INTO conversations (id, org_id, user_id, title) VALUES (?, ?, ?, ?)", `${tag}-chat`, orgId, authorId, `${tag} private chat`);
  run("INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, 'user', ?)", `${tag}-msg`, `${tag}-chat`, `${tag} private question`);
  run("INSERT INTO integration_connections (id, org_id, type, name, status) VALUES (?, ?, 'website', 'Website', 'connected')", `${tag}-int`, orgId);
  run("INSERT INTO integration_credentials (integration_id, ciphertext, iv, auth_tag) VALUES (?, x'01', x'02', x'03')", `${tag}-int`);
  run("INSERT INTO integration_sync_runs (id, integration_id, status) VALUES (?, ?, 'success')", `${tag}-run`, `${tag}-int`);
  run("INSERT INTO oauth_states (state, integration_id, code_verifier) VALUES (?, ?, 'v')", `${tag}-state`, `${tag}-int`);
  run("INSERT INTO org_settings (org_id, key, value) VALUES (?, 'greeting', ?)", orgId, `${tag} hello`);
  run("INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, 'member', ?, ?, ?)", `${tag}-inv`, orgId, `${tag}-new@invited.test`, hashInviteToken(`${tag}-token`), authorId, FUTURE());
  // A Customer Admin invitation (issued by the Super Admin) with an activation code, as the earlier onboarding produced.
  run("INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at) VALUES (?, ?, ?, 'admin', 1, ?, ?, ?)", `${tag}-oinv`, orgId, `${tag}-boss@invited.test`, hashInviteToken(`${tag}-otoken`), P.userId, FUTURE());
  run("INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at) VALUES (?, ?, ?, 'h', ?)", `${tag}-code`, `${tag}-oinv`, `${tag}-boss@invited.test`, FUTURE());
}

/** Every row a workspace owns, table by table (directly, or through its parent row). */
const TENANT_ROWS: Record<string, string> = {
  documents: "SELECT * FROM documents WHERE org_id = :o ORDER BY id",
  chunks: "SELECT * FROM chunks WHERE org_id = :o ORDER BY id",
  conversations: "SELECT * FROM conversations WHERE org_id = :o ORDER BY id",
  messages: "SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.org_id = :o ORDER BY m.id",
  integration_connections: "SELECT * FROM integration_connections WHERE org_id = :o ORDER BY id",
  integration_credentials: "SELECT x.* FROM integration_credentials x JOIN integration_connections c ON c.id = x.integration_id WHERE c.org_id = :o ORDER BY x.integration_id",
  integration_sync_runs: "SELECT x.* FROM integration_sync_runs x JOIN integration_connections c ON c.id = x.integration_id WHERE c.org_id = :o ORDER BY x.id",
  oauth_states: "SELECT x.* FROM oauth_states x JOIN integration_connections c ON c.id = x.integration_id WHERE c.org_id = :o ORDER BY x.state",
  invitations: "SELECT * FROM invitations WHERE org_id = :o ORDER BY id",
  activation_codes: "SELECT a.* FROM activation_codes a JOIN invitations i ON i.id = a.invitation_id WHERE i.org_id = :o ORDER BY a.id",
  org_settings: "SELECT * FROM org_settings WHERE org_id = :o ORDER BY key",
  memberships: "SELECT * FROM memberships WHERE org_id = :o ORDER BY user_id",
  auth_sessions: "SELECT * FROM auth_sessions WHERE org_id = :o ORDER BY token_hash",
};
const tenantRows = (orgId: string) => Object.fromEntries(Object.entries(TENANT_ROWS).map(([table, sql]) => [table, db.prepare(sql).all({ o: orgId })]));
const total = (orgId: string) => Object.values(tenantRows(orgId)).reduce((n, rows) => n + rows.length, 0);

/** Everything that is NOT the workspace named (the other customers, the platform's own records, every other account). */
function everythingElse(except: { orgId: string; userIds: string[] }) {
  const notIn = except.userIds.length ? `id NOT IN (${except.userIds.map(() => "?").join(", ")})` : "1 = 1";
  return {
    tenants: Object.fromEntries([hq, globex].map((o) => [o, tenantRows(o)])),
    users: db.prepare(`SELECT * FROM users WHERE ${notIn} ORDER BY id`).all(...except.userIds),
    organizations: db.prepare("SELECT * FROM organizations WHERE id <> ? ORDER BY id").all(except.orgId),
    settings: ["app_settings", "provider_settings", "feature_flags"].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),
  };
}

const cleanStatus = (...orgs: string[]) => orgs.forEach((o) => db.prepare("UPDATE documents SET status = 'ready' WHERE org_id = ?").run(o)); // the shared fixture leaves its documents "processing"

describe("suspending and reactivating a customer", () => {
  it("answers with the workspace's new status each way, so the console can show it at once", async () => {
    const down = await platform.setStatus(P.cookie, acme, "suspended");
    expect(down.status).toBe(200);
    expect((await body<{ organization: PlatformOrganizationDTO }>(down)).organization).toMatchObject({ id: acme, name: "Acme", status: "suspended" });
    const up = await platform.setStatus(P.cookie, acme, "active");
    expect(up.status).toBe(200);
    expect((await body<{ organization: PlatformOrganizationDTO }>(up)).organization).toMatchObject({ id: acme, status: "active" });
    expect((await body<PlatformOrganizationDetailDTO>(await platform.get(P.cookie, acme))).organization.status).toBe("active");
  });

  it("changes only that customer: every other workspace, account and setting stays exactly as it was", async () => {
    fillWorkspace(acme, O.userId, "acme");
    fillWorkspace(globex, G.userId, "globex");
    // Everything but the workspace's own sign-ins (which suspending ends on purpose): its data, people, invitations and settings are kept.
    const state = () => ({ ...everythingElse({ orgId: acme, userIds: [] }), acme: { ...tenantRows(acme), auth_sessions: undefined } });
    const before = state();

    await platform.setStatus(P.cookie, acme, "suspended");
    expect(state()).toEqual(before);
    expect((db.prepare("SELECT status FROM organizations WHERE id = ?").get(acme) as { status: string }).status).toBe("suspended");
    await platform.setStatus(P.cookie, acme, "active");
    expect(state()).toEqual(before);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: G.cookie })).status).toBe(200); // Globex never noticed
  });

  it("while suspended nobody can use the workspace: no sign-in, no switching into it, no invitation, no API call", async () => {
    const sam = await signedIn(acme);
    const bothEmail = fresh("both");
    const both = await user(bothEmail);
    new IdentityRepository(db).addMember(acme, both.id, "member");
    new IdentityRepository(db).addMember(globex, both.id, "member");
    const invited = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: "late@acme.test", role: "viewer" } });
    const token = tokenOf((await body<{ url: string }>(invited)).url);

    await platform.setStatus(P.cookie, acme, "suspended");

    expect((await call(documentsRoute.GET, "/api/documents", { cookie: sam.cookie })).status).toBe(401);
    expect((await call(orgMembersRoute.GET, "/api/org/members", { cookie: O.cookie })).status).toBe(401);
    expect((await login(sam.email)).status).toBe(403);
    expect((await peek(token)).status).toBe(404);
    expect((await accept(token, { password: "abcd" })).status).toBe(404);
    const elsewhere = cookieFrom(await login(bothEmail)); // lands in the workspace that still works
    expect((await call(switchRoute.POST, "/api/auth/switch-org", { method: "POST", cookie: elsewhere, json: { orgId: acme } })).status).toBe(404);
    expect(count("auth_sessions", `org_id = '${acme}'`)).toBe(0);
  });

  it("reactivating restores access but never brings back credentials that had expired or been revoked, or earlier sign-ins", async () => {
    const live = await createCustomer("Live Co", "live@live.test");
    const revoked = await createCustomer("Revoked Co", "revoked@revoked.test");
    const lapsed = await createCustomer("Lapsed Co", "lapsed@lapsed.test");
    const idOf = (email: string) => (db.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
    expect((await platform.credentials(P.cookie, revoked.orgId, idOf(revoked.adminEmail), "revoke")).status).toBe(200);
    db.prepare("UPDATE users SET temp_password_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), idOf(lapsed.adminEmail));
    const ordinary = await signedIn(acme);

    for (const orgId of [live.orgId, revoked.orgId, lapsed.orgId, acme]) expect((await platform.setStatus(P.cookie, orgId, "suspended")).status).toBe(200);
    for (const orgId of [live.orgId, revoked.orgId, lapsed.orgId, acme]) expect((await platform.setStatus(P.cookie, orgId, "active")).status).toBe(200);

    expect((await login(live.adminEmail, live.password)).status).toBe(200); // still valid: it was never revoked or expired
    for (const dead of [revoked, lapsed]) {
      const res = await login(dead.adminEmail, dead.password);
      expect(res.status, dead.adminEmail).toBe(403);
      expect(await body(res)).toMatchObject({ code: "temporary_password_expired" });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: ordinary.cookie })).status).toBe(401); // the old sign-in is gone for good
    expect((await login(ordinary.email)).status).toBe(200); // a fresh one works
  });

  it("is recorded in the audit log each time, with who did it, and no secrets", async () => {
    await platform.setStatus(P.cookie, acme, "suspended");
    await platform.setStatus(P.cookie, acme, "active");
    const rows = audit("action IN ('platform.organization.suspend','platform.organization.reactivate')");
    expect(rows.map((r) => [r.action, r.outcome, r.actor_email, r.target_org_id, r.target_label])).toEqual([
      ["platform.organization.suspend", "success", "super@platform.test", acme, "Acme"],
      ["platform.organization.reactivate", "success", "super@platform.test", acme, "Acme"],
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/password|token|cookie|secret/i);
  });

  it("is refused with a clear message for an unknown workspace, an unknown status or the Super Admin's own workspace", async () => {
    const own = await platform.setStatus(P.cookie, hq, "suspended");
    expect(own.status).toBe(409);
    expect((await body<{ error: string }>(own)).error).toMatch(/signed in to|your own/i);
    expect((await platform.setStatus(P.cookie, "00000000-0000-4000-8000-000000000009", "active")).status).toBe(404);
    expect((await platform.setStatus(P.cookie, acme, "archived")).status).toBe(400);
    expect((await call(meRoute.GET, "/api/auth/me", { cookie: P.cookie })).status).toBe(200);
  });
});

describe("deleting a customer", () => {
  beforeEach(() => cleanStatus(acme, globex));

  it("removes the workspace and everything it owns, and nothing that belongs to anyone else", async () => {
    fillWorkspace(acme, O.userId, "acme");
    fillWorkspace(globex, G.userId, "globex");
    const members = [O.userId, M.userId];
    // Every kind of customer data really is there to be removed (so the test can't pass on an empty workspace).
    for (const [table, rows] of Object.entries(tenantRows(acme))) expect(rows.length, table).toBeGreaterThan(0);
    const others = everythingElse({ orgId: acme, userIds: members });
    const auditBefore = count("audit_log");

    const res = await platform.remove(P.cookie, acme, { confirmName: "Acme" });

    expect(res.status).toBe(200);
    const { deleted } = await body<{ deleted: Record<string, unknown> }>(res);
    expect(deleted).toMatchObject({ id: acme, name: "Acme", members: 2, accountsDeleted: 2, accountsKept: 0 });
    expect(deleted.data).toEqual({ documents: 2, conversations: 2, integrations: 1, consultations: 0 });

    expect(total(acme)).toBe(0); // not one row left in any customer table
    expect(count("organizations", `id = '${acme}'`)).toBe(0);
    expect(count("users", `id IN ('${O.userId}', '${M.userId}')`)).toBe(0); // the accounts that existed only for it
    for (const table of ["documents", "chunks", "conversations", "integration_connections", "invitations", "org_settings", "memberships", "auth_sessions"]) {
      expect(count(table, `org_id = '${acme}'`), table).toBe(0);
    }
    expect(everythingElse({ orgId: acme, userIds: members })).toEqual(others); // everybody else: byte for byte the same
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(count("audit_log")).toBe(auditBefore + 1); // exactly one new record: the deletion
    // The Super Admin is still the Super Admin, in their own workspace.
    expect(db.prepare("SELECT is_platform_admin AS a, status FROM users WHERE id = ?").get(P.userId)).toEqual({ a: 1, status: "active" });
    expect((await call(meRoute.GET, "/api/auth/me", { cookie: P.cookie })).status).toBe(200);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: G.cookie })).status).toBe(200);
  });

  it("makes the customer disappear from the console, and its people, sessions and invitation links stop working", async () => {
    const invited = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: "late@acme.test", role: "viewer" } });
    const token = tokenOf((await body<{ url: string }>(invited)).url);
    const sam = await signedIn(acme);
    expect((await peek(token)).status).toBe(200);

    expect((await platform.remove(P.cookie, acme, { confirmName: "acme" })).status).toBe(200);

    const { organizations } = await body<{ organizations: PlatformOrganizationDTO[] }>(await platform.list(P.cookie));
    expect(organizations.map((o) => o.id)).not.toContain(acme);
    expect(organizations.map((o) => o.id)).toContain(globex);
    expect((await platform.get(P.cookie, acme)).status).toBe(404);
    for (const cookie of [O.cookie, M.cookie, sam.cookie]) expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(401);
    expect((await login(sam.email)).status).toBe(401); // the account is gone (an unknown account and a wrong password look the same)
    expect((await login("owner@acme.test")).status).toBe(401);
    expect((await peek(token)).status).toBe(404);
    expect((await accept(token, { password: "abcd" })).status).toBe(404);
    expect(count("users", "email = 'late@acme.test'")).toBe(0);
    expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(404); // deleting twice is a clean refusal
  });

  it("works for a suspended customer, an empty workspace, and one that has no people", async () => {
    await platform.setStatus(P.cookie, acme, "suspended");
    expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(200);

    const empty = seedOrganization(db, "Empty Co");
    const res = await platform.remove(P.cookie, empty, { confirmName: "Empty Co" });
    expect(res.status).toBe(200);
    expect(await body<{ deleted: unknown }>(res)).toMatchObject({ deleted: { members: 0, accountsDeleted: 0, accountsKept: 0, data: { documents: 0, conversations: 0, integrations: 0 } } });
  });

  it("deletes a customer made through the console, including its Customer Admin, and the name and email can be used again", async () => {
    const hooli = await createCustomer("Hooli", "gavin@hooli.test");
    expect((await platform.remove(P.cookie, hooli.orgId, { confirmName: " HOOLI " })).status).toBe(200); // capitals and surrounding spaces don't matter
    expect(count("users", "email = 'gavin@hooli.test'")).toBe(0);
    expect((await login("gavin@hooli.test", hooli.password)).status).toBe(401);

    const again = await createCustomer("Hooli", "gavin@hooli.test");
    expect(again.orgId).not.toBe(hooli.orgId);
    expect((await login("gavin@hooli.test", again.password)).status).toBe(200);
  });

  describe("accounts that belong to anything outside the workspace are kept, so nothing else is deleted with them", () => {
    it("someone who is also a member of another customer keeps their account and that membership", async () => {
      const shared = await signedIn(acme);
      new IdentityRepository(db).addMember(globex, shared.userId, "member");
      const globexPeople = () => (db.prepare("SELECT user_id FROM memberships WHERE org_id = ? ORDER BY user_id").all(globex) as { user_id: string }[]).map((r) => r.user_id);
      const before = globexPeople();
      expect(before).toContain(shared.userId);

      const res = await platform.remove(P.cookie, acme, { confirmName: "Acme" });

      expect((await body<{ deleted: Record<string, unknown> }>(res)).deleted).toMatchObject({ members: 3, accountsDeleted: 2, accountsKept: 1 });
      expect(count("users", `id = '${shared.userId}'`)).toBe(1);
      expect(count("memberships", `org_id = '${acme}'`)).toBe(0); // no longer of Acme...
      expect(globexPeople()).toEqual(before); // ...and still of Globex
      expect((await login(shared.email)).status).toBe(200); // so they can still sign in, to Globex
    });

    it("someone who has chats in another customer's workspace keeps their account, and those chats survive", async () => {
      const x = await user(fresh("x"));
      new IdentityRepository(db).addMember(acme, x.id, "member");
      db.prepare("INSERT INTO conversations (id, org_id, user_id, title) VALUES ('globex-chat-x', ?, ?, 'a chat in Globex')").run(globex, x.id); // no longer a member there, but the chat is
      db.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES ('globex-msg-x', 'globex-chat-x', 'user', 'hello')").run();

      const res = await platform.remove(P.cookie, acme, { confirmName: "Acme" });

      expect((await body<{ deleted: Record<string, unknown> }>(res)).deleted).toMatchObject({ accountsKept: 1 });
      expect(count("users", `id = '${x.id}'`)).toBe(1);
      expect(count("conversations", "id = 'globex-chat-x'")).toBe(1);
      expect(count("messages", "id = 'globex-msg-x'")).toBe(1);
    });

    it("someone who issued an invitation for another customer keeps their account, and that invitation survives", async () => {
      const y = await user(fresh("y"));
      new IdentityRepository(db).addMember(acme, y.id, "admin");
      db.prepare("INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('globex-inv-y', ?, 'friend@globex.test', 'member', ?, ?, ?)").run(globex, hashInviteToken("y"), y.id, FUTURE());

      const res = await platform.remove(P.cookie, acme, { confirmName: "Acme" });

      expect((await body<{ deleted: Record<string, unknown> }>(res)).deleted).toMatchObject({ accountsKept: 1 });
      expect(count("users", `id = '${y.id}'`)).toBe(1);
      expect(count("invitations", "id = 'globex-inv-y'")).toBe(1);
    });
  });

  describe("protections", () => {
    const untouched = async (name = "Acme") => {
      expect(count("organizations", `name = '${name}'`)).toBe(1);
      expect(count("users", `id IN ('${O.userId}', '${M.userId}')`)).toBe(2);
      expect(count("audit_log", "action = 'platform.organization.delete'")).toBe(0);
      expect((await call(documentsRoute.GET, "/api/documents", { cookie: O.cookie })).status).toBe(200); // nobody was even signed out
    };

    it("needs the exact workspace name: a missing, empty, wrong or malformed confirmation deletes nothing", async () => {
      fillWorkspace(acme, O.userId, "acme");
      const before = tenantRows(acme);
      for (const json of [undefined, {}, { confirmName: "" }, { confirmName: "   " }, { confirmName: "Acm" }, { confirmName: "Globex" }, { confirmName: "Acme Corp" }, { confirmName: 5 }, { confirmName: null }, { confirmName: "Acme", force: true }, { confirmName: "x".repeat(300) }]) {
        const res = await platform.remove(P.cookie, acme, json);
        expect(res.status, JSON.stringify(json)).toBe(400);
        expect((await body<{ error: string }>(res)).error).toMatch(/name/i);
      }
      expect(tenantRows(acme)).toEqual(before);
      await untouched();
    });

    it("refuses an unknown workspace, even with a name that looks right", async () => {
      const res = await platform.remove(P.cookie, "00000000-0000-4000-8000-000000000009", { confirmName: "Acme" });
      expect(res.status).toBe(404);
      await untouched();
    });

    it("refuses the workspace the Super Admin is signed in to, and any workspace that contains a Super Admin", async () => {
      const own = await platform.remove(P.cookie, hq, { confirmName: "Platform HQ" });
      expect(own.status).toBe(409);
      expect((await body<{ error: string }>(own)).error).toMatch(/signed in to this workspace/);
      expect(count("organizations", `id = '${hq}'`)).toBe(1);

      new IdentityRepository(db).addMember(acme, P.userId, "admin"); // a Super Admin who is also a member of Acme
      const shared = await platform.remove(P.cookie, acme, { confirmName: "Acme" });
      expect(shared.status).toBe(409);
      expect((await body<{ error: string }>(shared)).error).toMatch(/Super Admin/);
      const second = seedMember(db, globex, "second-super@platform.test", "member", { platformAdmin: true });
      expect((await platform.remove(P.cookie, globex, { confirmName: "Globex" })).status).toBe(409);
      expect(count("users", `id = '${second.userId}' AND is_platform_admin = 1`)).toBe(1);
      expect(count("organizations", `id IN ('${acme}', '${globex}')`)).toBe(2);
      expect(count("audit_log", "action = 'platform.organization.delete'")).toBe(0);
    });

    it("refuses while a document is still being processed or an integration sync is running, and works once they finish", async () => {
      fillWorkspace(acme, O.userId, "acme");
      db.prepare("UPDATE documents SET status = 'processing' WHERE id = 'acme-doc'").run();
      const processing = await platform.remove(P.cookie, acme, { confirmName: "Acme" });
      expect(processing.status).toBe(409);
      expect((await body<{ error: string }>(processing)).error).toMatch(/still being processed/);
      await untouched();

      db.prepare("UPDATE documents SET status = 'ready' WHERE id = 'acme-doc'").run();
      db.prepare("UPDATE integration_sync_runs SET status = 'running' WHERE id = 'acme-run'").run();
      const syncing = await platform.remove(P.cookie, acme, { confirmName: "Acme" });
      expect(syncing.status).toBe(409);
      expect((await body<{ error: string }>(syncing)).error).toMatch(/sync is still running/);
      await untouched();

      db.prepare("UPDATE integration_sync_runs SET status = 'success' WHERE id = 'acme-run'").run();
      expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(200);
      expect(total(acme)).toBe(0);
    });

    it("is all or nothing: if the audit record can't be written, no row is deleted and nobody is signed out", async () => {
      fillWorkspace(acme, O.userId, "acme");
      const before = tenantRows(acme);
      const others = everythingElse({ orgId: acme, userIds: [O.userId, M.userId] });
      db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");

      expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(500);

      db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");
      expect(tenantRows(acme)).toEqual(before);
      expect(everythingElse({ orgId: acme, userIds: [O.userId, M.userId] })).toEqual(others);
      await untouched();
      expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(200); // and it works once the record can be written
    });

    it("is all or nothing when the database itself refuses part of the deletion", async () => {
      fillWorkspace(acme, O.userId, "acme");
      const before = tenantRows(acme);
      db.exec(`CREATE TRIGGER block_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused'); END`);

      expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(500); // the organization row went first, then the users failed

      db.exec("DROP TRIGGER block_user_delete");
      expect(tenantRows(acme)).toEqual(before); // so the organization and everything under it came back
      await untouched();
    });

    it("can't be asked for by a Customer Admin, a member or a signed-out caller (and a cross-site request is refused)", async () => {
      const before = tenantRows(acme);
      expect((await platform.remove(undefined, acme, { confirmName: "Acme" })).status).toBe(401);
      for (const caller of [O, M, G]) expect((await platform.remove(caller.cookie, acme, { confirmName: "Acme" })).status, caller.email).toBe(403);
      const cross = await call(platformOrgRoute.DELETE, `/api/platform/organizations/${acme}`, {
        method: "DELETE",
        cookie: P.cookie,
        json: { confirmName: "Acme" },
        params: { id: acme },
        headers: { origin: "https://evil.example", host: "localhost:3000" },
      });
      expect(cross.status).toBe(403);
      expect(tenantRows(acme)).toEqual(before);
      await untouched();
      expect(audit("action = 'platform.access_denied'").length).toBeGreaterThanOrEqual(3); // the refused attempts are recorded
    });
  });

  describe("the audit record", () => {
    it("says who deleted which customer and how much went with it, and holds no customer content or secret", async () => {
      fillWorkspace(acme, O.userId, "acme");
      await platform.setStatus(P.cookie, acme, "suspended"); // earlier history of this customer
      await platform.setStatus(P.cookie, acme, "active");

      expect((await platform.remove(P.cookie, acme, { confirmName: "Acme" })).status).toBe(200);

      const [row, ...extra] = audit("action = 'platform.organization.delete'");
      expect(extra).toEqual([]);
      expect(row).toMatchObject({ actor_user_id: P.userId, actor_email: "super@platform.test", actor_org_id: hq, target_org_id: acme, target_label: "Acme", outcome: "success", target_user_id: null });
      expect(JSON.parse(row!.details)).toEqual({ members: 2, accountsDeleted: 2, accountsKept: 0, documents: 2, conversations: 2, integrations: 1, consultations: 0 });
      const everything = JSON.stringify(audit());
      for (const secret of ["acme secret text", "acme private chat", "acme private question", "ACME-SECRET-PLAN", "ACME-PRIVATE-CHAT", "acme-token", "acme-otoken", PASSWORD]) expect(everything, secret).not.toContain(secret);
    });

    it("keeps the customer's earlier history, and the console's audit log still shows the deletion", async () => {
      await platform.setStatus(P.cookie, acme, "suspended");
      await platform.setStatus(P.cookie, acme, "active");
      await platform.remove(P.cookie, acme, { confirmName: "Acme" });

      expect(audit("target_org_id = ?", acme).map((r) => r.action)).toEqual(["platform.organization.suspend", "platform.organization.reactivate", "platform.organization.delete"]);
      const { entries } = await body<{ entries: AuditEntryDTO[] }>(await platform.audit(P.cookie, `?workspace=${acme}`));
      expect(entries.map((e) => e.action)).toEqual(["platform.organization.delete", "platform.organization.reactivate", "platform.organization.suspend"]);
      expect(entries[0]).toMatchObject({ targetLabel: "Acme", outcome: "success", actorEmail: "super@platform.test" });
      expect(() => db.prepare("DELETE FROM audit_log WHERE target_org_id = ?").run(acme)).toThrow(/append-only/); // and it can't be erased
    });

    it("records nothing as a success when the deletion was refused", async () => {
      await platform.remove(P.cookie, acme, { confirmName: "wrong" });
      await platform.remove(P.cookie, hq, { confirmName: "Platform HQ" });
      expect(audit("action = 'platform.organization.delete'")).toEqual([]);
    });
  });
});
