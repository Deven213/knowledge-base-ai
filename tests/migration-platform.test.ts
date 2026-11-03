import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "@/server/db/client";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import { MIGRATION_COUNT, migrate, schemaVersion } from "@/server/db/migrate";

/** A database as the app left it after multi-tenancy (schema version 10), with people, workspaces, an invitation and a session. */
function v10Db(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db, 10);
  db.exec(`
    INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES ('u-admin', 'super@example.test', 'x', 1), ('u-plain', 'plain@example.test', 'x', 0);
    INSERT INTO organizations (id, name, slug) VALUES ('o-acme', 'Acme', 'acme');
    INSERT INTO memberships (org_id, user_id, role) VALUES ('o-acme', 'u-plain', 'owner'), ('${LEGACY_ORG_ID}', 'u-admin', 'owner');
    INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at)
      VALUES ('i-old', 'o-acme', 'new@example.test', 'member', 'hash-old', 'u-plain', '2999-01-01T00:00:00.000Z');
    INSERT INTO auth_sessions (token_hash, email, user_id, org_id, expires_at) VALUES ('s1', 'plain@example.test', 'u-plain', 'o-acme', '2999-01-01T00:00:00.000Z');
    INSERT INTO documents (id, filename, mime_type, size_bytes, status, chunk_count, org_id) VALUES ('d1', 'Guide.pdf', 'application/pdf', 10, 'ready', 0, 'o-acme');
  `);
  return db;
}

