import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_VERSION } from "@/lib/consultation-consent";
import { UploadError, uploadRecording, type UploadApi } from "@/lib/consultation-upload";
import { emptyNote, UPLOAD_PART_BYTES, type NoteContent, type TranscriptContent } from "@/lib/consultations";
import type { Role } from "@/server/db/constants";
import { ConsultationRepository } from "@/server/consultations/repository";
import { consultationVault } from "@/server/consultations/vault";
import { getConfig } from "@/server/config";
import { resetDeniedThrottleForTests } from "@/server/consultations/api";
import { groundNote } from "@/server/consultations/note-ai";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { audioBytes, consultationEnv, goodDraft, MIXED_TRANSCRIPT, partsOf, sha256, validCreate } from "./consultation-helpers";
import { FakeEmbedder, memoryDb } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, embedder: undefined as unknown as FakeEmbedder, off: new Set<string>() }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/knowledge/embedder", () => ({ getEmbedder: () => h.embedder }));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  const flags = () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: !h.off.has(f.key) }));
  return { getFeatureFlags: flags, isFeatureEnabled: () => true, getFeatureAvailability: () => ({}), getFeatureFlagService: () => ({}), defaultFeatureFlags: () => [] };
});

import * as listRoute from "@/app/api/consultations/route";
import * as oneRoute from "@/app/api/consultations/[id]/route";
import * as recordingRoute from "@/app/api/consultations/[id]/recording/route";
import * as partRoute from "@/app/api/consultations/[id]/recording/parts/[n]/route";
import * as completeRoute from "@/app/api/consultations/[id]/recording/complete/route";
import * as audioRoute from "@/app/api/consultations/[id]/audio/route";
import * as transcriptRoute from "@/app/api/consultations/[id]/transcript/route";
import * as noteRoute from "@/app/api/consultations/[id]/note/route";
import * as approveRoute from "@/app/api/consultations/[id]/note/approve/route";
import * as reopenRoute from "@/app/api/consultations/[id]/note/reopen/route";
import * as retryRoute from "@/app/api/consultations/[id]/retry/route";

let env: ReturnType<typeof consultationEnv>;
let db: Database.Database;
let orgA: string;
let orgB: string;
let doctorA: Seeded;
let doctorA2: Seeded;
let doctorB: Seeded;
let byRole: Record<Role, Seeded>;

beforeAll(() => {
  env = consultationEnv();
});
afterAll(() => env.restore());
afterEach(() => fs.rmSync(env.audioDir, { recursive: true, force: true }));

beforeEach(() => {
  db = memoryDb();
  h.db = db;
  h.embedder = new FakeEmbedder(["x"]);
  h.off.clear();
  orgA = seedOrganization(db, "Acme Clinic");
  orgB = seedOrganization(db, "Beta Clinic");
  byRole = Object.fromEntries((["owner", "admin", "member", "viewer", "doctor"] as Role[]).map((r) => [r, seedMember(db, orgA, `${r}@acme.test`, r)])) as Record<Role, Seeded>;
  doctorA = byRole.doctor;
  doctorA2 = seedMember(db, orgA, "doctor2@acme.test", "doctor");
  doctorB = seedMember(db, orgB, "doctor@beta.test", "doctor");
});

// ── little helpers over the real routes ──────────────────────────────────────

const create = async (who = doctorA, overrides: Record<string, unknown> = {}) => {
  const res = await call(listRoute.POST, "/api/consultations", { method: "POST", cookie: who.cookie, json: validCreate(overrides) });
  return { res, json: await body<{ consultation: { id: string; status: string } }>(res.clone()) };
};
const newId = async (who = doctorA) => (await create(who)).json.consultation.id;
const at = (id: string, n?: string): { params: Record<string, string> } => ({ params: n === undefined ? { id } : { id, n } });
const startUpload = (id: string, who = doctorA, mimeType = "audio/webm;codecs=opus") => call(recordingRoute.POST, `/api/consultations/${id}/recording`, { method: "POST", cookie: who.cookie, json: { mimeType }, ...at(id) });
const putPart = (id: string, n: number | string, bytes: Uint8Array, who = doctorA) => call(partRoute.PUT, `/api/consultations/${id}/recording/parts/${n}`, { method: "PUT", cookie: who.cookie, raw: bytes, ...at(id, String(n)) });
const complete = (id: string, info: Record<string, unknown>, who = doctorA) => call(completeRoute.POST, `/api/consultations/${id}/recording/complete`, { method: "POST", cookie: who.cookie, json: info, ...at(id) });
const detail = async (id: string, who = doctorA) => (await body<{ consultation: Record<string, unknown> }>(await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: who.cookie, ...at(id) }))).consultation;

/** The whole browser flow: open the upload, send every part, finish. Returns the audio that was recorded. */
async function recordAndUpload(id: string, size = UPLOAD_PART_BYTES + 5000, who = doctorA) {
  const bytes = audioBytes(size, 5);
  const parts = partsOf(bytes);
  expect((await startUpload(id, who)).status).toBe(200);
  for (const [i, p] of parts.entries()) expect((await putPart(id, i + 1, p, who)).status).toBe(200);
  const res = await complete(id, { totalBytes: bytes.length, partCount: parts.length, durationMs: 90_000, sha256: sha256(bytes) }, who);
  expect(res.status).toBe(200);
  return bytes;
}

/** What the worker would have produced: a transcript and an AI draft, saved for the consultation's own doctor. */
function simulateProcessed(consultationId: string, who: Seeded = doctorA, transcript: TranscriptContent = MIXED_TRANSCRIPT): { note: NoteContent } {
  const repo = new ConsultationRepository(db, who.orgId, who.userId, () => consultationVault(getConfig()));
  const note = groundNote(goodDraft(), transcript).note;
  const transcriptId = repo.addTranscript(consultationId, 1, "gemini", "test-model", transcript);
  repo.addAiDraft(consultationId, transcriptId, note, "gemini", "test-model");
  return { note };
}

