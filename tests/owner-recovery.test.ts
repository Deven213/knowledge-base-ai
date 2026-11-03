import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { IdentityRepository } from "@/server/auth/identity";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import { DEFAULT_SCRYPT_PARAMS, hashPassword as appHashPassword, passwordProblem as appPasswordProblem, verifyPassword as appVerifyPassword } from "@/server/auth/password";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import { openDatabase } from "@/server/db/client";
import * as script from "../scripts/owner-recover.mjs";
import { body, call, FAST_PASSWORDS, seedOrganization } from "./harness";
import { memoryDb } from "./helpers";

// The owner account named in .env stopped being able to sign in after BOOTSTRAP_OWNER_EMAIL was changed to a new
// address. The application only ever CREATES the first owner from .env: the new address became a second, separate
// account that no workspace contains and that isn't a Super Admin (one already existed), so the sign-in page showed
// the generic "Invalid email or password" although the password was right. These tests reproduce that, then cover the
// fixes: a clear answer at sign-in, a warning at startup, and the explicit, audited recovery command.

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

import * as loginRoute from "@/app/api/auth/login/route";
import * as platformOrgsRoute from "@/app/api/platform/organizations/route";

const FIRST = { BOOTSTRAP_OWNER_EMAIL: "first.owner@jivan.test", BOOTSTRAP_OWNER_PASSWORD: "first owner passphrase", BOOTSTRAP_OWNER_NAME: "First Owner", DEMO_USER_EMAIL: "demo@knowledgebase.ai", DEMO_USER_PASSWORD: undefined } as const;
const SECOND = { ...FIRST, BOOTSTRAP_OWNER_EMAIL: "Second.Owner@demo.test ", BOOTSTRAP_OWNER_PASSWORD: "second owner passphrase" } as const; // as read from .env: not yet normalized
const SECOND_EMAIL = "second.owner@demo.test";
const FAST = { N: 1024, r: 8, p: 1 };

let db: Database.Database;
const identity = () => new IdentityRepository(db);
const user = (email: string) => identity().findUserByEmail(email);
const count = (sql: string, ...params: unknown[]) => (db.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params) as { n: number }).n;
const login = (email: string, password: string) => call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email, password } });
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

/** Every row that is not the second owner's own: the rest of the database must come through a recovery untouched. */
function everythingExceptOwner(ownerEmail: string) {
  const id = user(ownerEmail)?.id ?? "none";
  return {
    users: db.prepare("SELECT * FROM users WHERE id <> ? ORDER BY id").all(id),
    memberships: db.prepare("SELECT * FROM memberships WHERE user_id <> ? ORDER BY org_id, user_id").all(id),
    organizations: db.prepare("SELECT * FROM organizations ORDER BY id").all(),
    documents: db.prepare("SELECT * FROM documents ORDER BY id").all(),
    conversations: db.prepare("SELECT * FROM conversations ORDER BY id").all(),
    sessions: db.prepare("SELECT token_hash, user_id FROM auth_sessions WHERE user_id <> ? ORDER BY token_hash").all(id),
  };
}

