import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "@/server/db/client";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import { MIGRATION_COUNT, migrate, schemaVersion } from "@/server/db/migrate";

// Migration 14 adds the Doctor role by rebuilding the two tables that list the roles (memberships, invitations). It is the
// only consultation migration that is not purely additive, so this file checks it hard: every row, index and trigger must
// come through, the cascades must still work, and the constraints must still refuse what they refused before.

/** A database as the app left it after migration 13, with people in every role, invitations (one a Customer Admin one) and an activation code. */
function v13Db(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db, 13);
  db.exec(`
    INSERT INTO users (id, email, password_hash, is_platform_admin) VALUES
      ('u-super', 'super@example.test', 'x', 1), ('u-owner', 'owner@example.test', 'x', 0),
      ('u-admin', 'admin@example.test', 'x', 0), ('u-member', 'member@example.test', 'x', 0), ('u-viewer', 'viewer@example.test', 'x', 0);
    INSERT INTO organizations (id, name, slug) VALUES ('o-acme', 'Acme', 'acme'), ('o-beta', 'Beta', 'beta');
    INSERT INTO memberships (org_id, user_id, role, created_at) VALUES
      ('o-acme', 'u-owner', 'owner', '2026-01-01T00:00:00.000Z'), ('o-acme', 'u-admin', 'admin', '2026-01-02T00:00:00.000Z'),
      ('o-acme', 'u-member', 'member', '2026-01-03T00:00:00.000Z'), ('o-acme', 'u-viewer', 'viewer', '2026-01-04T00:00:00.000Z'),
      ('o-beta', 'u-owner', 'admin', '2026-01-05T00:00:00.000Z'), ('${LEGACY_ORG_ID}', 'u-super', 'owner', '2026-01-06T00:00:00.000Z');
    INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at) VALUES
      ('i-1', 'o-acme', 'a@example.test', 'member', 'h1', 'u-owner', '2999-01-01T00:00:00.000Z', NULL, NULL, '2026-02-01T00:00:00.000Z'),
      ('i-2', 'o-acme', 'b@example.test', 'viewer', 'h2', 'u-owner', '2999-01-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', NULL, '2026-02-02T00:00:00.000Z'),
      ('i-3', 'o-beta', 'c@example.test', 'admin', 'h3', 'u-owner', '2999-01-01T00:00:00.000Z', NULL, '2026-02-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z');
    INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at, grants_owner)
      VALUES ('i-owner', 'o-beta', 'first-admin@example.test', 'member', 'h-owner', 'u-super', '2999-01-01T00:00:00.000Z', 1);
    INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at) VALUES ('ac-1', 'i-owner', 'first-admin@example.test', 'code-hash', '2999-01-01T00:00:00.000Z');
  `);
  return db;
}