const auditRows = () => db.prepare("SELECT action, outcome, actor_user_id, actor_org_id, target_org_id, target_label, details FROM audit_log WHERE action LIKE 'consultation.%' ORDER BY id").all() as { action: string; outcome: string; actor_user_id: string | null; actor_org_id: string | null; target_org_id: string | null; target_label: string | null; details: string | null }[];
const actions = () => auditRows().map((r) => r.action);

/** What the browser sends to save a note: ids, text, origin, evidence and each flag's reviewed state. */
const submission = (note: NoteContent, mutate: (s: { sections: { key: string; items: Record<string, unknown>[] }[]; flags: { id: string; resolved: boolean }[] }) => void = () => undefined) => {
  const s = {
    sections: note.sections.map((sec) => ({ key: sec.key, items: sec.items.map((i) => ({ id: i.id, text: i.text, origin: i.origin, evidence: [...i.evidence] })) })),
    flags: note.flags.map((f) => ({ id: f.id, resolved: f.resolved })),
  };
  mutate(s);
  return s;
};
const getNote = async (id: string, who = doctorA) => body<{ version: number; content: NoteContent; needsApproval: boolean; versions: { version: number; approvedAt: string | null }[] }>(await call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: who.cookie, ...at(id) }));
const saveNote = (id: string, baseVersion: number, note: unknown, who = doctorA) => call(noteRoute.PUT, `/api/consultations/${id}/note`, { method: "PUT", cookie: who.cookie, json: { baseVersion, note }, ...at(id) });
const approve = (id: string, json: unknown, who = doctorA) => call(approveRoute.POST, `/api/consultations/${id}/note/approve`, { method: "POST", cookie: who.cookie, json, ...at(id) });

// ── who may use it ───────────────────────────────────────────────────────────

describe("who can use consultations", () => {
  it("only a doctor: owners, administrators, members and viewers are refused (403), and a visitor who is not signed in gets 401", async () => {
    for (const role of ["owner", "admin", "member", "viewer"] as Role[]) {
      const who = byRole[role];
      expect((await call(listRoute.GET, "/api/consultations", { cookie: who.cookie })).status, `${role} list`).toBe(403);
      expect((await call(listRoute.POST, "/api/consultations", { method: "POST", cookie: who.cookie, json: validCreate() })).status, `${role} create`).toBe(403);
    }
    expect((await call(listRoute.GET, "/api/consultations")).status).toBe(401);
    expect((await call(listRoute.POST, "/api/consultations", { method: "POST", json: validCreate() })).status).toBe(401);
    expect((await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultations").get()).toEqual({ n: 0 });
  });

  it("an owner or administrator can't reach ANY consultation route, not even one that belongs to a doctor in their own workspace", async () => {
    const id = await newId();
    for (const role of ["owner", "admin"] as Role[]) {
      const cookie = byRole[role].cookie;
      const attempts: [string, Promise<Response>][] = [
        ["detail", call(oneRoute.GET, `/api/consultations/${id}`, { cookie, ...at(id) })],
        ["delete", call(oneRoute.DELETE, `/api/consultations/${id}`, { method: "DELETE", cookie, json: { confirm: true }, ...at(id) })],
        ["audio", call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie, ...at(id) })],
        ["transcript", call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie, ...at(id) })],
        ["note", call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie, ...at(id) })],
        ["approve", call(approveRoute.POST, `/api/consultations/${id}/note/approve`, { method: "POST", cookie, json: { version: 1, confirm: true }, ...at(id) })],
        ["retry", call(retryRoute.POST, `/api/consultations/${id}/retry`, { method: "POST", cookie, ...at(id) })],
        ["upload", startUpload(id, byRole[role])],
      ];
      for (const [name, request] of attempts) expect((await request).status, `${role} ${name}`).toBe(403);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultations").get()).toEqual({ n: 1 });
  });

  it("is off until the platform administrator switches the feature on, and unavailable until the server has its encryption key", async () => {
    h.off.add("consultations");
    const off = await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie });
    expect(off.status).toBe(403);
    expect(await body(off)).toMatchObject({ code: "feature_disabled", feature: "consultations" });
    expect((await call(listRoute.POST, "/api/consultations", { method: "POST", cookie: doctorA.cookie, json: validCreate() })).status).toBe(403);
    h.off.clear();

    const unconfigured = consultationEnv({ CONSULTATIONS_ENCRYPTION_KEY: undefined });
    try {
      const res = await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie });
      expect(res.status).toBe(503);
      expect((await body<{ error: string }>(res)).error).toMatch(/not set up on this server/);
    } finally {
      unconfigured.restore();
      env = consultationEnv();
    }
  });

  it("a doctor with a temporary password can't use it until they've chosen their own", async () => {
    db.prepare("UPDATE users SET must_change_password = 1, temp_password_expires_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(doctorA.userId);
    expect((await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie })).status).toBe(403);
  });
});

// ── consent ──────────────────────────────────────────────────────────────────