const count = (db: Database.Database, table: string, where = "1=1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const fails = (db: Database.Database, sql: string) => {
  try {
    db.exec(sql);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

describe("migration 11: Super Admin customer management", () => {
  it("keeps every existing row, and every existing workspace stays active", () => {
    const db = v10Db();
    const before = Object.fromEntries(["users", "organizations", "memberships", "invitations", "auth_sessions", "documents"].map((t) => [t, count(db, t)]));
    expect(schemaVersion(db)).toBe(10);

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(11);
    for (const [table, n] of Object.entries(before)) expect(count(db, table), table).toBe(n); // nothing deleted, signed-in people stay signed in
    expect(db.prepare("SELECT slug, status FROM organizations ORDER BY slug").all()).toEqual([
      { slug: "acme", status: "active" },
      { slug: "default", status: "active" },
    ]);
    expect(db.prepare("SELECT role, grants_owner AS g FROM invitations").all()).toEqual([{ role: "member", g: 0 }]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("is idempotent", () => {
    const db = v10Db();
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    expect(count(db, "organizations")).toBe(2);
  });

  it("only accepts the two workspace statuses", () => {
    const db = v10Db();
    migrate(db);
    expect(fails(db, "UPDATE organizations SET status = 'deleted' WHERE id = 'o-acme'")).toMatch(/CHECK/);
    expect(fails(db, "UPDATE organizations SET status = 'suspended' WHERE id = 'o-acme'")).toBeNull();
  });

  it("lets only a platform administrator issue a Customer Admin (grants_owner) invitation, and it can never be flipped later", () => {
    const db = v10Db();
    migrate(db);
    const insert = (by: string, flag: number) =>
      `INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at)
       VALUES ('i-${by}-${flag}', 'o-acme', 'x@example.test', 'admin', ${flag}, 'h-${by}-${flag}', '${by}', '2999-01-01T00:00:00.000Z')`;

    expect(fails(db, insert("u-plain", 1))).toMatch(/only a platform administrator/);
    expect(fails(db, insert("u-admin", 1))).toBeNull();
    expect(fails(db, insert("u-plain", 0))).toBeNull(); // ordinary invitations are unaffected

    expect(fails(db, "UPDATE invitations SET grants_owner = 1 WHERE id = 'i-old'")).toMatch(/cannot be changed/);
    expect(fails(db, "UPDATE invitations SET grants_owner = 0 WHERE id = 'i-u-admin-1'")).toMatch(/cannot be changed/);
    // The role column still refuses 'owner': the flag is the only way to make an owner, and only through the trigger above.
    expect(fails(db, "INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('i-bad', 'o-acme', 'y@example.test', 'owner', 'h', 'u-admin', '2999-01-01T00:00:00.000Z')")).toMatch(/CHECK/);
  });

  it("creates an audit log that can only be added to", () => {
    const db = v10Db();
    migrate(db);
    db.prepare("INSERT INTO audit_log (actor_email, action, details) VALUES (?, ?, ?)").run("super@example.test", "platform.organization.create", "{}");
    const row = db.prepare("SELECT * FROM audit_log").get() as { id: number; at: string; outcome: string };
    expect(row.outcome).toBe("success");
    expect(row.at).toMatch(/^\d{4}-\d\d-\d\dT/);

    expect(fails(db, "UPDATE audit_log SET action = 'something.else'")).toMatch(/append-only/);
    expect(fails(db, "DELETE FROM audit_log")).toMatch(/append-only/);
    expect(fails(db, "INSERT INTO audit_log (action, outcome) VALUES ('x', 'maybe')")).toMatch(/CHECK/);
    expect(count(db, "audit_log")).toBe(1);
  });

  it("the audit log outlives the people and workspaces it describes", () => {
    const db = v10Db();
    migrate(db);
    db.prepare("INSERT INTO audit_log (actor_user_id, actor_email, target_org_id, action) VALUES ('u-plain', 'plain@example.test', 'o-acme', 'org.member.remove')").run();

    db.exec("DELETE FROM organizations WHERE id = 'o-acme'");
    db.exec("DELETE FROM users WHERE id = 'u-plain'");

    expect(count(db, "audit_log")).toBe(1);
  });

  describe("on a real file", () => {
    const dirs: string[] = [];
    afterEach(() => {
      vi.restoreAllMocks();
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it("writes a restorable v10 copy before migrating, and the copy still holds the data", () => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-m11-"));
      dirs.push(dir);
      const file = path.join(dir, "kb.sqlite");
      v10Db(file).close();

      const db = openDatabase(file);
      expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
      expect(count(db, "organizations")).toBe(2);
      db.close();

      const backups = fs.readdirSync(dir).filter((f) => f.includes(".pre-migration-v10-") && f.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const copy = new Database(path.join(dir, backups[0]!), { readonly: true });
      expect(schemaVersion(copy)).toBe(10);
      expect(count(copy, "documents")).toBe(1);
      expect(copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'audit_log'").get()).toBeUndefined();
      copy.close();
    });
  });
});

/** A database as the app left it after the Super Admin milestone (schema version 11): a pending Customer Admin, an activated one, a member invitation. */
function v11Db(): Database.Database {
  const db = v10Db();
  migrate(db, 11);
  db.exec(`
    INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at)
      VALUES ('i-admin', 'o-acme', 'boss@example.test', 'admin', 1, 'hash-admin', 'u-admin', '2999-01-01T00:00:00.000Z');
    INSERT INTO audit_log (actor_email, action) VALUES ('super@example.test', 'platform.organization.create');
  `);
  return db;
}

describe("migration 12: first-time activation by emailed code", () => {
  it("keeps every existing row (customers, people, invitations, sessions, documents, audit records)", () => {
    const db = v11Db();
    const tables = ["users", "organizations", "memberships", "invitations", "auth_sessions", "documents", "audit_log"];
    const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
    expect(schemaVersion(db)).toBe(11);

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(12);
    for (const [table, n] of Object.entries(before)) expect(count(db, table), table).toBe(n);
    expect(count(db, "activation_codes")).toBe(0);
    expect(db.prepare("SELECT id, grants_owner AS g FROM invitations ORDER BY id").all()).toEqual([
      { id: "i-admin", g: 1 },
      { id: "i-old", g: 0 },
    ]); // an invitation issued before the upgrade is untouched and still pending
    expect(db.prepare("SELECT slug, customer_reference AS ref FROM organizations ORDER BY slug").all()).toEqual([
      { slug: "acme", ref: null },
      { slug: "default", ref: null },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("is idempotent", () => {
    const db = v11Db();
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
  });

  it("ties every code to a Customer Admin invitation and to that invitation's own address", () => {
    const db = v11Db();
    migrate(db);
    const insert = (invitation: string, email: string) =>
      `INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at) VALUES ('c-${invitation}-${email}', '${invitation}', '${email}', 'hash', '2999-01-01T00:00:00.000Z')`;

    expect(fails(db, insert("i-old", "new@example.test"))).toMatch(/Customer Admin invitation/); // an ordinary member invitation
    expect(fails(db, insert("i-admin", "someone-else@example.test"))).toMatch(/its own email address/);
    expect(fails(db, insert("no-such-invitation", "boss@example.test"))).toMatch(/Customer Admin invitation/);
    expect(fails(db, insert("i-admin", "BOSS@example.test"))).toBeNull(); // addresses compare without regard to case
    expect(count(db, "activation_codes")).toBe(1);
  });

  it("won't re-target, re-key or extend a code, but lets its progress be recorded", () => {
    const db = v11Db();
    migrate(db);
    db.exec(`INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at) VALUES ('c1', 'i-admin', 'boss@example.test', 'hash', '2030-01-01T00:00:00.000Z')`);

    expect(fails(db, "UPDATE activation_codes SET invitation_id = 'i-old'")).toMatch(/re-targeted|extended/);
    expect(fails(db, "UPDATE activation_codes SET email = 'x@example.test'")).toMatch(/re-targeted/);
    expect(fails(db, "UPDATE activation_codes SET code_hash = 'other'")).toMatch(/re-targeted/);
    expect(fails(db, "UPDATE activation_codes SET expires_at = '2999-01-01T00:00:00.000Z'")).toMatch(/extended/);
    expect(fails(db, "UPDATE activation_codes SET attempts = 3, consumed_at = '2026-01-01T00:00:00.000Z', verified_at = '2026-01-01T00:00:00.000Z', ticket_hash = 't', ticket_expires_at = '2026-01-02T00:00:00.000Z'")).toBeNull();
    expect(db.prepare("SELECT attempts FROM activation_codes").get()).toEqual({ attempts: 3 });
  });

  it("removes a code with its invitation, and keeps ticket hashes unique", () => {
    const db = v11Db();
    migrate(db);
    db.exec(`INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at, ticket_hash) VALUES ('c1', 'i-admin', 'boss@example.test', 'h', '2999-01-01T00:00:00.000Z', 'same-ticket')`);
    expect(fails(db, `INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at, ticket_hash) VALUES ('c2', 'i-admin', 'boss@example.test', 'h', '2999-01-01T00:00:00.000Z', 'same-ticket')`)).toMatch(/UNIQUE/);
    db.exec("DELETE FROM invitations WHERE id = 'i-admin'");
    expect(count(db, "activation_codes")).toBe(0);
  });

  it("makes the optional customer reference unique without regard to case, and bounded", () => {
    const db = v11Db();
    migrate(db);
    expect(fails(db, "UPDATE organizations SET customer_reference = 'CUST-1' WHERE id = 'o-acme'")).toBeNull();
    expect(fails(db, `UPDATE organizations SET customer_reference = 'cust-1' WHERE id = '${LEGACY_ORG_ID}'`)).toMatch(/UNIQUE/);
    expect(fails(db, `UPDATE organizations SET customer_reference = '${"x".repeat(41)}' WHERE id = '${LEGACY_ORG_ID}'`)).toMatch(/CHECK/);
    expect(fails(db, `UPDATE organizations SET customer_reference = '' WHERE id = '${LEGACY_ORG_ID}'`)).toMatch(/CHECK/);
    expect(fails(db, `UPDATE organizations SET customer_reference = NULL WHERE id = 'o-acme'`)).toBeNull();
    expect(fails(db, `UPDATE organizations SET customer_reference = 'cust-1' WHERE id = '${LEGACY_ORG_ID}'`)).toBeNull(); // free again
  });
});

/** A database as the app left it after the activation-code milestone (schema version 12), with real customers in it. */
function v12Db(): Database.Database {
  const db = v10Db();
  migrate(db, 12);
  db.exec(`
    INSERT INTO invitations (id, org_id, email, role, grants_owner, token_hash, invited_by, expires_at)
      VALUES ('i-admin', 'o-acme', 'boss@example.test', 'admin', 1, 'hash-admin', 'u-admin', '2999-01-01T00:00:00.000Z');
    INSERT INTO audit_log (actor_email, action) VALUES ('super@example.test', 'platform.organization.create');
  `);
  return db;
}

describe("migration 13: temporary passwords", () => {
  it("keeps every existing row, and every existing account is on its own password", () => {
    const db = v12Db();
    const tables = ["users", "organizations", "memberships", "invitations", "auth_sessions", "documents", "audit_log", "activation_codes"];
    const before = Object.fromEntries(tables.map((t) => [t, count(db, t)]));
    expect(schemaVersion(db)).toBe(12);

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(13);
    for (const [table, n] of Object.entries(before)) expect(count(db, table), table).toBe(n); // nobody is signed out, nothing deleted
    expect(db.prepare("SELECT email, must_change_password AS m, temp_password_expires_at AS e, password_changed_at AS c FROM users ORDER BY email").all()).toEqual([
      { email: "plain@example.test", m: 0, e: null, c: null },
      { email: "super@example.test", m: 0, e: null, c: null },
    ]);
    expect(db.prepare("SELECT id, grants_owner AS g, accepted_at AS a FROM invitations ORDER BY id").all()).toEqual([
      { id: "i-admin", g: 1, a: null }, // an invitation link issued before the upgrade is untouched and still pending
      { id: "i-old", g: 0, a: null },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("is idempotent", () => {
    const db = v12Db();
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
  });

  it("only accepts the two flag values, and insists on an expiry for every temporary password", () => {
    const db = v12Db();
    migrate(db);
    expect(fails(db, "UPDATE users SET must_change_password = 2 WHERE id = 'u-plain'")).toMatch(/CHECK/);
    expect(fails(db, "UPDATE users SET must_change_password = 1 WHERE id = 'u-plain'")).toMatch(/needs an expiry/);
    expect(fails(db, "UPDATE users SET must_change_password = 1, temp_password_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = 'u-plain'")).toBeNull();
    expect(fails(db, "UPDATE users SET temp_password_expires_at = NULL WHERE id = 'u-plain'")).toMatch(/needs an expiry/);
    expect(fails(db, "INSERT INTO users (id, email, password_hash, must_change_password) VALUES ('u-new', 'new@example.test', 'h', 1)")).toMatch(/needs an expiry/);
    expect(fails(db, "INSERT INTO users (id, email, password_hash, must_change_password, temp_password_expires_at) VALUES ('u-new', 'new@example.test', 'h', 1, '2999-01-01T00:00:00.000Z')")).toBeNull();
    // Replacing the temporary password (flag off, expiry cleared) is of course allowed.
    expect(fails(db, "UPDATE users SET must_change_password = 0, temp_password_expires_at = NULL, password_changed_at = '2026-01-01T00:00:00.000Z' WHERE id = 'u-new'")).toBeNull();
  });

  it("makes a customer creation request id unique, and optional", () => {
    const db = v12Db();
    migrate(db);
    expect(fails(db, "UPDATE organizations SET creation_request_id = 'req-1' WHERE id = 'o-acme'")).toBeNull();
    expect(fails(db, `UPDATE organizations SET creation_request_id = 'req-1' WHERE id = '${LEGACY_ORG_ID}'`)).toMatch(/UNIQUE/);
    expect(fails(db, `UPDATE organizations SET creation_request_id = NULL WHERE id = '${LEGACY_ORG_ID}'`)).toBeNull(); // many customers have none
    expect(fails(db, "INSERT INTO organizations (id, name, slug) VALUES ('o-x', 'X', 'x'), ('o-y', 'Y', 'y')")).toBeNull();
  });

  it("writes a restorable v12 copy before migrating a real file", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-m13-"));
    try {
      const file = path.join(dir, "kb.sqlite");
      const seed = v10Db(file);
      migrate(seed, 12);
      seed.close();

      const db = openDatabase(file);
      expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
      db.close();

      const backups = fs.readdirSync(dir).filter((f) => f.includes(".pre-migration-v12-") && f.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const copy = new Database(path.join(dir, backups[0]!), { readonly: true });
      expect(schemaVersion(copy)).toBe(12);
      expect((copy.pragma("table_info(users)") as { name: string }[]).map((c) => c.name)).not.toContain("must_change_password");
      copy.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
