import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_ORG_ID } from "@/server/db/constants";
import { openDatabase } from "@/server/db/client";
import { MIGRATION_COUNT, migrate, schemaVersion } from "@/server/db/migrate";

/** A database exactly as the app left it at schema version 9 (before organizations existed), with data in every tenant table. */
function legacyDb(filename = ":memory:"): Database.Database {
  const db = new Database(filename);
  db.pragma("foreign_keys = ON");
  migrate(db, 9);
  const blob = Buffer.alloc(8);
  db.exec(`
    INSERT INTO documents (id, filename, mime_type, size_bytes, status, chunk_count) VALUES ('d1', 'Guide.pdf', 'application/pdf', 10, 'ready', 2);
    INSERT INTO documents (id, filename, mime_type, size_bytes, status, chunk_count, source_type, source_url, source_external_id, integration_id)
      VALUES ('d2', 'Page', 'text/plain', 5, 'ready', 1, 'website', 'https://example.com/a', 'https://example.com/a', 'int-web');
    INSERT INTO conversations (id, title) VALUES ('c1', 'First chat');
    INSERT INTO messages (id, conversation_id, role, content) VALUES ('m1', 'c1', 'user', 'hello'), ('m2', 'c1', 'assistant', 'hi');
    INSERT INTO integration_connections (id, type, name, status) VALUES ('int-web', 'website', 'Website Scraper', 'connected'), ('int-gd', 'google_drive', 'Google Drive', 'not_connected');
    INSERT INTO integration_sync_runs (id, integration_id, status) VALUES ('run1', 'int-web', 'success');
    INSERT INTO auth_sessions (token_hash, email, expires_at) VALUES ('h1', 'demo@example.com', '2999-01-01T00:00:00.000Z'), ('h2', 'demo@example.com', '2999-01-01T00:00:00.000Z');
    INSERT INTO app_settings (key, value) VALUES ('active_provider', 'gemini'), ('suggested_questions', '{"questions":["x"]}');
  `);
  const chunk = db.prepare("INSERT INTO chunks (id, document_id, chunk_index, content, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, 'm')");
  chunk.run("k1", "d1", 0, "one", blob);
  chunk.run("k2", "d1", 1, "two", blob);
  chunk.run("k3", "d2", 0, "three", blob);
  return db;
}