describe("consent comes first", () => {
  it("there is no consultation without a confirmed consent, and nothing is stored when it is refused", async () => {
    const bad: [string, Record<string, unknown>][] = [
      ["consent not confirmed", { consent: { version: CONSENT_VERSION, language: "gu", givenBy: "patient", method: "verbal", confirmed: false } }],
      ["consent missing", { consent: undefined }],
      ["consent confirmed as a string", { consent: { version: CONSENT_VERSION, language: "gu", givenBy: "patient", method: "verbal", confirmed: "true" } }],
      ["nobody said who agreed", { consent: { version: CONSENT_VERSION, language: "gu", method: "verbal", confirmed: true } }],
      ["unknown language of consent", { consent: { version: CONSENT_VERSION, language: "fr", givenBy: "patient", method: "verbal", confirmed: true } }],
      ["no patient", { patientLabel: "   " }],
      ["a field it doesn't know", { approved: true }],
    ];
    for (const [name, overrides] of bad) {
      const res = await call(listRoute.POST, "/api/consultations", { method: "POST", cookie: doctorA.cookie, json: validCreate(overrides) });
      expect(res.status, name).toBe(400);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_consents").get()).toEqual({ n: 0 });
  });

  it("consent given for older wording is refused, so the record always shows exactly what the patient was told", async () => {
    const res = await call(listRoute.POST, "/api/consultations", { method: "POST", cookie: doctorA.cookie, json: validCreate({ consent: { version: "an-older-version", language: "gu", givenBy: "patient", method: "verbal", confirmed: true } }) });
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: "consent_outdated" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultations").get()).toEqual({ n: 0 });
  });

  it("records who agreed, how, in which language and which wording (with a fingerprint of it), and who recorded it", async () => {
    const { res, json } = await create(doctorA, { consent: { version: CONSENT_VERSION, language: "hi", givenBy: "guardian", method: "written", confirmed: true } });
    expect(res.status).toBe(201);
    const row = db.prepare("SELECT * FROM consultation_consents WHERE consultation_id = ?").get(json.consultation.id) as Record<string, string>;
    expect(row).toMatchObject({ org_id: orgA, text_version: CONSENT_VERSION, language: "hi", given_by: "guardian", method: "written", recorded_by_user_id: doctorA.userId });
    expect(row.text_sha256).toMatch(/^[a-f0-9]{64}$/);
    const other = await create(doctorA, { consent: { version: CONSENT_VERSION, language: "gu", givenBy: "patient", method: "verbal", confirmed: true } });
    const gu = db.prepare("SELECT text_sha256 FROM consultation_consents WHERE consultation_id = ?").get(other.json.consultation.id) as { text_sha256: string };
    expect(gu.text_sha256).not.toBe(row.text_sha256); // the fingerprint is of the words in THAT language
  });

  it("no recording can start for a consultation whose consent record is missing", async () => {
    const id = await newId();
    db.prepare("DELETE FROM consultation_consents WHERE consultation_id = ?").run(id);
    const res = await startUpload(id);
    expect(res.status).toBe(409);
    expect(await body(res)).toMatchObject({ code: "consent_required" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_recordings").get()).toEqual({ n: 0 });
  });
});

// ── the recording ────────────────────────────────────────────────────────────

describe("recording and uploading", () => {
  it("the whole flow: a recording is received in parts, checked, kept, and queued for processing without waiting for it", async () => {
    const id = await newId();
    const bytes = await recordAndUpload(id, UPLOAD_PART_BYTES * 2 + 1234);
    const c = await detail(id);
    expect(c).toMatchObject({ status: "processing", stage: "transcribing", receivedParts: [], recording: { status: "stored", sizeBytes: bytes.length, durationMs: 90_000 } });
    expect(db.prepare("SELECT kind, status FROM consultation_jobs").all()).toEqual([{ kind: "transcribe", status: "queued" }]);
    expect(actions()).toEqual(["consultation.create", "consultation.consent.record", "consultation.recording.start", "consultation.recording.store"]);
  });

  it("an interrupted upload resumes: asking to start again says which parts already arrived, and a part sent twice is fine", async () => {
    const id = await newId();
    const bytes = audioBytes(UPLOAD_PART_BYTES * 2 + 10, 8);
    const parts = partsOf(bytes);
    await startUpload(id);
    await putPart(id, 1, parts[0]!);
    await putPart(id, 1, parts[0]!); // the network hiccuped and the browser retried
    expect((await detail(id)).receivedParts).toEqual([1]);

    const resumed = await body<{ receivedParts: number[] }>(await startUpload(id)); // after a reload
    expect(resumed.receivedParts).toEqual([1]);
    await putPart(id, 2, parts[1]!);
    await putPart(id, 3, parts[2]!);
    const res = await complete(id, { totalBytes: bytes.length, partCount: 3, durationMs: 60_000, sha256: sha256(bytes) });
    expect(res.status).toBe(200);
    expect(actions().filter((a) => a === "consultation.recording.start")).toHaveLength(1); // resuming isn't a second start
  });

  it("a damaged upload is refused and leaves the consultation recordable (nothing is queued)", async () => {
    const id = await newId();
    const bytes = audioBytes(UPLOAD_PART_BYTES + 100);
    const parts = partsOf(bytes);
    await startUpload(id);
    for (const [i, p] of parts.entries()) await putPart(id, i + 1, p);
    const bad = await complete(id, { totalBytes: bytes.length, partCount: 2, durationMs: 60_000, sha256: sha256("not it") });
    expect(bad.status).toBe(409);
    expect(await body(bad)).toMatchObject({ code: "checksum_mismatch" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 0 });
    expect((await detail(id)).status).toBe("uploading");
    const good = await complete(id, { totalBytes: bytes.length, partCount: 2, durationMs: 60_000, sha256: sha256(bytes) });
    expect(good.status).toBe(200); // the same upload can still be finished properly
  });

  it("completing twice stores once and queues once", async () => {
    const id = await newId();
    const bytes = await recordAndUpload(id);
    const again = await complete(id, { totalBytes: bytes.length, partCount: partsOf(bytes).length, durationMs: 90_000, sha256: sha256(bytes) });
    expect(again.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 1 });
    expect(actions().filter((a) => a === "consultation.recording.store")).toHaveLength(1);
  });

  it("a part with no declared length is refused as soon as more than a part's worth has arrived, instead of being buffered whole", async () => {
    const id = await newId();
    await startUpload(id);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024 * 1024)); // 1 MiB at a time, as if it would never stop
        if (pulled >= 80) controller.close();
      },
    });
    const request = new Request(`http://localhost:3000/api/consultations/${id}/recording/parts/1`, { method: "PUT", headers: { cookie: doctorA.cookie }, body: endless, duplex: "half" } as RequestInit);
    const res = await partRoute.PUT(request, { params: Promise.resolve({ id, n: "1" }) } as never);
    expect(res.status).toBe(413);
    expect(await body(res)).toMatchObject({ code: "part_too_large" });
    expect(pulled).toBeLessThan(10); // it stopped reading long before 80 MB
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_upload_parts").get()).toEqual({ n: 0 });
  });

  it("refuses bad input cleanly: a part that is too large, not audio, or numbered nonsensically; a format that isn't audio; unknown fields", async () => {
    const id = await newId();
    expect((await startUpload(id, doctorA, "application/pdf")).status).toBe(400);
    expect((await startUpload(id)).status).toBe(200);
    expect((await putPart(id, 1, audioBytes(UPLOAD_PART_BYTES + 1))).status).toBe(413);
    expect((await putPart(id, 1, new TextEncoder().encode("%PDF-1.7 this is not audio"))).status).toBe(400);
    for (const n of ["0", "-1", "abc", "1.5", "9999999"]) expect((await putPart(id, n, audioBytes(100))).status, n).toBe(400);
    expect((await call(completeRoute.POST, `/api/consultations/${id}/recording/complete`, { method: "POST", cookie: doctorA.cookie, json: { totalBytes: 1, partCount: 1, durationMs: 5000, sha256: "x".repeat(64), extra: 1 }, ...at(id) })).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_upload_parts").get()).toEqual({ n: 0 });
  });

  it("the AI service isn't involved in any of it: with the privacy gate closed the recording is kept and the doctor is told processing is waiting", async () => {
    const closed = consultationEnv({ CONSULTATIONS_PROVIDER_REVIEW: undefined });
    try {
      const id = await newId();
      await recordAndUpload(id);
      const c = await detail(id);
      expect(c).toMatchObject({ status: "processing", stage: "waiting" });
      expect(c.waitingReason).toMatch(/hasn't been approved/);
      expect(String(c.waitingReason)).not.toMatch(/CONSULTATIONS_|GEMINI|env/i); // the doctor hears no configuration detail
      expect(c.recording).toMatchObject({ status: "stored" });
    } finally {
      closed.restore();
      env = consultationEnv();
    }
  });

  it("deleting the recording keeps the transcript and note, and deleting it twice is harmless", async () => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    const del = () => call(recordingRoute.DELETE, `/api/consultations/${id}/recording`, { method: "DELETE", cookie: doctorA.cookie, ...at(id) });
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(204);
    expect(fs.existsSync(env.audioDir) ? fs.readdirSync(env.audioDir, { recursive: true }).filter((f) => String(f).includes("part-")) : []).toEqual([]);
    expect((await detail(id)).recording).toMatchObject({ status: "deleted" });
    expect((await call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(200);
    expect(actions().filter((a) => a === "consultation.audio.delete")).toHaveLength(1);
  });
});

// ── isolation ────────────────────────────────────────────────────────────────

describe("nobody can reach another doctor's consultation, in this workspace or any other", () => {
  async function everyRouteAs(who: Seeded, id: string): Promise<Record<string, number>> {
    const bytes = audioBytes(1000);
    const results: Record<string, number> = {};
    const run = async (name: string, request: Promise<Response>) => (results[name] = (await request).status);
    await run("detail", call(oneRoute.GET, `/api/consultations/${id}`, { cookie: who.cookie, ...at(id) }));
    await run("startUpload", startUpload(id, who));
    await run("putPart", putPart(id, 1, bytes, who));
    await run("complete", complete(id, { totalBytes: 1000, partCount: 1, durationMs: 5000, sha256: sha256(bytes) }, who));
    await run("audio", call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie: who.cookie, ...at(id) }));
    await run("deleteAudio", call(recordingRoute.DELETE, `/api/consultations/${id}/recording`, { method: "DELETE", cookie: who.cookie, ...at(id) }));
    await run("transcript", call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: who.cookie, ...at(id) }));
    await run("noteGet", call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: who.cookie, ...at(id) }));
    await run("noteSave", saveNote(id, 1, submission(groundNote(goodDraft(), MIXED_TRANSCRIPT).note), who)); // a well-formed edit: the ownership check is what answers
    await run("approve", approve(id, { version: 1, confirm: true }, who));
    await run("reopen", call(reopenRoute.POST, `/api/consultations/${id}/note/reopen`, { method: "POST", cookie: who.cookie, ...at(id) }));
    await run("retry", call(retryRoute.POST, `/api/consultations/${id}/retry`, { method: "POST", cookie: who.cookie, ...at(id) }));
    await run("delete", call(oneRoute.DELETE, `/api/consultations/${id}`, { method: "DELETE", cookie: who.cookie, json: { confirm: true }, ...at(id) }));
    return results;
  }

  it.each([
    ["a colleague doctor in the same workspace", () => doctorA2],
    ["a doctor in another workspace", () => doctorB],
  ])("%s gets 'not found' on every route, and nothing changes", async (_name, whoOf) => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    const before = JSON.stringify({
      consultations: db.prepare("SELECT * FROM consultations").all(),
      notes: db.prepare("SELECT id, version, approved_at FROM consultation_notes").all(),
      parts: db.prepare("SELECT * FROM consultation_upload_parts").all(),
      files: fs.readdirSync(env.audioDir, { recursive: true }).map(String).sort(),
    });
    const results = await everyRouteAs(whoOf(), id);
    expect(Object.values(results).every((s) => s === 404), JSON.stringify(results)).toBe(true);
    const after = JSON.stringify({
      consultations: db.prepare("SELECT * FROM consultations").all(),
      notes: db.prepare("SELECT id, version, approved_at FROM consultation_notes").all(),
      parts: db.prepare("SELECT * FROM consultation_upload_parts").all(),
      files: fs.readdirSync(env.audioDir, { recursive: true }).map(String).sort(),
    });
    expect(after).toBe(before);
    // The owner of the consultation still has all of it.
    expect((await detail(id)).status).toBe("needs_review");
  });

  it("every refused attempt is written to the audit log with who tried (and where from), without the patient's details", async () => {
    const id = await newId();
    await everyRouteAs(doctorB, id);
    const denied = auditRows().filter((r) => r.action === "consultation.access_denied");
    expect(denied.length).toBeGreaterThanOrEqual(10);
    for (const row of denied) {
      expect(row).toMatchObject({ outcome: "denied", actor_user_id: doctorB.userId, actor_org_id: orgB, target_org_id: orgB, target_label: id });
      expect(row.details ?? "").not.toMatch(/Asha|Patel|4471/);
    }
  });

  it("a malformed or invented id is 'not found' and recorded as an attempt; the list shows only your own", async () => {
    const mine = await newId(doctorA);
    await newId(doctorB);
    await newId(doctorA2);
    for (const bad of ["not-a-uuid", "../../etc/passwd", "00000000-0000-4000-8000-000000000000", "1' OR '1'='1"]) {
      expect((await call(oneRoute.GET, `/api/consultations/${encodeURIComponent(bad)}`, { cookie: doctorA.cookie, ...at(bad) })).status, bad).toBe(404);
    }
    expect(auditRows().filter((r) => r.action === "consultation.access_denied")).toHaveLength(4);
    const list = await body<{ consultations: { id: string }[] }>(await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie }));
    expect(list.consultations.map((c) => c.id)).toEqual([mine]);
  });

  it("a doctor who is later also a member of another workspace sees only the workspace they are signed in to", async () => {
    const inA = await newId(doctorA);
    const alsoInB = seedMember(db, orgB, doctorA.email, "doctor"); // the same person, signed in to Beta
    const idB = await newId(alsoInB);
    const listB = await body<{ consultations: { id: string }[] }>(await call(listRoute.GET, "/api/consultations", { cookie: alsoInB.cookie }));
    expect(listB.consultations.map((c) => c.id)).toEqual([idB]);
    expect((await call(oneRoute.GET, `/api/consultations/${inA}`, { cookie: alsoInB.cookie, ...at(inA) })).status).toBe(404);
  });
});