const rows = (db: Database.Database, sql: string) => db.prepare(sql).all();
const count = (db: Database.Database, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const fails = (db: Database.Database, sql: string) => {
  try {
    db.exec(sql);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};
const schemaObjects = (db: Database.Database) =>
  (db.prepare(`SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all() as { type: string; name: string; tbl_name: string }[])
    .filter((o) => !/^(memberships|invitations)_new$/.test(o.name))
    .map((o) => `${o.type}:${o.name}@${o.tbl_name}`);

describe("migration 14: the Doctor role", () => {
  it("is one step beyond migration 13", () => {
    expect(MIGRATION_COUNT).toBeGreaterThanOrEqual(14);
  });

  it("keeps every row of memberships, invitations and activation_codes exactly as it was", () => {
    const db = v13Db();
    const membershipsBefore = rows(db, "SELECT * FROM memberships ORDER BY org_id, user_id");
    const invitationsBefore = rows(db, "SELECT * FROM invitations ORDER BY id");
    const codesBefore = rows(db, "SELECT * FROM activation_codes ORDER BY id");
    expect(schemaVersion(db)).toBe(13);
    expect(codesBefore).toHaveLength(1);

    migrate(db, 14);

    expect(schemaVersion(db)).toBe(14);
    expect(rows(db, "SELECT * FROM memberships ORDER BY org_id, user_id")).toEqual(membershipsBefore);
    expect(rows(db, "SELECT * FROM invitations ORDER BY id")).toEqual(invitationsBefore);
    expect(rows(db, "SELECT * FROM activation_codes ORDER BY id")).toEqual(codesBefore); // the DROP must not have cascaded them away
    expect(count(db, "users")).toBe(5);
    expect(count(db, "organizations")).toBe(3);
  });

  it("leaves the schema with exactly the same tables, indexes and triggers (nothing dropped, nothing left over)", () => {
    const db = v13Db();
    const before = schemaObjects(db);
    migrate(db, 14);
    expect(schemaObjects(db)).toEqual(before);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("accepts the doctor role in memberships and invitations, and still refuses anything else", () => {
    const db = v13Db();
    expect(fails(db, `INSERT INTO memberships (org_id, user_id, role) VALUES ('o-beta', 'u-member', 'doctor')`)).toMatch(/CHECK constraint failed/); // before: refused
    migrate(db, 14);
    expect(fails(db, `INSERT INTO memberships (org_id, user_id, role) VALUES ('o-beta', 'u-member', 'doctor')`)).toBeNull();
    expect(fails(db, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('i-doc', 'o-acme', 'doc@example.test', 'doctor', 'h-doc', 'u-owner', '2999-01-01T00:00:00.000Z')`)).toBeNull();
    expect(fails(db, `INSERT INTO memberships (org_id, user_id, role) VALUES ('o-beta', 'u-viewer', 'superuser')`)).toMatch(/CHECK constraint failed/);
    expect(fails(db, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('i-bad', 'o-acme', 'x@example.test', 'superuser', 'h-bad', 'u-owner', '2999-01-01T00:00:00.000Z')`)).toMatch(/CHECK constraint failed/);
    // An ordinary invitation still can never grant 'owner' (the role column didn't gain it).
    expect(fails(db, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('i-own', 'o-acme', 'y@example.test', 'owner', 'h-own', 'u-owner', '2999-01-01T00:00:00.000Z')`)).toMatch(/CHECK constraint failed/);
  });

  it("keeps the triggers working: only a platform administrator can issue a Customer Admin invitation, and an activation code stays bound to its invitation", () => {
    const db = v13Db();
    migrate(db, 14);
    expect(fails(db, `INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at, grants_owner) VALUES ('i-x', 'o-acme', 'z@example.test', 'member', 'h-x', 'u-owner', '2999-01-01T00:00:00.000Z', 1)`)).toMatch(/only a platform administrator/);
    expect(fails(db, `UPDATE invitations SET grants_owner = 0 WHERE id = 'i-owner'`)).toMatch(/cannot be changed/);
    expect(fails(db, `INSERT INTO activation_codes (id, invitation_id, email, code_hash, expires_at) VALUES ('ac-2', 'i-owner', 'someone-else@example.test', 'c', '2999-01-01T00:00:00.000Z')`)).toMatch(/belongs to a Customer Admin invitation/);
    expect(fails(db, `UPDATE activation_codes SET email = 'other@example.test' WHERE id = 'ac-1'`)).toMatch(/cannot be re-targeted/);
  });

  it("keeps the foreign keys and cascades: deleting a workspace removes its memberships and invitations, deleting a person removes theirs", () => {
    const db = v13Db();
    migrate(db, 14);
    db.exec(`DELETE FROM organizations WHERE id = 'o-beta'`);
    expect(count(db, "memberships")).toBe(5); // o-beta's one membership is gone
    expect(rows(db, "SELECT id FROM invitations ORDER BY id")).toEqual([{ id: "i-1" }, { id: "i-2" }]);
    expect(count(db, "activation_codes")).toBe(0); // the code went with its invitation
    db.exec(`DELETE FROM users WHERE id = 'u-owner'`);
    expect(rows(db, "SELECT user_id FROM memberships WHERE org_id = 'o-acme' ORDER BY user_id")).toEqual([{ user_id: "u-admin" }, { user_id: "u-member" }, { user_id: "u-viewer" }]);
    expect(count(db, "invitations")).toBe(0); // invited_by cascades
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("can be re-run safely on an up-to-date database (nothing happens)", () => {
    const db = v13Db();
    migrate(db);
    const before = rows(db, "SELECT * FROM memberships ORDER BY org_id, user_id");
    migrate(db);
    expect(rows(db, "SELECT * FROM memberships ORDER BY org_id, user_id")).toEqual(before);
    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
  });

  describe("on a real file", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
    });

    it("writes a full backup first, so restoring that file is the rollback", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-doctor-"));
      dirs.push(dir);
      const file = path.join(dir, "kb.sqlite");
      v13Db(file).close();

      const db = openDatabase(file);
      expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
      const backups = fs.readdirSync(dir).filter((f) => f.includes(".pre-migration-v13-"));
      expect(backups).toHaveLength(1);
      db.close();

      const backup = new Database(path.join(dir, backups[0]!), { readonly: true });
      expect(schemaVersion(backup)).toBe(13); // exactly the database as it was
      expect(count(backup, "memberships")).toBe(6);
      expect(count(backup, "activation_codes")).toBe(1);
      backup.close();
    });
  });
});
