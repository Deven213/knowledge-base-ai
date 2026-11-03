import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { memoryDb } from "./helpers";

// Deleting a customer is ONE statement (DELETE FROM organizations) and the database removes everything the workspace
// owns. That is only safe if no customer table is missing from the chain, now or when a table is added later. These
// tests read the real schema, so a new table that holds customer data without cascading from the workspace fails here.

interface ForeignKey {
  table: string;
  from: string;
  to: string;
  on_delete: string;
}

const db: Database.Database = memoryDb();
const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const foreignKeys = (table: string) => db.prepare(`PRAGMA foreign_key_list(${table})`).all() as ForeignKey[];

/** Tables that are the platform's own (not owned by one customer) and so are deliberately not removed with a workspace. */
const PLATFORM_TABLES = ["app_settings", "audit_log", "feature_flags", "organizations", "provider_settings", "users"];

/** True when deleting the organization row deletes this table's rows: a cascading foreign key to it, directly or through a parent. */
function cascadesFromOrganization(table: string, seen = new Set<string>()): boolean {
  if (seen.has(table)) return false;
  seen.add(table);
  return foreignKeys(table).some((fk) => fk.on_delete === "CASCADE" && (fk.table === "organizations" || (fk.table !== "users" && cascadesFromOrganization(fk.table, seen))));
}