const count = (db: Database.Database, table: string, where = "1=1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

describe("migration 10: multi-tenancy", () => {
  it("adopts every existing row into the Default workspace without deleting anything", () => {
    const db = legacyDb();
    const before = Object.fromEntries(["documents", "chunks", "conversations", "messages", "integration_connections", "integration_sync_runs"].map((t) => [t, count(db, t)]));
    expect(schemaVersion(db)).toBe(9);

    migrate(db);

    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    for (const [table, n] of Object.entries(before)) expect(count(db, table), table).toBe(n);
    for (const table of ["documents", "chunks", "conversations", "integration_connections"]) {
      expect(count(db, table, `org_id = '${LEGACY_ORG_ID}'`), table).toBe(before[table]);
      expect(count(db, table, "org_id IS NULL"), `${table} without owner`).toBe(0);
    }
    expect(db.prepare("SELECT name, slug FROM organizations").all()).toEqual([{ name: "Default workspace", slug: "default" }]);
    expect(count(db, "conversations", "user_id IS NULL")).toBe(1); // assigned to the owner at startup, not here
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("removes old sessions and the shared suggestions cache, and keeps platform settings", () => {
    const db = legacyDb();
    migrate(db);
    expect(count(db, "auth_sessions")).toBe(0);
    expect(db.prepare("SELECT key FROM app_settings").all()).toEqual([{ key: "active_provider" }]);
  });

  it("is idempotent", () => {
    const db = legacyDb();
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    expect(count(db, "organizations")).toBe(1);
  });

  it("makes an unowned or mismatched row impossible to store (database-level guarantees)", () => {
    const db = legacyDb();
    migrate(db);
    db.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-b', 'B', 'b')").run();

    expect(() => db.prepare("INSERT INTO documents (id, filename, mime_type, size_bytes, status) VALUES ('x', 'x', 'x', 1, 'ready')").run()).toThrow(/org_id is required/);
    expect(() => db.prepare("INSERT INTO conversations (id, title) VALUES ('cx', 't')").run()).toThrow(/org_id is required/);
    expect(() => db.prepare("INSERT INTO integration_connections (id, type, name, status) VALUES ('ix', 'website', 'W', 'connected')").run()).toThrow(/org_id is required/);

    // A chunk must carry the organization of its document: org-b cannot attach a chunk to the Default workspace's document.
    const insertChunk = db.prepare("INSERT INTO chunks (id, document_id, chunk_index, content, embedding, embedding_model, org_id) VALUES (?, 'd1', 9, 'c', x'00', 'm', ?)");
    expect(() => insertChunk.run("bad", "org-b")).toThrow(/same organization as its document/);
    expect(() => db.prepare("INSERT INTO chunks (id, document_id, chunk_index, content, embedding, embedding_model) VALUES ('nobody', 'd1', 8, 'c', x'00', 'm')").run()).toThrow(/same organization/);
    insertChunk.run("good", LEGACY_ORG_ID);

    // Ownership never moves.
    expect(() => db.prepare("UPDATE documents SET org_id = 'org-b' WHERE id = 'd1'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE chunks SET org_id = 'org-b' WHERE id = 'k1'").run()).toThrow(/cannot move/);
    expect(() => db.prepare("UPDATE conversations SET org_id = 'org-b' WHERE id = 'c1'").run()).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE integration_connections SET org_id = 'org-b' WHERE id = 'int-gd'").run()).toThrow(/cannot be changed/);
  });

  it("allows the same page or file in two organizations but not twice in one", () => {
    const db = legacyDb();
    migrate(db);
    db.prepare("INSERT INTO organizations (id, name, slug) VALUES ('org-b', 'B', 'b')").run();
    const insert = db.prepare(
      "INSERT INTO documents (id, filename, mime_type, size_bytes, status, source_type, source_external_id, org_id) VALUES (?, 'P', 'text/plain', 1, 'ready', 'website', 'https://example.com/a', ?)",
    );
    insert.run("same-page-in-b", "org-b"); // d2 already has this page in the Default workspace
    expect(() => insert.run("dup-in-b", "org-b")).toThrow(/UNIQUE/);
  });

  it("limits each organization to one connection per integration type", () => {
    const db = legacyDb();
    migrate(db);
    expect(() => db.prepare("INSERT INTO integration_connections (id, type, name, status, org_id) VALUES ('dup', 'website', 'W', 'connected', ?)").run(LEGACY_ORG_ID)).toThrow(/UNIQUE/);
  });

  it("invitations can never grant ownership, and memberships need a valid role", () => {
    const db = legacyDb();
    migrate(db);
    db.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u1', 'a@x.test', 'h')").run();
    expect(() => db.prepare("INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('i', ?, 'b@x.test', 'owner', 't', 'u1', '2999-01-01')").run(LEGACY_ORG_ID)).toThrow(/CHECK/);
    expect(() => db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, 'u1', 'superuser')").run(LEGACY_ORG_ID)).toThrow(/CHECK/);
    db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, 'u1', 'owner')").run(LEGACY_ORG_ID);
    expect(() => db.prepare("INSERT INTO users (id, email, password_hash) VALUES ('u2', 'A@X.TEST', 'h')").run()).toThrow(/UNIQUE/); // emails are case-insensitive
  });
});

describe("backup before migrating", () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it("writes a restorable copy of an existing database before changing it", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-migrate-"));
    const file = path.join(dir, "kb.sqlite");
    legacyDb(file).close();

    const db = openDatabase(file); // migrates 9 → 10

    expect(schemaVersion(db)).toBe(MIGRATION_COUNT);
    const backups = fs.readdirSync(dir).filter((f) => f.startsWith("kb.sqlite.pre-migration-v9-") && f.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = new Database(path.join(dir, backups[0]!), { readonly: true });
    expect(schemaVersion(backup)).toBe(9); // exactly as it was
    expect(count(backup, "documents")).toBe(2);
    expect(count(backup, "chunks")).toBe(3);
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(count(db, "documents")).toBe(2);
    backup.close();
    db.close();
  });

  it("does not back up again when the database is already current, nor for a new one", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-migrate-"));
    const file = path.join(dir, "kb.sqlite");
    openDatabase(file).close(); // brand new
    openDatabase(file).close(); // already current
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".bak"))).toEqual([]);
  });
});
