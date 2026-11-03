import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { memoryDb } from "./helpers";

// The database itself refuses what the application must never do, so these guarantees hold even if application code is wrong:
// a row filed under another customer, a consent or transcript that changes, a note version that is edited, an approval that is undone.

let db: Database.Database;
const refusal = (sql: string, ...params: unknown[]): string | null => {
  try {
    db.prepare(sql).run(...params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};

beforeEach(() => {
  db = memoryDb();
  db.exec(`
    INSERT INTO organizations (id, name, slug) VALUES ('org-a', 'A', 'a'), ('org-b', 'B', 'b');
    INSERT INTO users (id, email, password_hash) VALUES ('doc-a', 'a@x.test', 'x'), ('doc-b', 'b@x.test', 'x');
    INSERT INTO consultations (id, org_id, doctor_user_id, patient_label) VALUES ('c-a', 'org-a', 'doc-a', x'01'), ('c-b', 'org-b', 'doc-b', x'02');
    INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES ('t-a', 'org-a', 'c-a', 1, 'p', 'm', x'03');
    INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content) VALUES ('n-a', 'org-a', 'c-a', 1, 't-a', 'ai', x'04');
  `);
});

describe("a child row belongs to its consultation's organization, whatever the application says", () => {
  it.each([
    ["consent", `INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('x', 'org-b', 'c-a', 'v', 'h', 'en', 'patient', 'verbal', 'doc-a')`],
    ["recording", `INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('x', 'org-b', 'c-a', 'uploading', 'audio/webm', 'k', 1)`],
    ["job", `INSERT INTO consultation_jobs (id, org_id, consultation_id, kind) VALUES ('x', 'org-b', 'c-a', 'transcribe')`],
    ["transcript", `INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES ('x', 'org-b', 'c-a', 2, 'p', 'm', x'00')`],
    ["note", `INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content) VALUES ('x', 'org-b', 'c-a', 2, 't-a', 'ai', x'00')`],
  ])("refuses a %s filed under another organization", (_name, sql) => {
    expect(refusal(sql)).toMatch(/same organization/);
  });

  it("refuses an upload part under another organization, and a note whose transcript belongs to a different consultation", () => {
    db.exec(`INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('r-a', 'org-a', 'c-a', 'uploading', 'audio/webm', 'ka', 1)`);
    expect(refusal(`INSERT INTO consultation_upload_parts (recording_id, org_id, part_number, size_bytes, sha256) VALUES ('r-a', 'org-b', 1, 1, 'h')`)).toMatch(/same organization/);
    db.exec(`INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES ('t-b', 'org-b', 'c-b', 1, 'p', 'm', x'00')`);
    expect(refusal(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content) VALUES ('x', 'org-a', 'c-a', 2, 't-b', 'ai', x'00')`)).toMatch(/same organization and consultation/);
  });

  it("accepts the same rows when the organization matches (the checks aren't simply refusing everything)", () => {
    expect(refusal(`INSERT INTO consultation_jobs (id, org_id, consultation_id, kind) VALUES ('ok', 'org-a', 'c-a', 'transcribe')`)).toBeNull();
    expect(refusal(`INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('ok', 'org-a', 'c-a', 'v', 'h', 'en', 'patient', 'verbal', 'doc-a')`)).toBeNull();
  });
});

describe("what can never be changed", () => {
  it("a consultation never moves to another organization or doctor", () => {
    expect(refusal(`UPDATE consultations SET org_id = 'org-b' WHERE id = 'c-a'`)).toMatch(/cannot be changed/);
    expect(refusal(`UPDATE consultations SET doctor_user_id = 'doc-b' WHERE id = 'c-a'`)).toMatch(/cannot change doctor/);
    expect(refusal(`UPDATE consultations SET status = 'processing' WHERE id = 'c-a'`)).toBeNull(); // ordinary changes are fine
  });

  it("a consent record is never changed, and there is only one per consultation", () => {
    db.exec(`INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('k1', 'org-a', 'c-a', 'v1', 'h', 'en', 'patient', 'verbal', 'doc-a')`);
    expect(refusal(`UPDATE consultation_consents SET text_version = 'v2' WHERE id = 'k1'`)).toMatch(/never changed/);
    expect(refusal(`UPDATE consultation_consents SET method = 'written' WHERE id = 'k1'`)).toMatch(/never changed/);
    expect(refusal(`INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('k2', 'org-a', 'c-a', 'v1', 'h', 'en', 'patient', 'verbal', 'doc-a')`)).toMatch(/UNIQUE/);
  });

  it("the original transcript is never edited", () => {
    expect(refusal(`UPDATE consultation_transcripts SET content = x'ff' WHERE id = 't-a'`)).toMatch(/never changed/);
    expect(refusal(`UPDATE consultation_transcripts SET version = 9 WHERE id = 't-a'`)).toMatch(/never changed/);
  });

  it("a note version is never edited, only superseded by a new version", () => {
    for (const column of ["content = x'ff'", "version = 5", "source = 'doctor'", "provider = 'tampered'", "created_at = '2000-01-01'", "transcript_id = 't-a'"]) {
      expect(refusal(`UPDATE consultation_notes SET ${column} WHERE id = 'n-a'`), column).toMatch(/never edited/);
    }
  });

  it("an approval can be given once and is then final", () => {
    expect(refusal(`UPDATE consultation_notes SET approved_by_user_id = 'doc-a', approved_at = '2026-01-01T00:00:00.000Z' WHERE id = 'n-a'`)).toBeNull();
    expect(refusal(`UPDATE consultation_notes SET approved_at = '2027-01-01T00:00:00.000Z' WHERE id = 'n-a'`)).toMatch(/final/);
    expect(refusal(`UPDATE consultation_notes SET approved_by_user_id = 'doc-b' WHERE id = 'n-a'`)).toMatch(/final/);
  });

  it("a note is approved by a person together with a time, never one without the other", () => {
    expect(refusal(`UPDATE consultation_notes SET approved_at = '2026-01-01T00:00:00.000Z' WHERE id = 'n-a'`)).toMatch(/CHECK constraint/);
    expect(refusal(`UPDATE consultation_notes SET approved_by_user_id = 'doc-a' WHERE id = 'n-a'`)).toMatch(/CHECK constraint/);
  });

  it("an AI draft has no human author and a doctor's version always has one", () => {
    expect(refusal(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, created_by_user_id) VALUES ('x', 'org-a', 'c-a', 2, 't-a', 'ai', x'00', 'doc-a')`)).toMatch(/CHECK constraint/);
    expect(refusal(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content) VALUES ('x', 'org-a', 'c-a', 2, 't-a', 'doctor', x'00')`)).toMatch(/CHECK constraint/);
    expect(refusal(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, created_by_user_id) VALUES ('ok', 'org-a', 'c-a', 2, 't-a', 'doctor', x'00', 'doc-a')`)).toBeNull();
  });

  it("a recording and a job can't be pointed at other data", () => {
    db.exec(`INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('r-a', 'org-a', 'c-a', 'uploading', 'audio/webm', 'ka', 1)`);
    expect(refusal(`UPDATE consultation_recordings SET storage_key = 'other' WHERE id = 'r-a'`)).toMatch(/cannot move/);
    expect(refusal(`UPDATE consultation_recordings SET consultation_id = 'c-b' WHERE id = 'r-a'`)).toMatch(/cannot move/);
    expect(refusal(`UPDATE consultation_recordings SET status = 'stored' WHERE id = 'r-a'`)).toBeNull();
    db.exec(`INSERT INTO consultation_jobs (id, org_id, consultation_id, kind) VALUES ('j-a', 'org-a', 'c-a', 'transcribe')`);
    expect(refusal(`UPDATE consultation_jobs SET consultation_id = 'c-b' WHERE id = 'j-a'`)).toMatch(/cannot be pointed/);
    expect(refusal(`UPDATE consultation_jobs SET kind = 'draft_note' WHERE id = 'j-a'`)).toMatch(/cannot be pointed/);
  });

  it("only one recording per consultation, and the same work can't be queued twice", () => {
    db.exec(`INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('r1', 'org-a', 'c-a', 'uploading', 'audio/webm', 'k1', 1)`);
    expect(refusal(`INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES ('r2', 'org-a', 'c-a', 'uploading', 'audio/webm', 'k2', 1)`)).toMatch(/UNIQUE/);
    db.exec(`INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, generation) VALUES ('j1', 'org-a', 'c-a', 'transcribe', 1)`);
    expect(refusal(`INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, generation) VALUES ('j2', 'org-a', 'c-a', 'transcribe', 1)`)).toMatch(/UNIQUE/);
    expect(refusal(`INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, generation) VALUES ('j3', 'org-a', 'c-a', 'transcribe', 2)`)).toBeNull(); // an explicit retry
  });
});

describe("deleting", () => {
  it("deleting a consultation removes everything under it and nothing of another customer's", () => {
    db.exec(`
      INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('k', 'org-a', 'c-a', 'v', 'h', 'en', 'patient', 'verbal', 'doc-a');
      INSERT INTO consultation_jobs (id, org_id, consultation_id, kind) VALUES ('j', 'org-a', 'c-a', 'transcribe');
      INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES ('t-b', 'org-b', 'c-b', 1, 'p', 'm', x'00');
    `);
    db.prepare(`DELETE FROM consultations WHERE id = 'c-a'`).run();
    for (const table of ["consultation_consents", "consultation_jobs", "consultation_transcripts", "consultation_notes"]) {
      const left = db.prepare(`SELECT org_id FROM ${table}`).all() as { org_id: string }[];
      expect(left.every((r) => r.org_id === "org-b"), table).toBe(true);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM consultations`).get()).toEqual({ n: 1 });
  });
});