describe("the schema removes a customer's data with the customer", () => {
  it("has the tables this test knows about (a new table has to be classified here on purpose)", () => {
    const customerTables = tables.filter((t) => !PLATFORM_TABLES.includes(t));
    expect(customerTables).toEqual([
      "activation_codes",
      "auth_sessions",
      "chunks",
      "consultation_consents",
      "consultation_jobs",
      "consultation_notes",
      "consultation_recordings",
      "consultation_transcripts",
      "consultation_upload_parts",
      "consultations",
      "conversations",
      "documents",
      "integration_connections",
      "integration_credentials",
      "integration_sync_runs",
      "invitations",
      "memberships",
      "messages",
      "oauth_states",
      "org_settings",
    ]);
    expect(PLATFORM_TABLES.filter((t) => !tables.includes(t))).toEqual([]);
  });

  it("every customer table cascades from the organization, directly or through its parent row", () => {
    const orphaned = tables.filter((t) => !PLATFORM_TABLES.includes(t) && !cascadesFromOrganization(t));
    expect(orphaned, `these tables would survive the deletion of their workspace: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("every table with an org_id column, anywhere, cascades from the organization it names", () => {
    const withOrgId = tables.filter((t) => columns(t).includes("org_id"));
    expect(withOrgId.length).toBeGreaterThan(5);
    for (const table of withOrgId) {
      const fk = foreignKeys(table).find((f) => f.from === "org_id");
      expect(fk, `${table}.org_id`).toMatchObject({ table: "organizations", to: "id", on_delete: "CASCADE" });
    }
  });

  it("the platform's own tables hold nothing that cascades from a customer, so a deletion can never reach them", () => {
    // users, settings and feature flags are not owned by a workspace; the audit log has no foreign keys at all (it outlives everything).
    for (const table of ["app_settings", "audit_log", "feature_flags", "provider_settings", "users", "organizations"]) {
      expect(foreignKeys(table), table).toEqual([]);
    }
    expect(columns("audit_log")).not.toContain("org_id"); // it names organizations only as plain text (target_org_id), never as a foreign key
  });

  it("the only places where deleting an ACCOUNT deletes other rows are the ones the deletion guards against", () => {
    const cascadingFromUsers = tables
      .flatMap((t) => foreignKeys(t).filter((fk) => fk.table === "users" && fk.on_delete === "CASCADE").map((fk) => `${t}.${fk.from}`))
      .sort();
    // memberships and sessions belong to the account itself. conversations.user_id and invitations.invited_by can sit in ANOTHER
    // customer's workspace, so an account that has either outside the deleted workspace is kept (splitAccounts in
    // src/server/db/tenant-erasure.ts). A new cascading key to users must be handled there before this list is changed.
    expect(cascadingFromUsers).toEqual(["auth_sessions.user_id", "conversations.user_id", "invitations.invited_by", "memberships.user_id"]);
  });

  it("no health-record table cascades from an account: the doctor, the consent recorder and a note's author or approver are plain keys", () => {
    for (const table of tables.filter((t) => t.startsWith("consultation"))) {
      for (const fk of foreignKeys(table).filter((f) => f.table === "users")) {
        expect(fk.on_delete, `${table}.${fk.from}`).toBe("NO ACTION");
      }
    }
    expect(foreignKeys("consultations").some((f) => f.table === "users" && f.from === "doctor_user_id")).toBe(true);
  });

  it("foreign keys are enforced, and deleting an organization with data under it removes every row it owns", () => {
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const org = "org-under-test";
    const owner = "user-under-test";
    db.prepare("INSERT INTO organizations (id, name, slug) VALUES (?, 'Under Test', 'under-test')").run(org);
    db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, 'under@test.test', 'x')").run(owner);
    db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").run(org, owner);
    db.prepare("INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, status) VALUES ('d', ?, 'f', 'text/plain', 1, 'ready')").run(org);
    db.prepare("INSERT INTO chunks (id, document_id, chunk_index, content, embedding, embedding_model, org_id) VALUES ('c', 'd', 0, 't', x'00', 'm', ?)").run(org);
    db.prepare("INSERT INTO conversations (id, org_id, user_id, title) VALUES ('v', ?, ?, 't')").run(org, owner);
    db.prepare("INSERT INTO messages (id, conversation_id, role, content) VALUES ('m', 'v', 'user', 't')").run();
    db.prepare("INSERT INTO integration_connections (id, org_id, type, name, status) VALUES ('i', ?, 'website', 'W', 'connected')").run(org);
    db.prepare("INSERT INTO integration_credentials (integration_id, ciphertext, iv, auth_tag) VALUES ('i', x'01', x'02', x'03')").run();
    db.prepare("INSERT INTO integration_sync_runs (id, integration_id, status) VALUES ('r', 'i', 'success')").run();
    db.prepare("INSERT INTO oauth_states (state, integration_id, code_verifier) VALUES ('s', 'i', 'v')").run();
    db.prepare("INSERT INTO org_settings (org_id, key, value) VALUES (?, 'k', 'v')").run(org);
    db.prepare("INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES ('n', ?, 'x@y.test', 'member', 'h', ?, '2099-01-01')").run(org, owner);
    // Health information: a consultation with everything that hangs off it.
    db.prepare("INSERT INTO consultations (id, org_id, doctor_user_id, patient_label) VALUES ('k', ?, ?, x'01')").run(org, owner);
    db.prepare("INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('kc', ?, 'k', 'v', 'h', 'en', 'patient', 'verbal', ?)").run(org, owner);
    db.prepare("INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('kr', ?, 'k', 'stored', 'audio/webm', 'key', 1024)").run(org);
    db.prepare("INSERT INTO consultation_upload_parts (recording_id, org_id, part_number, size_bytes, sha256) VALUES ('kr', ?, 1, 10, 'h')").run(org);
    db.prepare("INSERT INTO consultation_jobs (id, org_id, consultation_id, kind) VALUES ('kj', ?, 'k', 'transcribe')").run(org);
    db.prepare("INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES ('kt', ?, 'k', 1, 'p', 'm', x'02')").run(org);
    db.prepare("INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content) VALUES ('kn', ?, 'k', 1, 'kt', 'ai', x'03')").run(org);

    // An account that is the doctor of a consultation can't be deleted underneath it: health records are never deleted as a side effect.
    expect(() => db.prepare("DELETE FROM users WHERE id = ?").run(owner)).toThrow(/FOREIGN KEY constraint failed/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM consultations").get() as { n: number }).n).toBe(1);

    db.prepare("DELETE FROM organizations WHERE id = ?").run(org);

    for (const table of ["memberships", "documents", "chunks", "conversations", "messages", "integration_connections", "integration_credentials", "integration_sync_runs", "oauth_states", "org_settings", "invitations", "consultations", "consultation_consents", "consultation_recordings", "consultation_upload_parts", "consultation_jobs", "consultation_transcripts", "consultation_notes"]) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
    expect((db.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(owner) as { n: number }).n).toBe(1); // the account is the platform's: removing it is a separate, guarded step
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
