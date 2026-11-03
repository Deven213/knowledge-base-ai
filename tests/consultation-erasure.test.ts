import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_VERSION } from "@/lib/consultation-consent";
import { LocalAudioStore } from "@/server/consultations/audio-store";
import { RecordingService } from "@/server/consultations/recording";
import { ConsultationRepository } from "@/server/consultations/repository";
import { ConsultationWorker, type WorkerDeps } from "@/server/consultations/worker";
import { processingGate } from "@/server/consultations/gate";
import { Vault } from "@/server/security/vault";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { audioBytes, CONSULT_KEY, consultationEnv, MIXED_TRANSCRIPT, sha256 } from "./consultation-helpers";
import { memoryDb, testConfig } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return { getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })), isFeatureEnabled: () => true, getFeatureAvailability: () => ({}), getFeatureFlagService: () => ({}), defaultFeatureFlags: () => [] };
});

import * as platformOrgRoute from "@/app/api/platform/organizations/[id]/route";

const vault = new Vault(CONSULT_KEY);
let env: ReturnType<typeof consultationEnv>;
let db: Database.Database;
let store: LocalAudioStore;
let superAdmin: Seeded;

beforeAll(() => {
  env = consultationEnv();
});
afterAll(() => env.restore());
beforeEach(() => {
  db = memoryDb();
  h.db = db;
  store = new LocalAudioStore(env.audioDir);
  const hq = seedOrganization(db, "HQ");
  superAdmin = seedMember(db, hq, "super@hq.test", "owner", { platformAdmin: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(env.audioDir, { recursive: true, force: true });
});

/** A clinic with doctors, each with a recorded (and optionally processed) consultation. */
async function clinic(name: string, doctors: string[]) {
  const org = seedOrganization(db, name);
  const out: { doctor: Seeded; repo: ConsultationRepository; id: string; key: string }[] = [];
  for (const email of doctors) {
    const doctor = seedMember(db, org, email, "doctor");
    const repo = new ConsultationRepository(db, org, doctor.userId, () => vault);
    const recordings = new RecordingService(repo, store, () => vault, org, { maxBytes: 50e6, maxMinutes: 60 });
    const id = repo.create({ patientLabel: "Patient", languageHint: "mixed", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "gu", givenBy: "patient", method: "verbal" } });
    const bytes = audioBytes(4000, out.length + 1);
    recordings.start(id, "audio/webm");
    await recordings.putPart(id, 1, bytes);
    await recordings.complete(id, { totalBytes: bytes.length, partCount: 1, durationMs: 60_000, sha256: sha256(bytes) });
    const transcriptId = repo.addTranscript(id, 1, "gemini", "m", MIXED_TRANSCRIPT);
    repo.addAiDraft(id, transcriptId, { sections: [], flags: [] }, "gemini", "m");
    out.push({ doctor, repo, id, key: repo.recordingOf(id)!.storage_key });
  }
  return { org, name, doctors: out };
}

const folders = () => (fs.existsSync(env.audioDir) ? fs.readdirSync(env.audioDir).sort() : []);
const count = (table: string, where = "1=1") => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const deleteOrg = (id: string, name: string) => call(platformOrgRoute.DELETE, `/api/platform/organizations/${id}`, { method: "DELETE", cookie: superAdmin.cookie, json: { confirmName: name }, params: { id } });

describe("deleting a customer workspace also deletes their recordings", () => {
  it("removes the records AND the audio files, reports how many, and leaves another customer's recordings alone", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test", "a2@acme.test"]);
    const beta = await clinic("Beta Clinic", ["b1@beta.test"]);
    expect(folders()).toHaveLength(3);

    const res = await deleteOrg(acme.org, acme.name);
    expect(res.status).toBe(200);
    const { deleted } = await body<{ deleted: Record<string, unknown> }>(res);
    expect(deleted).toMatchObject({ name: "Acme Clinic", recordingsRemoved: 2, recordingsPending: 0, data: { consultations: 2 } });

    expect(folders()).toEqual([beta.doctors[0]!.key]); // only Beta's folder is left
    expect(count("consultations", `org_id = '${acme.org}'`)).toBe(0);
    expect(count("consultation_transcripts", `org_id = '${acme.org}'`)).toBe(0);
    expect(count("consultation_notes", `org_id = '${acme.org}'`)).toBe(0);
    expect(count("consultation_recordings", `org_id = '${acme.org}'`)).toBe(0);
    // Beta is exactly as it was, and still readable.
    expect(beta.doctors[0]!.repo.latestTranscript(beta.doctors[0]!.id)!.content).toEqual(MIXED_TRANSCRIPT);
    expect(count("consultations", `org_id = '${beta.org}'`)).toBe(1);
  });

  it("never reveals where the files were: no storage names in the reply or in the audit record", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    const key = acme.doctors[0]!.key;
    const res = await deleteOrg(acme.org, acme.name);
    expect(await res.clone().text()).not.toContain(key);
    expect(await res.clone().text()).not.toMatch(/storedObjects|storage/i);
    const record = db.prepare("SELECT details FROM audit_log WHERE action = 'platform.organization.delete'").get() as { details: string };
    expect(record.details).not.toContain(key);
    expect(JSON.parse(record.details)).toMatchObject({ consultations: 1 });
  });

  it("the doctor accounts that existed only for the workspace go with it, and an account that also belongs to another workspace is kept", async () => {
    const acme = await clinic("Acme Clinic", ["only-acme@acme.test", "both@acme.test"]);
    const bothUser = acme.doctors[1]!.doctor;
    const beta = await clinic("Beta Clinic", []);
    seedMember(db, beta.org, bothUser.email, "doctor"); // the same person also works at Beta
    const res = await deleteOrg(acme.org, acme.name);
    expect(res.status).toBe(200);
    expect(count("users", `email = 'only-acme@acme.test'`)).toBe(0);
    expect(count("users", `email = 'both@acme.test'`)).toBe(1);
    expect(count("memberships", `user_id = '${bothUser.userId}'`)).toBe(1); // only Beta now
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("a doctor who was removed from one workspace, but is still named in its health records, doesn't block deleting another workspace (and is kept, not deleted)", async () => {
    const a = await clinic("Clinic A", ["roamer@both.test"]);
    const b = await clinic("Clinic B", []);
    const roamer = a.doctors[0]!.doctor;
    seedMember(db, b.org, roamer.email, "doctor"); // works at both
    db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(a.org, roamer.userId); // an administrator removes them from A: their consultations stay in A
    expect(count("memberships", `user_id = '${roamer.userId}'`)).toBe(1);

    const res = await deleteOrg(b.org, b.name);
    expect(res.status).toBe(200); // used to fail with a database error and roll back
    expect(count("users", `id = '${roamer.userId}'`)).toBe(1); // still there, because A's records name them
    expect(count("consultations", `org_id = '${a.org}'`)).toBe(1); // and A's consultation is untouched
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect((await body<{ deleted: Record<string, number> }>(res)).deleted).toMatchObject({ accountsKept: 1, accountsDeleted: 0 });
  });

  it("the same holds for someone named only as the author or approver of a note, or as the person who recorded consent", async () => {
    const a = await clinic("Clinic A", ["author@both.test"]);
    const b = await clinic("Clinic B", []);
    const author = a.doctors[0]!.doctor;
    seedMember(db, b.org, author.email, "doctor");
    db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(a.org, author.userId);
    // The doctor stays named as the one who recorded consent and who authored version 1 of the note.
    expect(count("consultation_consents", `recorded_by_user_id = '${author.userId}'`)).toBe(1);
    expect((await deleteOrg(b.org, b.name)).status).toBe(200);
    expect(count("users", `id = '${author.userId}'`)).toBe(1);
  });

  it("each kind of record that names a person protects them on its own: as the doctor, as who recorded consent, as who wrote or approved a note", async () => {
    const a = await clinic("Clinic A", ["main@a.test"]);
    const b = await clinic("Clinic B", []);
    const main = a.doctors[0]!;
    const newUser = (email: string) => {
      const user = seedMember(db, b.org, email, "doctor"); // members of Clinic B only: B's deletion would normally remove them
      return user.userId;
    };
    const onlyDoctor = newUser("only-doctor@b.test");
    const onlyConsent = newUser("only-consent@b.test");
    const onlyNote = newUser("only-note@b.test");
    // Records in Clinic A that each name exactly ONE of them, in exactly one way (the other columns name the main doctor).
    db.prepare("INSERT INTO consultations (id, org_id, doctor_user_id, patient_label) VALUES ('c-by-doctor', ?, ?, x'01')").run(a.org, onlyDoctor);
    db.prepare("INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('k1', ?, 'c-by-doctor', 'v', 'h', 'en', 'patient', 'verbal', ?)").run(a.org, main.doctor.userId);
    db.prepare("INSERT INTO consultations (id, org_id, doctor_user_id, patient_label) VALUES ('c-by-consent', ?, ?, x'01')").run(a.org, main.doctor.userId);
    db.prepare("INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id) VALUES ('k2', ?, 'c-by-consent', 'v', 'h', 'en', 'patient', 'verbal', ?)").run(a.org, onlyConsent);
    const transcriptId = (db.prepare("SELECT id FROM consultation_transcripts WHERE consultation_id = ?").get(main.id) as { id: string }).id;
    db.prepare("INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, created_by_user_id, approved_by_user_id, approved_at) VALUES ('n-by-note', ?, ?, 9, ?, 'doctor', x'03', ?, ?, '2026-01-01T00:00:00.000Z')").run(a.org, main.id, transcriptId, onlyNote, onlyNote);

    const res = await deleteOrg(b.org, b.name);
    expect(res.status).toBe(200);
    for (const [name, id] of [["doctor", onlyDoctor], ["consent recorder", onlyConsent], ["note author", onlyNote]] as const) {
      expect(count("users", `id = '${id}'`), name).toBe(1);
    }
    expect((await body<{ deleted: Record<string, number> }>(res)).deleted).toMatchObject({ accountsKept: 3, accountsDeleted: 0 });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("nothing is touched when the deletion is refused: a wrong name leaves the recordings where they were", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    const before = folders();
    const res = await deleteOrg(acme.org, "Not the name");
    expect(res.status).toBe(400);
    expect(folders()).toEqual(before);
    expect(count("consultations")).toBe(1);
    expect(acme.doctors[0]!.repo.latestTranscript(acme.doctors[0]!.id)).toBeDefined();
  });

  it("is refused while a recording of the workspace is being processed right now, and nothing is deleted", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    db.prepare("INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, status) VALUES ('busy', ?, ?, 'draft_note', 'running')").run(acme.org, acme.doctors[0]!.id);
    const res = await deleteOrg(acme.org, acme.name);
    expect(res.status).toBe(409);
    expect((await body<{ error: string }>(res)).error).toMatch(/being processed/);
    expect(folders()).toHaveLength(1);
    expect(count("consultations")).toBe(1);
  });

  it("a workspace whose jobs are merely waiting (nothing running) can be deleted, and the waiting work disappears with it", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    db.prepare("INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, status) VALUES ('waiting', ?, ?, 'draft_note', 'queued')").run(acme.org, acme.doctors[0]!.id);
    expect((await deleteOrg(acme.org, acme.name)).status).toBe(200);
    expect(count("consultation_jobs")).toBe(0);
  });

  it("if a file can't be removed the workspace is still deleted, the reply says one is pending, and the worker's sweep removes it later", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    const key = acme.doctors[0]!.key;
    const spy = vi.spyOn(LocalAudioStore.prototype, "deletePrefix").mockRejectedValue(new Error("disk is busy"));
    const res = await deleteOrg(acme.org, acme.name);
    expect(res.status).toBe(200);
    expect((await body<{ deleted: Record<string, number> }>(res)).deleted).toMatchObject({ recordingsRemoved: 0, recordingsPending: 1 });
    expect(count("consultations")).toBe(0);
    expect(folders()).toEqual([key]); // the audio is still on disk, and nothing in the database refers to it

    spy.mockRestore();
    let offset = 0;
    const clock = () => new Date(Date.now() + offset);
    const config = testConfig({ CONSULTATIONS_ENCRYPTION_KEY: CONSULT_KEY });
    const deps: WorkerDeps = { db, config, transcriber: { id: "gemini", transcribe: vi.fn() }, noteProvider: { id: "gemini", generate: vi.fn() }, store, vault: () => vault, gemini: () => ({ apiKey: "k", model: "m" }), gateOpen: () => processingGate(config, "k"), featureEnabled: () => true };
    const worker = new ConsultationWorker(deps, clock);
    await worker.tick();
    expect(folders()).toEqual([key]); // too new: it could belong to an upload that is only just starting
    fs.utimesSync(path.join(env.audioDir, key), new Date(Date.now() - 30 * 3600_000), new Date(Date.now() - 30 * 3600_000));
    offset += 20 * 60_000;
    await worker.tick();
    expect(folders()).toEqual([]);
  });
});