// ── review and approval ──────────────────────────────────────────────────────

describe("review, editing and approval", () => {
  async function ready() {
    const id = await newId();
    await recordAndUpload(id);
    const { note } = simulateProcessed(id);
    return { id, note };
  }

  it("shows the transcript and note to the doctor, and records each look", async () => {
    const { id } = await ready();
    const t = await body<{ content: TranscriptContent; version: number; provider: string }>(await call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) }));
    expect(t.content.segments[1]!.text).toContain("ડૉક્ટર સાહેબ"); // the original, in its own scripts, exactly as received
    expect(t).toMatchObject({ version: 1, provider: "gemini" });
    const n = await getNote(id);
    expect(n).toMatchObject({ version: 1, needsApproval: true });
    expect(actions()).toEqual(expect.arrayContaining(["consultation.transcript.view", "consultation.note.view"]));
  });

  it("an edit becomes a new version, earlier versions are kept, and two windows can't overwrite each other", async () => {
    const { id, note } = await ready();
    const edited = submission(note, (s) => (s.sections.find((x) => x.key === "assessment")!.items.push({ id: "mine-1", text: "Viral fever.", origin: "clinician_assessment", evidence: [] })));
    const saved = await saveNote(id, 1, edited);
    expect(saved.status).toBe(200);
    expect(await body(saved)).toEqual({ version: 2 });
    const stale = await saveNote(id, 1, edited); // a second window that still has version 1
    expect(stale.status).toBe(409);
    expect(await body(stale)).toMatchObject({ code: "stale_note" });
    const n = await getNote(id);
    expect(n.version).toBe(2);
    expect(n.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(n.content.sections.find((s) => s.key === "assessment")!.items[0]).toMatchObject({ text: "Viral fever.", byDoctor: true });
    expect(actions()).toContain("consultation.note.edit");
  });

  it("the safety flags can only be reviewed, never removed or reworded", async () => {
    const { id, note } = await ready();
    expect(note.flags.length).toBeGreaterThan(0);
    expect((await saveNote(id, 1, submission(note, (s) => s.flags.pop()))).status).toBe(400);
    expect((await saveNote(id, 1, submission(note, (s) => s.flags.push({ id: "invented", resolved: true })))).status).toBe(400);
    expect((await saveNote(id, 1, { ...submission(note), flags: [{ id: note.flags[0]!.id, resolved: true, text: "all fine" }] })).status).toBe(200); // extra fields are ignored, not stored
    expect((await getNote(id)).content.flags[0]!.text).toBe(note.flags[0]!.text);
  });

  it("nothing is approved by default or automatically: the doctor must say so, for the current version, after reviewing every flag", async () => {
    const { id, note } = await ready();
    expect((await approve(id, { version: 1 })).status).toBe(400); // no explicit confirmation
    expect((await approve(id, { version: 1, confirm: false })).status).toBe(400);
    expect((await approve(id, { version: 1, confirm: "yes" })).status).toBe(400);
    const flagged = await approve(id, { version: 1, confirm: true });
    expect(flagged.status).toBe(409); // there is a flag to review first
    expect(await body(flagged)).toMatchObject({ code: "flags_unresolved" });
    expect((await detail(id)).status).toBe("needs_review");

    const reviewed = await saveNote(id, 1, submission(note, (s) => s.flags.forEach((f) => (f.resolved = true))));
    expect(reviewed.status).toBe(200); // version 2, flags reviewed
    expect((await approve(id, { version: 1, confirm: true })).status).toBe(409); // not the current version
    const done = await approve(id, { version: 2, confirm: true });
    expect(done.status).toBe(200);
    expect(await body(done)).toEqual({ approved: true, version: 2 });
    expect(await detail(id)).toMatchObject({ status: "approved", noteVersion: 2 });
    expect(actions()).toContain("consultation.note.approve");
    const row = db.prepare("SELECT approved_by_user_id, approved_at FROM consultation_notes WHERE version = 2").get() as { approved_by_user_id: string; approved_at: string };
    expect(row.approved_by_user_id).toBe(doctorA.userId);
    expect(row.approved_at).toBeTruthy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_notes WHERE approved_at IS NOT NULL").get()).toEqual({ n: 1 });
  });

  it("an approved note is final: it can't be approved again or edited, and reopening makes a new version while the approved one stays exactly as it was", async () => {
    const { id, note } = await ready();
    await saveNote(id, 1, submission(note, (s) => s.flags.forEach((f) => (f.resolved = true))));
    await approve(id, { version: 2, confirm: true });
    const approvedBefore = db.prepare("SELECT hex(content) AS c, approved_at FROM consultation_notes WHERE version = 2").get();

    expect((await approve(id, { version: 2, confirm: true })).status).toBe(409);
    const edit = await saveNote(id, 2, submission(note));
    expect(edit.status).toBe(409);
    expect(await body(edit)).toMatchObject({ code: "note_approved" });

    const reopened = await call(reopenRoute.POST, `/api/consultations/${id}/note/reopen`, { method: "POST", cookie: doctorA.cookie, ...at(id) });
    expect(await body(reopened)).toEqual({ version: 3 });
    expect(await detail(id)).toMatchObject({ status: "needs_review" });
    expect(db.prepare("SELECT hex(content) AS c, approved_at FROM consultation_notes WHERE version = 2").get()).toEqual(approvedBefore); // untouched
    const n = await getNote(id);
    expect(n).toMatchObject({ version: 3, needsApproval: true });
    expect(n.versions.map((v) => [v.version, v.approvedAt !== null])).toEqual([[3, false], [2, true], [1, false]]);
    expect(actions()).toContain("consultation.note.reopen");
    expect((await call(reopenRoute.POST, `/api/consultations/${id}/note/reopen`, { method: "POST", cookie: doctorA.cookie, ...at(id) })).status).toBe(409); // only an approved note can be reopened
  });

  it("can't be approved or edited before there is a draft", async () => {
    const id = await newId();
    expect((await approve(id, { version: 1, confirm: true })).status).toBe(409);
    expect((await saveNote(id, 1, submission(emptyNote()))).status).toBe(409);
    expect((await call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(404);
    expect((await call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(404);
  });

  it("a failed consultation can be retried once, and not while it is already being processed", async () => {
    const id = await newId();
    await recordAndUpload(id);
    const retry = () => call(retryRoute.POST, `/api/consultations/${id}/retry`, { method: "POST", cookie: doctorA.cookie, ...at(id) });
    expect((await retry()).status).toBe(409); // still processing
    db.prepare("UPDATE consultations SET status = 'failed', failure_code = 'provider_busy', failure_message = 'busy' WHERE id = ?").run(id);
    db.prepare("UPDATE consultation_jobs SET status = 'failed'").run();
    const res = await retry();
    expect(res.status).toBe(200);
    expect(await detail(id)).toMatchObject({ status: "processing" });
    expect(db.prepare("SELECT generation, status FROM consultation_jobs ORDER BY generation").all()).toEqual([{ generation: 1, status: "failed" }, { generation: 2, status: "queued" }]);
    expect((await retry()).status).toBe(409);
    expect(actions()).toContain("consultation.retry");
  });
});

// ── listening, deleting ──────────────────────────────────────────────────────

describe("listening to and deleting a consultation", () => {
  it("serves the doctor's own recording back exactly, never cached, supports seeking, and records each listen", async () => {
    const id = await newId();
    const bytes = await recordAndUpload(id);
    const listen = (range?: string, who = doctorA) => call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie: who.cookie, headers: range ? { range } : {}, ...at(id) });
    const whole = await listen();
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/webm");
    expect(whole.headers.get("cache-control")).toMatch(/no-store/);
    expect(whole.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);

    const part = await listen("bytes=100-199");
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${bytes.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true);
    const tail = await listen("bytes=-50");
    expect(Buffer.from(await tail.arrayBuffer()).equals(bytes.subarray(bytes.length - 50))).toBe(true);
    expect((await listen(`bytes=${bytes.length + 10}-`)).status).toBe(416);
    expect(actions().filter((a) => a === "consultation.audio.listen").length).toBeGreaterThanOrEqual(3);
    expect((await listen(undefined, doctorB)).status).toBe(404);
  });

  it("deleting needs an explicit confirmation, then removes the audio, the records and everything under them, and says so in the audit log", async () => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    const del = (json?: unknown) => call(oneRoute.DELETE, `/api/consultations/${id}`, { method: "DELETE", cookie: doctorA.cookie, json, ...at(id) });
    expect((await del()).status).toBe(400);
    expect((await del({ confirm: false })).status).toBe(400);
    expect((await detail(id)).status).toBe("needs_review"); // nothing happened yet
    expect((await del({ confirm: true })).status).toBe(204);
    for (const table of ["consultations", "consultation_consents", "consultation_recordings", "consultation_upload_parts", "consultation_jobs", "consultation_transcripts", "consultation_notes"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(fs.readdirSync(env.audioDir, { recursive: true }).filter((f) => String(f).includes("part-"))).toEqual([]);
    expect(actions()).toContain("consultation.delete");
    expect((await del({ confirm: true })).status).toBe(404);
  });

  it("deleting one doctor's consultation leaves another doctor's, in the same workspace, untouched", async () => {
    const mine = await newId(doctorA);
    const theirs = await newId(doctorA2);
    await recordAndUpload(theirs, 3000, doctorA2);
    await call(oneRoute.DELETE, `/api/consultations/${mine}`, { method: "DELETE", cookie: doctorA.cookie, json: { confirm: true }, ...at(mine) });
    expect((await detail(theirs, doctorA2)).recording).toMatchObject({ status: "stored" });
    expect(fs.readdirSync(env.audioDir, { recursive: true }).filter((f) => String(f).includes("part-"))).toHaveLength(1);
  });
});

// ── what is stored and what is said ──────────────────────────────────────────

describe("health information is sealed at rest, and kept out of logs and responses", () => {
  it("the database file holds no readable patient label, transcript or note", async () => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    const dump = JSON.stringify(
      ["consultations", "consultation_transcripts", "consultation_notes"].map((t) => (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]).map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString("latin1") : v)))),
    );
    for (const secret of ["Asha", "Patel", "4471", "metformin", "Paracetamol", "ડૉક્ટર", "fever", "Temperature"]) expect(dump, secret).not.toContain(secret);
    const label = db.prepare("SELECT patient_label FROM consultations").get() as { patient_label: Buffer };
    expect(Buffer.isBuffer(label.patient_label)).toBe(true);
  });

  it("the audit log records what happened and who did it, but never the patient, the transcript or the note", async () => {
    const id = await newId();
    await recordAndUpload(id);
    const { note } = simulateProcessed(id);
    await call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) });
    await saveNote(id, 1, submission(note, (s) => (s.sections[0]!.items[0]!.text = "Edited: severe fever and headache.")));
    const log = JSON.stringify(db.prepare("SELECT * FROM audit_log").all());
    for (const secret of ["Asha", "Patel", "4471", "metformin", "Paracetamol", "ડૉક્ટર", "fever", "Edited"]) expect(log, secret).not.toContain(secret);
    expect(actions()).toEqual(expect.arrayContaining(["consultation.create", "consultation.consent.record", "consultation.recording.store", "consultation.transcript.view", "consultation.note.edit"]));
    for (const row of auditRows()) expect(row.actor_user_id).toBe(doctorA.userId);
  });

  it("no response ever contains the AI key, the encryption key, or another customer's data", async () => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    await newId(doctorB);
    const responses = await Promise.all([
      call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie }),
      call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorA.cookie, ...at(id) }),
      call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) }),
      call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: doctorA.cookie, ...at(id) }),
    ]);
    const text = (await Promise.all(responses.map((r) => r.text()))).join("\n");
    expect(text).not.toContain(process.env.GEMINI_API_KEY!);
    expect(text).not.toContain(process.env.CONSULTATIONS_ENCRYPTION_KEY!);
    expect(text).not.toMatch(/storage_key|storageKey/);
    expect(text).not.toContain(env.audioDir);
    expect(text).not.toContain(env.dir);
    expect(text).not.toContain(orgA);
    expect(text).not.toContain(orgB);
  });

  it("an unexpected failure answers with a generic message and never echoes what went wrong", async () => {
    const id = await newId();
    db.exec("DROP TRIGGER trg_consultations_org_immutable"); // break something on purpose
    db.exec("ALTER TABLE consultation_consents RENAME TO broken_consents"); // detail() reads consents: this will throw inside the route
    const res = await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorA.cookie, ...at(id) });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toMatch(/Something went wrong on the server/);
    expect(text).not.toMatch(/consultation_consents|SQLITE|no such table/i);
  });
});