let warn: MockInstance<typeof console.warn>;
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterAll(() => vi.restoreAllMocks());
beforeEach(() => {
  db = memoryDb();
  h.db = db;
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

/** The situation on the real machine: the first owner exists with data; then .env was edited to a different address. */
async function addressChangedInEnv() {
  db.prepare("INSERT INTO documents (id, filename, mime_type, size_bytes, status, org_id) VALUES ('legacy-doc', 'old.pdf', 'application/pdf', 1, 'ready', ?)").run(LEGACY_ORG_ID);
  await ensureBootstrap(db, FIRST, FAST);
  warn.mockClear();
  return ensureBootstrap(db, SECOND, FAST); // the next start, with the edited .env
}

describe("the root cause: an owner address added to .env after the first owner exists", () => {
  it("creates a separate account that nothing grants anything to, and says so in the log without printing any secret", async () => {
    const summary = await addressChangedInEnv();

    expect(summary).toMatchObject({ owner: "created", ownerAccess: "no-workspace" });
    const second = user(SECOND_EMAIL)!;
    expect(second.is_platform_admin).toBe(0); // a Super Admin already existed
    expect(identity().organizationsOf(second.id)).toEqual([]); // the Default workspace already had an owner
    expect(user("first.owner@jivan.test")).toMatchObject({ is_platform_admin: 1 }); // the original account is untouched
    expect(count("users WHERE lower(trim(email)) = ?", SECOND_EMAIL)).toBe(1); // normalized once: no duplicate under another spelling

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/cannot sign in: it belongs to no workspace/);
    expect(logged).toContain("npm run owner:recover");
    expect(logged).toContain("se***@demo.test"); // recognisable, not complete
    for (const secret of ["second owner passphrase", "first owner passphrase", SECOND_EMAIL, "scrypt$"]) expect(logged).not.toContain(secret);
  });

  it("answers a correct password with a clear reason, and still refuses a wrong one or an unknown address with the same generic message", async () => {
    await addressChangedInEnv();

    const right = await login(SECOND_EMAIL, "second owner passphrase");
    expect(right.status).toBe(403);
    expect(await body(right)).toMatchObject({ code: "no_workspace", error: expect.stringMatching(/doesn't belong to any workspace/) });
    expect(right.headers.get("set-cookie")).toBeNull(); // no session

    const wrong = await login(SECOND_EMAIL, "not the passphrase");
    const unknown = await login("nobody@demo.test", "second owner passphrase");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const [wrongBody, unknownBody] = [await body(wrong), await body(unknown)];
    expect(wrongBody).toEqual(unknownBody); // nothing about the account leaks without the password
    expect(wrongBody).toEqual({ error: "Invalid email or password." });
  });

  it("the original owner address keeps working throughout", async () => {
    await addressChangedInEnv();
    const res = await login("first.owner@jivan.test", "first owner passphrase");
    expect(res.status).toBe(200);
    expect((await call(platformOrgsRoute.GET, "/api/platform/organizations", { cookie: cookieFrom(res) })).status).toBe(200); // and it is still a Super Admin
  });
});

describe("the recovery command", () => {
  const second = { email: SECOND_EMAIL, password: "second owner passphrase", params: FAST };

  it("a dry run reports what is wrong and what would change, and changes nothing (not even an audit row)", async () => {
    await addressChangedInEnv();
    const before = { rest: everythingExceptOwner(SECOND_EMAIL), owner: user(SECOND_EMAIL), audit: count("audit_log") };

    const result = script.recoverOwner(db, second);

    expect(result.applied).toBe(false);
    expect(result.before).toMatchObject({ exists: true, status: "active", isSuperAdmin: false, canSignIn: false, passwordMatchesEnv: true, workspaces: [], otherSuperAdmins: 1 });
    expect(result.plan.steps.map((s) => s.code)).toEqual(["join-default-workspace", "make-super-admin"]);
    expect(result.plan.notes.join(" ")).toMatch(/other active Super Admin.*not changed.*Nobody is demoted/);
    expect({ rest: everythingExceptOwner(SECOND_EMAIL), owner: user(SECOND_EMAIL), audit: count("audit_log") }).toEqual(before);
  });

  it("--apply makes the .env address a Super Admin and an owner of the Default workspace: it can sign in and open the console", async () => {
    await addressChangedInEnv();
    const rest = everythingExceptOwner(SECOND_EMAIL);
    const usersBefore = count("users");
    const firstHash = user("first.owner@jivan.test")!.password_hash;

    const result = script.recoverOwner(db, { ...second, apply: true });

    expect(result.applied).toBe(true);
    expect(result.after).toMatchObject({ canSignIn: true, isSuperAdmin: true, passwordMatchesEnv: true });
    expect(result.after.workspaces).toEqual([expect.objectContaining({ id: LEGACY_ORG_ID, role: "owner", status: "active" })]);
    expect(count("users")).toBe(usersBefore); // no duplicate user
    expect(everythingExceptOwner(SECOND_EMAIL)).toEqual(rest); // nobody else, no customer workspace, document or chat was touched
    expect(user("first.owner@jivan.test")).toMatchObject({ is_platform_admin: 1, password_hash: firstHash }); // nobody demoted, no password changed

    const res = await login(SECOND_EMAIL, "second owner passphrase");
    expect(res.status).toBe(200);
    expect((await call(platformOrgsRoute.GET, "/api/platform/organizations", { cookie: cookieFrom(res) })).status).toBe(200);
    expect((await login("first.owner@jivan.test", "first owner passphrase")).status).toBe(200);
  });

  it("is safe to repeat: the second run changes nothing and writes nothing", async () => {
    await addressChangedInEnv();
    script.recoverOwner(db, { ...second, apply: true });
    const snapshot = { rest: everythingExceptOwner(SECOND_EMAIL), owner: user(SECOND_EMAIL), memberships: count("memberships"), audit: count("audit_log") };

    const again = script.recoverOwner(db, { ...second, apply: true });

    expect(again.applied).toBe(false);
    expect(again.plan.steps).toEqual([]);
    expect({ rest: everythingExceptOwner(SECOND_EMAIL), owner: user(SECOND_EMAIL), memberships: count("memberships"), audit: count("audit_log") }).toEqual(snapshot);
  });

  it("writes one audit record that says what was done and holds no password, hash or token", async () => {
    await addressChangedInEnv();
    script.recoverOwner(db, { ...second, apply: true });

    const rows = db.prepare("SELECT * FROM audit_log WHERE action = 'platform.owner.recover'").all() as { target_user_id: string; target_label: string; outcome: string; actor_user_id: string | null; details: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target_user_id: user(SECOND_EMAIL)!.id, target_label: SECOND_EMAIL, outcome: "success", actor_user_id: null });
    expect(JSON.parse(rows[0]!.details)).toEqual({ joinedDefault: true, superAdmin: true, via: "owner-recover command" });
    expect(JSON.stringify(rows)).not.toMatch(/passphrase|scrypt|password|token/i);
    expect(() => db.prepare("DELETE FROM audit_log WHERE action = 'platform.owner.recover'").run()).toThrow(/append-only/);
  });

  it("creates the account when the address has none, normalizing the email so it can't be created twice under another spelling", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    expect(user(SECOND_EMAIL)).toBeUndefined();

    const result = script.recoverOwner(db, { email: "  Second.Owner@DEMO.test ", password: "second owner passphrase", name: "Second", apply: true, params: FAST });

    expect(result.plan.steps.map((s) => s.code)).toEqual(["create-account", "join-default-workspace", "make-super-admin"]);
    const created = user(SECOND_EMAIL)!;
    expect(created).toMatchObject({ email: SECOND_EMAIL, display_name: "Second", is_platform_admin: 1, status: "active", must_change_password: 0 });
    expect(await appVerifyPassword("second owner passphrase", created.password_hash)).toBe(true);
    expect(created.password_hash).not.toContain("passphrase");
    script.recoverOwner(db, { email: "SECOND.OWNER@demo.test", password: "second owner passphrase", apply: true, params: FAST });
    expect(count("users WHERE lower(email) = ?", SECOND_EMAIL)).toBe(1);
    expect((await login(SECOND_EMAIL, "second owner passphrase")).status).toBe(200);
  });

  it("never changes a password unless asked: a stale .env password is reported, and --reset-password replaces it and ends the sessions", async () => {
    await addressChangedInEnv();
    script.recoverOwner(db, { ...second, apply: true });
    const cookie = cookieFrom(await login(SECOND_EMAIL, "second owner passphrase"));
    expect(count("auth_sessions WHERE user_id = ?", user(SECOND_EMAIL)!.id)).toBe(1);
    const staleEnv = { email: SECOND_EMAIL, password: "a newer passphrase in .env", params: FAST };
    const hash = user(SECOND_EMAIL)!.password_hash;

    const reported = script.recoverOwner(db, { ...staleEnv, apply: true }); // no --reset-password
    expect(reported.plan.notes.join(" ")).toMatch(/does NOT match the stored password.*never changes an existing account's password/);
    expect(reported.before.passwordMatchesEnv).toBe(false);
    expect(user(SECOND_EMAIL)!.password_hash).toBe(hash);
    expect(count("auth_sessions WHERE user_id = ?", user(SECOND_EMAIL)!.id)).toBe(1);

    const reset = script.recoverOwner(db, { ...staleEnv, apply: true, resetPassword: true });
    expect(reset.applied).toBe(true);
    expect(await appVerifyPassword("a newer passphrase in .env", user(SECOND_EMAIL)!.password_hash)).toBe(true);
    expect(await appVerifyPassword("second owner passphrase", user(SECOND_EMAIL)!.password_hash)).toBe(false);
    expect(count("auth_sessions WHERE user_id = ?", user(SECOND_EMAIL)!.id)).toBe(0);
    expect((await call(platformOrgsRoute.GET, "/api/platform/organizations", { cookie })).status).toBe(401);
    expect((await login(SECOND_EMAIL, "a newer passphrase in .env")).status).toBe(200);
  });

  it("--reset-password clears a pending forced change and expiry, so the .env password simply works", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    const temp = identity().createUser({ email: SECOND_EMAIL, passwordHash: await appHashPassword("a temporary one", FAST), temporaryUntil: new Date(Date.now() - 1000).toISOString() });
    expect(temp.must_change_password).toBe(1);

    script.recoverOwner(db, { ...second, apply: true, resetPassword: true });

    expect(user(SECOND_EMAIL)).toMatchObject({ must_change_password: 0, temp_password_expires_at: null, is_platform_admin: 1 });
    expect((await login(SECOND_EMAIL, "second owner passphrase")).status).toBe(200);
  });

  it("enables a disabled account", async () => {
    await addressChangedInEnv();
    identity().setUserStatus(user(SECOND_EMAIL)!.id, "disabled");
    expect((await login(SECOND_EMAIL, "second owner passphrase")).status).toBe(401); // a disabled account looks like any wrong login

    const result = script.recoverOwner(db, { ...second, apply: true });

    expect(result.plan.steps.map((s) => s.code)).toContain("enable-account");
    expect(user(SECOND_EMAIL)!.status).toBe("active");
    expect((await login(SECOND_EMAIL, "second owner passphrase")).status).toBe(200);
  });

  it("an account that can already sign in to a workspace is not moved into the Default workspace", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    const customer = seedOrganization(db, "Customer Co");
    const account = identity().createUser({ email: SECOND_EMAIL, passwordHash: await appHashPassword("second owner passphrase", FAST) });
    identity().addMember(customer, account.id, "owner");

    const result = script.recoverOwner(db, { ...second, apply: true });

    expect(result.plan.steps.map((s) => s.code)).toEqual(["make-super-admin"]);
    expect(identity().organizationsOf(account.id).map((o) => o.orgId)).toEqual([customer]);
  });

  describe("refuses, and changes nothing, when it can't do the job safely", () => {
    it("a password that breaks the rules can't be used to create or reset an account", async () => {
      await ensureBootstrap(db, FIRST, FAST);
      const before = { users: count("users"), audit: count("audit_log") };
      for (const password of ["abc", "aaaaaaaa", SECOND_EMAIL]) {
        const result = script.recoverOwner(db, { email: SECOND_EMAIL, password, apply: true, params: FAST });
        expect(result.applied, password).toBe(false);
        expect(result.plan.blockers.join(" ")).toMatch(/can't be used to create the account/);
        expect(result.plan.steps).toEqual([]);
      }
      expect({ users: count("users"), audit: count("audit_log") }).toEqual(before);
      expect(script.recoverOwner(db, { email: SECOND_EMAIL, password: "abcd", apply: false, params: FAST }).plan.blockers).toEqual([]); // four characters are fine
    });

    it("there is nowhere to put the account (Default workspace missing or suspended)", async () => {
      await addressChangedInEnv();
      identity().setOrganizationStatus(LEGACY_ORG_ID, "suspended");
      const suspended = script.recoverOwner(db, { ...second, apply: true });
      expect(suspended.applied).toBe(false);
      expect(suspended.plan.blockers.join(" ")).toMatch(/Default workspace is suspended/);
      expect(user(SECOND_EMAIL)!.is_platform_admin).toBe(0);

      identity().setOrganizationStatus(LEGACY_ORG_ID, "active");
      const owners = db.prepare("SELECT user_id FROM memberships WHERE org_id = ?").all(LEGACY_ORG_ID);
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM memberships WHERE org_id = ?").run(LEGACY_ORG_ID);
      db.prepare("DELETE FROM organizations WHERE id = ?").run(LEGACY_ORG_ID);
      db.pragma("foreign_keys = ON");
      expect(owners.length).toBeGreaterThan(0);
      const missing = script.recoverOwner(db, { ...second, apply: true });
      expect(missing.applied).toBe(false);
      expect(missing.plan.blockers.join(" ")).toMatch(/Default workspace doesn't exist/);
    });

    it("is all or nothing: if the audit record can't be written, no account, membership or flag changes", async () => {
      await ensureBootstrap(db, FIRST, FAST);
      const before = { users: count("users"), memberships: count("memberships"), admins: count("users WHERE is_platform_admin = 1") };
      db.exec("ALTER TABLE audit_log RENAME TO audit_log_hidden");

      expect(() => script.recoverOwner(db, { ...second, apply: true })).toThrow();

      db.exec("ALTER TABLE audit_log_hidden RENAME TO audit_log");
      expect({ users: count("users"), memberships: count("memberships"), admins: count("users WHERE is_platform_admin = 1") }).toEqual(before);
      expect(user(SECOND_EMAIL)).toBeUndefined();
    });
  });

  describe("stays in step with the application", () => {
    it("hashes verify in the application and the application's hashes verify here (same scrypt format and cost)", async () => {
      expect(script.SCRYPT_PARAMS).toEqual(DEFAULT_SCRYPT_PARAMS);
      const mine = script.hashPassword("pässwörd ①", FAST);
      expect(mine.split("$")).toHaveLength(6);
      expect(await appVerifyPassword("pässwörd ①", mine)).toBe(true); // including the NFKC normalization both sides apply
      expect(await appVerifyPassword("pässwörd 1", mine)).toBe(true);
      expect(await appVerifyPassword("another", mine)).toBe(false);
      const theirs = await appHashPassword("pässwörd ①", FAST);
      expect(script.verifyPassword("pässwörd ①", theirs)).toBe(true);
      expect(script.verifyPassword("another", theirs)).toBe(false);
      expect(script.verifyPassword("x", "not a hash")).toBe(false);
      expect(script.verifyPassword("x", "scrypt$3$8$1$AAAA$AAAA")).toBe(false); // malformed parameters are refused, not computed
    });

    it("applies the same password rules as the application", () => {
      expect(script.PASSWORD_MIN_LENGTH).toBe(PASSWORD_MIN_LENGTH);
      expect(script.PASSWORD_MAX_LENGTH).toBe(PASSWORD_MAX_LENGTH);
      const email = "owner@demo.test";
      for (const password of ["", "a", "abc", "abcd", "aaaa", "x".repeat(200), "x".repeat(201), "Owner@Demo.test", " owner@demo.test "]) {
        expect(script.passwordProblem(password, email), JSON.stringify(password)).toBe(appPasswordProblem(password, email));
      }
    });

    it("normalizes and masks addresses like the application", () => {
      expect(script.normalizeEmail("  A.B@Example.ORG ")).toBe("a.b@example.org");
      expect(script.maskEmail("developer@example.org")).toBe("de***@example.org");
      expect(script.maskEmail("no-at-sign")).toBe("***");
    });

    it("the schema it writes to is the one the application has (the columns it uses exist)", () => {
      const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols("users")).toEqual(expect.arrayContaining(["id", "email", "password_hash", "display_name", "is_platform_admin", "must_change_password", "temp_password_expires_at", "password_changed_at", "status"]));
      expect(cols("memberships")).toEqual(expect.arrayContaining(["org_id", "user_id", "role"]));
      expect(cols("audit_log")).toEqual(expect.arrayContaining(["action", "target_user_id", "target_label", "outcome", "details"]));
      expect(script.DEFAULT_ORG_ID).toBe(LEGACY_ORG_ID);
      expect(script.MIN_SCHEMA_VERSION).toBe(13);
    });
  });
});

describe("the command line", () => {
  let dir: string;
  let lines: string[];
  const print = (line: string) => void lines.push(line);
  const env = (over: Record<string, string | undefined> = {}) => ({ DATA_DIR: dir, BOOTSTRAP_OWNER_EMAIL: SECOND_EMAIL, BOOTSTRAP_OWNER_PASSWORD: "second owner passphrase", BOOTSTRAP_OWNER_NAME: "Second", ...over });
  const text = () => lines.join("\n");

  beforeEach(async () => {
    lines = [];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-owner-recover-"));
    const file = openDatabase(path.join(dir, "kb.sqlite"));
    await ensureBootstrap(file, FIRST, FAST);
    file.close();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const open = () => openDatabase(path.join(dir, "kb.sqlite"));

  it("a dry run reports in plain words, masks addresses, prints no secret and writes nothing", async () => {
    const code = await script.main([], env(), print);

    expect(code).toBe(0);
    expect(text()).toContain("Owner account se***@demo.test: does NOT exist");
    expect(text()).toMatch(/Would change:[\s\S]*create the account[\s\S]*Default workspace[\s\S]*Super Admin/);
    expect(text()).toContain("Dry run only: nothing was changed");
    for (const secret of ["second owner passphrase", "first owner passphrase", "scrypt$", SECOND_EMAIL, "first.owner@jivan.test"]) expect(text()).not.toContain(secret);
    const check = open();
    expect(check.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    check.close();
    expect(fs.readdirSync(dir).filter((f) => f.includes("pre-owner-recover"))).toEqual([]); // no backup for a dry run
  });

  it("--apply backs the database up first, makes the changes, and says to sign in (no restart needed)", async () => {
    const code = await script.main(["--apply"], env(), print);

    expect(code).toBe(0);
    expect(text()).toMatch(/Backed up the database to kb\.sqlite\.pre-owner-recover-.*\.bak/);
    expect(text()).toContain("Done. Sign in with the email and password from .env");
    const backups = fs.readdirSync(dir).filter((f) => f.includes("pre-owner-recover"));
    expect(backups).toHaveLength(1);
    const backup = openDatabase(path.join(dir, backups[0]!));
    expect(backup.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(SECOND_EMAIL)).toEqual({ n: 0 }); // the copy is from before
    backup.close();
    const check = open();
    expect(check.prepare("SELECT is_platform_admin AS a FROM users WHERE email = ?").get(SECOND_EMAIL)).toEqual({ a: 1 });
    expect(check.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'platform.owner.recover'").get()).toEqual({ n: 1 });
    check.close();

    lines = [];
    expect(await script.main(["--apply"], env(), print)).toBe(0);
    expect(text()).toContain("Nothing to change");
    expect(fs.readdirSync(dir).filter((f) => f.includes("pre-owner-recover"))).toHaveLength(1); // nothing to do, no second backup
  });

  it("explains a stale password without changing it", async () => {
    await script.main(["--apply"], env(), print);
    lines = [];

    const code = await script.main(["--apply"], env({ BOOTSTRAP_OWNER_PASSWORD: "an edited passphrase" }), print);

    expect(code).toBe(0);
    expect(text()).toContain("password in .env matches the stored one: NO");
    expect(text()).toMatch(/--reset-password/);
    expect(text()).not.toContain("an edited passphrase");
    const check = open();
    const stored = (check.prepare("SELECT password_hash AS h FROM users WHERE email = ?").get(SECOND_EMAIL) as { h: string }).h;
    check.close();
    expect(script.verifyPassword("second owner passphrase", stored)).toBe(true); // unchanged
  });

  it("refuses clearly: incomplete .env, no database, an old schema, unknown options", async () => {
    expect(await script.main([], env({ BOOTSTRAP_OWNER_PASSWORD: undefined }), print)).toBe(1);
    expect(text()).toMatch(/must both be set in \.env/);

    lines = [];
    expect(await script.main([], env({ DATA_DIR: path.join(dir, "nowhere") }), print)).toBe(1);
    expect(text()).toMatch(/There is no database at/);

    lines = [];
    const old = openDatabase(path.join(dir, "kb.sqlite"));
    old.pragma("user_version = 12");
    old.close();
    expect(await script.main(["--apply"], env(), print)).toBe(1);
    expect(text()).toMatch(/schema v12.*needs v13/);

    lines = [];
    expect(await script.main(["--everything"], env(), print)).toBe(2);
    expect(text()).toMatch(/Usage:/);
  });
});

describe("the startup log tells you when .env and the account have drifted apart", () => {
  it("says nothing when the owner can sign in and the password matches", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    warn.mockClear();

    const summary = await ensureBootstrap(db, FIRST, FAST);

    expect(summary).toMatchObject({ owner: "existing", ownerAccess: "ok", ownerPasswordMatchesEnv: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("notices a .env password that is no longer the account's password, and never changes the account", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    const hash = user("first.owner@jivan.test")!.password_hash;
    warn.mockClear();

    const summary = await ensureBootstrap(db, { ...FIRST, BOOTSTRAP_OWNER_PASSWORD: "an edited passphrase" }, FAST);

    expect(summary).toMatchObject({ owner: "existing", ownerAccess: "ok", ownerPasswordMatchesEnv: false });
    expect(user("first.owner@jivan.test")!.password_hash).toBe(hash); // the environment never overwrites an existing password
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/no longer matches the password of the account fi\*\*\*@jivan\.test/);
    expect(logged).toContain("owner:recover");
    expect(logged).not.toMatch(/an edited passphrase|first owner passphrase|scrypt\$|first\.owner@/);
    expect((await login("first.owner@jivan.test", "an edited passphrase")).status).toBe(401); // that is the failure the person sees
    expect((await login("first.owner@jivan.test", "first owner passphrase")).status).toBe(200);
  });

  it("names the other reasons an owner can't sign in: disabled, or every workspace suspended", async () => {
    await ensureBootstrap(db, FIRST, FAST);
    const owner = user("first.owner@jivan.test")!;

    identity().setUserStatus(owner.id, "disabled");
    warn.mockClear();
    expect((await ensureBootstrap(db, FIRST, FAST)).ownerAccess).toBe("disabled");
    expect(String(warn.mock.calls[0]![0])).toMatch(/account is disabled/);

    identity().setUserStatus(owner.id, "active");
    identity().setOrganizationStatus(LEGACY_ORG_ID, "suspended");
    warn.mockClear();
    expect((await ensureBootstrap(db, FIRST, FAST)).ownerAccess).toBe("workspaces-suspended");
    expect(String(warn.mock.calls[0]![0])).toMatch(/every workspace it belongs to is suspended/);
  });

  it("is quiet and reports nothing when no owner is configured", async () => {
    const summary = await ensureBootstrap(db, { ...FIRST, BOOTSTRAP_OWNER_EMAIL: undefined, BOOTSTRAP_OWNER_PASSWORD: undefined }, FAST);
    expect(summary).toMatchObject({ owner: "not-configured", ownerAccess: null, ownerPasswordMatchesEnv: null });
  });
});

describe("the recovery command is part of the project", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it("is wired to npm, never imported by the application, and documented", () => {
    expect(JSON.parse(read("package.json")).scripts["owner:recover"]).toBe("node scripts/owner-recover.mjs");
    const walk = (dir: string): string[] => fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    expect(walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && /(from|import\()\s*["'][^"']*owner-recover/.test(read(f)))).toEqual([]);
    expect(read("README.md")).toContain("npm run owner:recover");
  });

  it("only ever touches the owner's own rows (static check of the SQL it can run)", () => {
    const source = read("scripts/owner-recover.mjs");
    const writes = [...source.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect([...new Set(writes)].sort()).toEqual(["DELETE FROM auth_sessions", "INSERT INTO audit_log", "INSERT INTO memberships", "INSERT INTO users", "UPDATE users"]);
    for (const [, table] of source.matchAll(/(?:DELETE FROM|UPDATE)\s+(users|auth_sessions)\b[^"`]*/g)) expect(["users", "auth_sessions"]).toContain(table);
    expect(source).not.toMatch(/DELETE FROM (users|organizations|documents|chunks|conversations)/);
    expect(source).not.toMatch(/\bDROP\b|\bTRUNCATE\b/i);
  });
});