describe("the sweep for audio nothing refers to", () => {
  const worker = (clockOffset = { value: 0 }) => {
    const config = testConfig({ CONSULTATIONS_ENCRYPTION_KEY: CONSULT_KEY });
    const deps: WorkerDeps = { db, config, transcriber: { id: "gemini", transcribe: vi.fn() }, noteProvider: { id: "gemini", generate: vi.fn() }, store, vault: () => vault, gemini: () => ({ apiKey: "k", model: "m" }), gateOpen: () => ({ open: false, reason: "paused" }), featureEnabled: () => true };
    return new ConsultationWorker(deps, () => new Date(Date.now() + clockOffset.value));
  };
  const backdate = (name: string, hours: number) => fs.utimesSync(path.join(env.audioDir, name), new Date(Date.now() - hours * 3600_000), new Date(Date.now() - hours * 3600_000));

  it("removes old stored audio no recording refers to, keeps every recording the database knows, and keeps anything recent", async () => {
    const acme = await clinic("Acme Clinic", ["a1@acme.test"]);
    const known = acme.doctors[0]!.key;
    const orphanOld = "a".repeat(32);
    const orphanNew = "b".repeat(32);
    for (const name of [orphanOld, orphanNew]) {
      fs.mkdirSync(path.join(env.audioDir, name), { recursive: true });
      fs.writeFileSync(path.join(env.audioDir, name, "part-000001"), "x");
    }
    backdate(orphanOld, 30);
    backdate(orphanNew, 20); // under a day old: kept
    backdate(known, 100); // very old, but a recording refers to it: must stay
    await worker().tick();
    expect(folders()).toEqual([known, orphanNew].sort());
  });

  it("ignores anything in the folder that isn't a recording folder, and carries on to clean up the real orphans after it", async () => {
    fs.mkdirSync(env.audioDir, { recursive: true });
    fs.writeFileSync(path.join(env.audioDir, "notes.txt"), "keep me");
    fs.mkdirSync(path.join(env.audioDir, "0-not-a-recording-folder")); // sorts before the orphan below
    backdate("0-not-a-recording-folder", 100);
    const orphan = "a".repeat(32);
    fs.mkdirSync(path.join(env.audioDir, orphan));
    fs.writeFileSync(path.join(env.audioDir, orphan, "part-000001"), "x");
    backdate(orphan, 30);
    await worker().tick();
    expect(fs.readdirSync(env.audioDir).sort()).toEqual(["0-not-a-recording-folder", "notes.txt"]);
  });

  it("is a no-op when nothing has ever been recorded", async () => {
    fs.rmSync(env.audioDir, { recursive: true, force: true });
    await expect(worker().tick()).resolves.toBe(0);
    expect(os.platform()).toBeTruthy();
  });
});