describe("the list", () => {
  it("shows the doctor's consultations newest first, with the label they typed, and never the audio, transcript or note", async () => {
    const first = await newId();
    await new Promise((r) => setTimeout(r, 5));
    const second = (await create(doctorA, { patientLabel: "Ravi Shah" })).json.consultation.id;
    const res = await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie });
    const json = await body<{ consultations: { id: string; patientLabel: string }[]; limits: { partBytes: number; maxMinutes: number; mimeTypes: string[] }; consentVersion: string }>(res);
    expect(json.consultations.map((c) => [c.id, c.patientLabel])).toEqual([[second, "Ravi Shah"], [first, "Asha Patel, record 4471"]]);
    expect(json.limits).toMatchObject({ partBytes: UPLOAD_PART_BYTES, maxMinutes: 45 });
    expect(json.limits.mimeTypes).toContain("audio/webm");
    expect(json.consentVersion).toBe(CONSENT_VERSION);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

// ── the audit trail ──────────────────────────────────────────────────────────

describe("the audit trail stays meaningful and can't be fooled", () => {
  const deniedRows = () => auditRows().filter((r) => r.action === "consultation.access_denied");

  it("an ordinary 'nothing here yet' answer about your own consultation is not recorded as a refused access", async () => {
    const id = await newId();
    expect((await call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(404);
    expect((await call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(404);
    expect((await call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(404);
    expect(deniedRows()).toEqual([]);
    // ...while a consultation that is not yours still is.
    await call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: doctorB.cookie, ...at(id) });
    expect(deniedRows()).toHaveLength(1);
  });

  it("one person can't flood the append-only log with refusals: the first few are kept, the rest are dropped, and other people are unaffected", async () => {
    resetDeniedThrottleForTests();
    const id = await newId();
    for (let i = 0; i < 60; i++) await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorB.cookie, ...at(id) });
    const byB = deniedRows().filter((r) => r.actor_user_id === doctorB.userId);
    expect(byB).toHaveLength(20);
    expect((await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorB.cookie, ...at(id) })).status).toBe(404); // still refused, just not written again
    await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorA2.cookie, ...at(id) });
    expect(deniedRows().filter((r) => r.actor_user_id === doctorA2.userId)).toHaveLength(1); // someone else's attempt is still recorded
  });

  it("reading a transcript, note or recording is refused if the record of it can't be written: nothing is served unlogged", async () => {
    const id = await newId();
    await recordAndUpload(id);
    simulateProcessed(id);
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_unavailable"); // the audit log can't be written
    for (const [name, request] of [
      ["transcript", call(transcriptRoute.GET, `/api/consultations/${id}/transcript`, { cookie: doctorA.cookie, ...at(id) })],
      ["note", call(noteRoute.GET, `/api/consultations/${id}/note`, { cookie: doctorA.cookie, ...at(id) })],
      ["recording", call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie: doctorA.cookie, ...at(id) })],
    ] as const) {
      const res = await request;
      expect(res.status, name).toBe(500);
      const text = await res.text();
      expect(text, name).toMatch(/Something went wrong on the server/);
      expect(text, name).not.toMatch(/Paracetamol|metformin|ડૉક્ટર|segments|sections/);
      expect(res.headers.get("content-type"), name).not.toMatch(/audio/);
    }
  });

  it("but ordinary work isn't blocked when only a minor event can't be logged: listing and opening your own consultation still work", async () => {
    const id = await newId();
    db.exec("ALTER TABLE audit_log RENAME TO audit_log_unavailable");
    expect((await call(listRoute.GET, "/api/consultations", { cookie: doctorA.cookie })).status).toBe(200);
    expect((await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorA.cookie, ...at(id) })).status).toBe(200);
    expect((await call(oneRoute.GET, `/api/consultations/${id}`, { cookie: doctorB.cookie, ...at(id) })).status).toBe(404); // a refusal is still a clean refusal
  });
});

// ── the browser's own uploader, against these routes ─────────────────────────

describe("the browser's uploader talking to the real server", () => {
  const instant = { sleep: async () => undefined };
  type Hooks = { beforePart?: (n: number, bytes: Uint8Array, attempt: number) => Uint8Array | void; onCall?: (what: string, n?: number) => void };

  /** The same calls the page makes, answered by the real route handlers, with a place to break things on the way. */
  function over(who: Seeded, hooks: Hooks = {}): UploadApi {
    const fail = async (res: Response): Promise<never> => {
      const json = await body<{ error: string; code?: string }>(res);
      throw Object.assign(new Error(json.error), { status: res.status, code: json.code });
    };
    const attempts = new Map<number, number>();
    return {
      start: async (id, mimeType) => {
        hooks.onCall?.("start");
        const res = await startUpload(id, who, mimeType);
        return res.ok ? body(res) : fail(res);
      },
      putPart: async (id, n, blob) => {
        const attempt = (attempts.get(n) ?? 0) + 1;
        attempts.set(n, attempt);
        hooks.onCall?.("part", n);
        let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
        bytes = hooks.beforePart?.(n, bytes, attempt) ?? bytes;
        const res = await putPart(id, n, bytes, who);
        if (!res.ok) await fail(res);
      },
      complete: async (id, info) => {
        hooks.onCall?.("complete");
        const res = await complete(id, info, who);
        if (!res.ok) await fail(res);
      },
    };
  }
  const recorded = (size: number, seed = 3) => {
    const bytes = audioBytes(size, seed);
    return { bytes, blob: new Blob([new Uint8Array(bytes)], { type: "audio/webm;codecs=opus" }) };
  };
  const storedAudio = async (id: string) => Buffer.from(await (await call(audioRoute.GET, `/api/consultations/${id}/audio`, { cookie: doctorA.cookie, ...at(id) })).arrayBuffer());

  it("a recording goes through exactly as it was recorded", async () => {
    const id = await newId();
    const { bytes, blob } = recorded(UPLOAD_PART_BYTES * 2 + 4321);
    await uploadRecording(over(doctorA), id, blob, 123_000, instant);
    expect(await detail(id)).toMatchObject({ status: "processing", recording: { status: "stored", sizeBytes: bytes.length, durationMs: 123_000 } });
    expect((await storedAudio(id)).equals(bytes)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 1 });
  });

  it("a network failure part-way through is retried and nothing is lost or duplicated", async () => {
    const id = await newId();
    const { bytes, blob } = recorded(UPLOAD_PART_BYTES * 3);
    await uploadRecording(over(doctorA, { beforePart: (n, _b, attempt) => { if (n === 2 && attempt === 1) throw new Error("Could not reach the server."); } }), id, blob, 90_000, instant);
    expect((await storedAudio(id)).equals(bytes)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_upload_parts").get()).toEqual({ n: 3 });
  });

  it("bytes damaged in transit are caught by the whole-recording checksum, and the uploader repairs it by sending the parts again", async () => {
    const id = await newId();
    const { bytes, blob } = recorded(UPLOAD_PART_BYTES * 2 + 500);
    const damage = (n: number, b: Uint8Array, attempt: number) => {
      if (n === 2 && attempt === 1) {
        const copy = new Uint8Array(b);
        copy[10] = copy[10]! ^ 0xff; // one flipped byte somewhere on the way
        return copy;
      }
    };
    await uploadRecording(over(doctorA, { beforePart: damage }), id, blob, 90_000, instant);
    expect((await storedAudio(id)).equals(bytes)).toBe(true); // the second pass was clean, and that is what is stored
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 1 });
  });

  it("if the damage never stops, nothing is kept or queued, and the doctor is told to try again", async () => {
    const id = await newId();
    const { blob } = recorded(UPLOAD_PART_BYTES + 500);
    const always = (n: number, b: Uint8Array) => (n === 2 ? new Uint8Array(b).map((v, i) => (i === 3 ? v ^ 1 : v)) : undefined);
    const err = await uploadRecording(over(doctorA, { beforePart: always }), id, blob, 90_000, instant).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err).toMatchObject({ retryable: true, message: expect.stringMatching(/arrived damaged/) });
    expect((await detail(id)).status).toBe("uploading");
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs").get()).toEqual({ n: 0 });
  });

  it("an interrupted upload resumes from the parts the server already has", async () => {
    const id = await newId();
    const { bytes, blob } = recorded(UPLOAD_PART_BYTES * 3 + 10);
    // First attempt: the page dies after two parts.
    await expect(uploadRecording(over(doctorA, { beforePart: (n) => { if (n === 3) throw Object.assign(new Error("tab closed"), { status: 400 }); } }), id, blob, 90_000, instant)).rejects.toBeInstanceOf(UploadError);
    expect((await detail(id)).receivedParts).toEqual([1, 2]);

    const sent: number[] = [];
    await uploadRecording(over(doctorA, { onCall: (what, n) => what === "part" && sent.push(n!) }), id, blob, 90_000, instant);
    expect(sent).toEqual([3, 4]); // only what was missing
    expect((await storedAudio(id)).equals(bytes)).toBe(true);
  });

  it("a shorter recording made after an abandoned longer attempt still goes through (the stale parts used to make completing impossible for ever)", async () => {
    const id = await newId();
    // The first attempt: five parts reach the server, then the doctor discards the recording in the browser (which, before, never told the server).
    const abandoned = audioBytes(UPLOAD_PART_BYTES * 4 + 100, 1);
    await startUpload(id);
    for (const [i, p] of partsOf(abandoned).entries()) expect((await putPart(id, i + 1, p)).status).toBe(200);
    expect((await detail(id)).receivedParts).toEqual([1, 2, 3, 4, 5]);

    // The next visit is shorter (two parts). The server still lists the old parts as received, so the uploader skips sending 1 and 2.
    const { bytes, blob } = recorded(UPLOAD_PART_BYTES + 500, 7);
    await uploadRecording(over(doctorA), id, blob, 60_000, instant);
    expect((await storedAudio(id)).equals(bytes)).toBe(true); // exactly the NEW recording, not a mixture
    expect(await detail(id)).toMatchObject({ status: "processing", recording: { status: "stored", sizeBytes: bytes.length } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM consultation_upload_parts").get()).toEqual({ n: 2 });
  });

  it("another doctor can't upload into this consultation, and the uploader gives up at once instead of retrying", async () => {
    const id = await newId();
    const { blob } = recorded(5000);
    const calls: string[] = [];
    const err = await uploadRecording(over(doctorB, { onCall: (w) => calls.push(w) }), id, blob, 90_000, instant).catch((e) => e);
    expect(err).toMatchObject({ retryable: false });
    expect(calls).toEqual(["start"]);
    expect((await detail(id)).status).toBe("ready");
  });
});
