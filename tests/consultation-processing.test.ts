import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_VERSION } from "@/lib/consultation-consent";
import type { TranscriptContent } from "@/lib/consultations";
import type { AppConfig } from "@/server/config";
import { LocalAudioStore, partKey } from "@/server/consultations/audio-store";
import { consultationsConfigured, DOCTOR_WAITING_MESSAGE, processingGate } from "@/server/consultations/gate";
import { ConsultationJobs } from "@/server/consultations/jobs";
import { ProcessingError } from "@/server/consultations/processing-error";
import { RecordingService } from "@/server/consultations/recording";
import { ConsultationRepository } from "@/server/consultations/repository";
import type { TranscriptionRequest } from "@/server/consultations/transcription/types";
import { backoffMs, ConsultationWorker, type WorkerDeps } from "@/server/consultations/worker";
import { LLMError } from "@/server/llm/types";
import { Vault } from "@/server/security/vault";
import { seedMember, seedOrganization } from "./harness";
import { audioBytes, CONSULT_KEY, goodDraft, MIXED_TRANSCRIPT, sha256 } from "./consultation-helpers";
import { memoryDb, testConfig } from "./helpers";

const vault = new Vault(CONSULT_KEY);
let dir: string;
let consoleOutput: string[];

const cfg = (overrides: Partial<AppConfig> = {}) =>
  testConfig({
    CONSULTATIONS_ENCRYPTION_KEY: CONSULT_KEY,
    CONSULTATIONS_TRANSCRIPTION_PROVIDER: "gemini",
    CONSULTATIONS_TRANSCRIPTION_MODEL: "test-transcription-model",
    CONSULTATIONS_NOTE_MODEL: "test-note-model",
    CONSULTATIONS_PROVIDER_REVIEW: "Reviewed by Dr. Test on 2026-10-20 (ticket 1)",
    CONSULTATIONS_PROVIDER_REGION: "test-region",
    GEMINI_API_KEY: "k-test",
    GEMINI_MODEL: "chat-model",
    ...overrides,
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-worker-"));
  consoleOutput = [];
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void consoleOutput.push(args.map(String).join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Everything a worker needs, with a fake speech service, a fake note drafter and a clock the test controls. */
function world(overrides: Partial<AppConfig> = {}, extra: { deadlineMs?: number } = {}) {
  const db = memoryDb();
  const store = new LocalAudioStore(dir);
  let offset = 0;
  const clock = () => new Date(Date.now() + offset);
  const transcriber = { id: "gemini" as const, transcribe: vi.fn(async (_request: TranscriptionRequest): Promise<TranscriptContent> => structuredClone(MIXED_TRANSCRIPT)) };
  const noteProvider = { id: "gemini" as const, generate: vi.fn(async (_request: unknown) => ({ text: JSON.stringify(goodDraft()) })) };
  const config = cfg(overrides);
  const gate = { current: processingGate(config, "k-test") as { open: boolean; reason: string | null } };
  const gemini = { current: { apiKey: "k-test" as string | undefined, model: "chat-model" as string | undefined } };
  const feature = { current: true };
  const deps: WorkerDeps = { db, config, transcriber, noteProvider, store, vault: () => vault, gemini: () => gemini.current, gateOpen: () => gate.current, featureEnabled: () => feature.current };
  const worker = new ConsultationWorker(deps, clock, extra.deadlineMs);

  /** A doctor with a consultation whose recording has been uploaded and is waiting to be processed. */
  async function recorded(options: { org?: string; email?: string; seed?: number; hint?: "auto" | "en" | "hi" | "gu" | "mixed"; size?: number } = {}) {
    const org = options.org ?? seedOrganization(db, `Clinic ${Math.random()}`);
    const doctor = seedMember(db, org, options.email ?? `doc-${Math.random()}@clinic.test`, "doctor");
    const repo = new ConsultationRepository(db, org, doctor.userId, () => vault);
    const recordings = new RecordingService(repo, store, () => vault, org, { maxBytes: 50e6, maxMinutes: 60 });
    const id = repo.create({ patientLabel: "Asha Patel", languageHint: options.hint ?? "mixed", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "gu", givenBy: "patient", method: "verbal" } });
    const bytes = audioBytes(options.size ?? 5000, options.seed ?? 1);
    recordings.start(id, "audio/webm");
    await recordings.putPart(id, 1, bytes);
    await recordings.complete(id, { totalBytes: bytes.length, partCount: 1, durationMs: 60_000, sha256: sha256(bytes) });
    return { org, doctor, repo, recordings, id, bytes };
  }
  const jobs = () => db.prepare("SELECT kind, generation, status, attempts, error_code FROM consultation_jobs ORDER BY created_at, kind DESC").all() as { kind: string; generation: number; status: string; attempts: number; error_code: string | null }[];
  return { db, store, transcriber, noteProvider, worker, deps, gate, gemini, feature, config, recorded, jobs, advance: (ms: number) => (offset += ms), clock };
}

const audit = (db: ReturnType<typeof memoryDb>) => db.prepare("SELECT action, outcome, actor_user_id, target_label, details FROM audit_log WHERE action LIKE 'consultation.processing.%'").all() as { action: string; outcome: string; actor_user_id: string | null; target_label: string; details: string }[];
const busy = () => new ProcessingError("provider_busy", "Transcription is busy right now and will be retried automatically.", true);

describe("the privacy gate", () => {
  it("is open only when everything is set: the key, a provider and model, the AI key, the named privacy review and the region", () => {
    expect(processingGate(cfg(), "k")).toEqual({ open: true, reason: null });
    const closedBy: [string, Partial<AppConfig>, string | undefined][] = [
      ["no encryption key", { CONSULTATIONS_ENCRYPTION_KEY: undefined }, "k"],
      ["no provider chosen", { CONSULTATIONS_TRANSCRIPTION_PROVIDER: undefined }, "k"],
      ["no transcription model", { CONSULTATIONS_TRANSCRIPTION_MODEL: undefined }, "k"],
      ["no note model", { CONSULTATIONS_NOTE_MODEL: undefined, GEMINI_MODEL: undefined }, "k"],
      ["no AI key", {}, undefined],
      ["no privacy review recorded", { CONSULTATIONS_PROVIDER_REVIEW: undefined }, "k"],
      ["a review that says nothing", { CONSULTATIONS_PROVIDER_REVIEW: "ok" }, "k"],
      ["no region recorded", { CONSULTATIONS_PROVIDER_REGION: undefined }, "k"],
    ];
    for (const [name, overrides, key] of closedBy) {
      const gate = processingGate(cfg(overrides), key);
      expect(gate.open, name).toBe(false);
      expect(gate.reason, name).toBeTruthy();
    }
  });

  it("consultations can be used at all only when the sealing key is set", () => {
    expect(consultationsConfigured(cfg())).toBe(true);
    expect(consultationsConfigured(cfg({ CONSULTATIONS_ENCRYPTION_KEY: undefined }))).toBe(false);
  });

  it("while it is closed NOTHING is sent anywhere and no job is taken, however long it waits; the moment it opens, the waiting work runs", async () => {
    const w = world();
    const r = await w.recorded();
    w.gate.current = { open: false, reason: "CONSULTATIONS_PROVIDER_REVIEW is not set" };
    for (let i = 0; i < 3; i++) expect(await w.worker.tick()).toBe(0);
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(w.noteProvider.generate).not.toHaveBeenCalled();
    expect(w.jobs()).toEqual([{ kind: "transcribe", generation: 1, status: "queued", attempts: 0, error_code: null }]);
    expect(r.repo.require(r.id).status).toBe("processing");
    expect(r.repo.detail(r.id, w.gate.current)).toMatchObject({ stage: "waiting", waitingReason: DOCTOR_WAITING_MESSAGE });
    expect(consoleOutput.filter((l) => /processing is paused/.test(l))).toHaveLength(1); // the operator is told once, not every few seconds

    w.gate.current = { open: true, reason: null };
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
  });
});

describe("processing a recording", () => {
  it("transcribes the exact audio, drafts a note from the TRANSCRIPT (never the audio), and hands the consultation to the doctor", async () => {
    const w = world();
    const r = await w.recorded({ hint: "gu" });
    expect(await w.worker.tick()).toBe(2);

    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);
    const request = w.transcriber.transcribe.mock.calls[0]![0];
    expect(request.audio.equals(r.bytes)).toBe(true);
    expect(request).toMatchObject({ mimeType: "audio/webm", languageHint: "gu", model: "test-transcription-model", apiKey: "k-test" });

    expect(w.noteProvider.generate).toHaveBeenCalledTimes(1);
    const draft = w.noteProvider.generate.mock.calls[0]![0] as { content: { type: string; text?: string }[]; model: string };
    expect(draft.content.every((part) => part.type === "text")).toBe(true); // text only: the audio is not given to the drafter
    expect(draft.model).toBe("test-note-model");
    expect(draft.content.map((p) => p.text).join("")).toContain("[1] doctor: નમસ્તે");

    expect(r.repo.latestTranscript(r.id)).toMatchObject({ version: 1, provider: "gemini", model: "test-transcription-model", content: MIXED_TRANSCRIPT });
    const note = r.repo.latestNote(r.id)!;
    expect(note.row).toMatchObject({ version: 1, source: "ai", approved_at: null, model: "test-note-model" });
    expect(r.repo.require(r.id).status).toBe("needs_review");
    expect(r.repo.require(r.id).approved_note_id).toBeNull(); // never approved on its own
    expect(w.jobs().map((j) => [j.kind, j.status])).toEqual([["transcribe", "succeeded"], ["draft_note", "succeeded"]]);
  });

  it("keeps Gujarati, Hindi and English exactly as the speech service returned them (the original is never rewritten)", async () => {
    const w = world();
    const r = await w.recorded();
    await w.worker.tick();
    const stored = r.repo.latestTranscript(r.id)!.content;
    expect(stored.segments.map((s) => s.text)).toEqual(MIXED_TRANSCRIPT.segments.map((s) => s.text));
    expect(stored.segments[2]!.text).toContain("मुझे sugar की दवा भी चल रही है, metformin 500 mg"); // Hindi, English and a drug name in one sentence
    expect(stored.segments[1]!.text).toContain("ત્રણ દિવસથી બહુ fever છે"); // Gujarati with an English word
    expect(r.repo.latestNote(r.id)!.content.flags.map((f) => f.kind)).toContain("uncertain_transcription"); // the uncertain segment reaches the doctor
  });

  it("leaves an audit trail of the outcome that names no patient and quotes no words", async () => {
    const w = world();
    const r = await w.recorded();
    await w.worker.tick();
    const rows = audit(w.db);
    expect(rows).toEqual([expect.objectContaining({ action: "consultation.processing.complete", outcome: "success", actor_user_id: null, target_label: r.id })]);
    expect(JSON.stringify(rows)).not.toMatch(/Asha|Patel|metformin|Paracetamol|ડૉક્ટર/);
    expect(JSON.parse(rows[0]!.details)).toEqual({ segments: 6, flags: 1, dropped: 0 });
  });

  it("runs many consultations in one pass, but never more than its limit at a time", async () => {
    const w = world();
    for (let i = 0; i < 7; i++) await w.recorded({ seed: i + 1 });
    expect(await w.worker.tick()).toBe(10); // the per-pass limit
    expect(await w.worker.tick()).toBe(4); // the rest (7 + 7 jobs in all)
    expect(w.jobs().every((j) => j.status === "succeeded")).toBe(true);
  });
});

describe("when the AI service is busy or fails", () => {
  it("a busy service is retried automatically, later, and the doctor sees it as still in progress", async () => {
    const w = world();
    const r = await w.recorded();
    w.transcriber.transcribe.mockRejectedValueOnce(busy());
    expect(await w.worker.tick()).toBe(1);
    expect(w.jobs()[0]).toMatchObject({ status: "queued", attempts: 1, error_code: "provider_busy" });
    expect(r.repo.require(r.id).status).toBe("processing");
    expect(await w.worker.tick()).toBe(0); // not due yet: the wait is real
    w.advance(60_000);
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempts allowed, tells the doctor plainly, and lets them try again", async () => {
    const w = world();
    const r = await w.recorded();
    w.transcriber.transcribe.mockRejectedValue(busy());
    for (let i = 0; i < 4; i++) {
      await w.worker.tick();
      w.advance(11 * 60_000);
    }
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(4);
    expect(w.jobs()[0]).toMatchObject({ status: "failed", attempts: 4, error_code: "provider_busy" });
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "provider_busy" });
    expect(r.repo.detail(r.id, w.gate.current)).toMatchObject({ stage: "failed", failureMessage: expect.stringMatching(/busy/) });
    expect(audit(w.db)).toEqual([expect.objectContaining({ action: "consultation.processing.fail", outcome: "failed", actor_user_id: null })]);
    expect(JSON.parse(audit(w.db)[0]!.details)).toEqual({ kind: "transcribe", code: "provider_busy", attempts: 4 });
    await w.worker.tick();
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(4); // it does not keep going on its own

    w.transcriber.transcribe.mockResolvedValue(structuredClone(MIXED_TRANSCRIPT));
    r.repo.retry(r.id); // the doctor presses "Try again": a new round of work
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
    expect(w.jobs().map((j) => [j.generation, j.kind, j.status])).toEqual([[1, "transcribe", "failed"], [2, "transcribe", "succeeded"], [2, "draft_note", "succeeded"]]);
    expect(r.repo.latestTranscript(r.id)!.version).toBe(2);
  });

  it("a rejected key or an empty recording fails at once, without pointless retries and without leaking the key", async () => {
    for (const [error, code] of [
      [new ProcessingError("provider_auth", "Transcription can't run: the AI service rejected the server's credentials. Ask your administrator.", false), "provider_auth"],
      [new ProcessingError("no_speech", "No speech could be heard in this recording, so no note was prepared.", false), "no_speech"],
      [new ProcessingError("transcript_too_long", "This recording is too long for the speech service to transcribe in one go. Record shorter consultations.", false), "transcript_too_long"],
    ] as const) {
      const w = world();
      const r = await w.recorded();
      w.transcriber.transcribe.mockRejectedValue(error);
      expect(await w.worker.tick()).toBe(1);
      expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);
      expect(w.jobs()[0]).toMatchObject({ status: "failed", attempts: 1, error_code: code });
      const failed = r.repo.require(r.id);
      expect(failed).toMatchObject({ status: "failed", failure_code: code, failure_message: error.message });
      expect(failed.failure_message).not.toContain("k-test");
    }
  });

  it("an error nobody planned for is shown as a generic failure, is not retried, and its message (which could quote the patient) is never logged", async () => {
    const w = world();
    const r = await w.recorded();
    w.transcriber.transcribe.mockRejectedValue(new Error("boom while handling Asha Patel: metformin 500 mg, ડૉક્ટર સાહેબ"));
    await w.worker.tick();
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "internal_error" });
    expect(r.repo.require(r.id).failure_message).toMatch(/Something went wrong while processing/);
    expect(r.repo.require(r.id).failure_message).not.toMatch(/Asha|boom/);
    expect(consoleOutput.join("\n")).toMatch(/failed unexpectedly: Error/);
    expect(consoleOutput.join("\n")).not.toMatch(/Asha|Patel|metformin|ડૉક્ટર|boom/);
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);
  });

  it("if the AI isn't configured when the job runs, it fails clearly rather than sending anything", async () => {
    const w = world();
    const r = await w.recorded();
    w.gemini.current = { apiKey: undefined, model: undefined };
    await w.worker.tick();
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "provider_not_configured" });
  });

  it("a failed note draft is retried on its own, without transcribing the recording again", async () => {
    const w = world();
    const r = await w.recorded();
    w.noteProvider.generate.mockRejectedValueOnce(new LLMError("rate_limit", "quota"));
    expect(await w.worker.tick()).toBe(2); // transcribed, then the draft was refused
    expect(w.jobs().map((j) => [j.kind, j.status])).toEqual([["transcribe", "succeeded"], ["draft_note", "queued"]]);
    expect(r.repo.require(r.id).status).toBe("processing");
    w.advance(60_000);
    expect(await w.worker.tick()).toBe(1);
    expect(r.repo.require(r.id).status).toBe("needs_review");
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(w.noteProvider.generate).toHaveBeenCalledTimes(2);
  });

  it("a retry after only the note draft failed goes straight to drafting: the recording is not sent to the speech service a second time", async () => {
    const w = world();
    const r = await w.recorded();
    w.noteProvider.generate.mockRejectedValue(new LLMError("auth", "rejected"));
    await w.worker.tick();
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "provider_auth" });
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);

    w.noteProvider.generate.mockResolvedValue({ text: JSON.stringify(goodDraft()) });
    r.repo.retry(r.id);
    expect(w.jobs().filter((j) => j.generation === 2).map((j) => [j.kind, j.status])).toEqual([["draft_note", "queued"]]); // no new transcription job
    await w.worker.tick();
    expect(r.repo.require(r.id).status).toBe("needs_review");
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1); // the audio went out once, ever
  });

  it("that retry works even after the recording was deleted (the transcript is all it needs), but a consultation with neither can't be retried", async () => {
    const w = world();
    const r = await w.recorded();
    w.noteProvider.generate.mockRejectedValue(new LLMError("auth", "rejected"));
    await w.worker.tick();
    await r.recordings.deleteAudio(r.id);
    w.noteProvider.generate.mockResolvedValue({ text: JSON.stringify(goodDraft()) });
    r.repo.retry(r.id);
    await w.worker.tick();
    expect(r.repo.require(r.id).status).toBe("needs_review");

    const lost = await w.recorded({ seed: 9 });
    w.transcriber.transcribe.mockRejectedValue(new ProcessingError("provider_auth", "no", false));
    await w.worker.tick(); // failed before any transcript existed
    await lost.recordings.deleteAudio(lost.id);
    expect(() => lost.repo.retry(lost.id)).toThrow(expect.objectContaining({ code: "no_audio", status: 409 }));
  });

  it("an unreadable note from the AI is retried, and never saved", async () => {
    const w = world();
    const r = await w.recorded();
    w.noteProvider.generate.mockResolvedValueOnce({ text: "Sure! Here is your note:" });
    await w.worker.tick();
    expect(r.repo.latestNote(r.id)).toBeUndefined();
    expect(w.jobs().find((j) => j.kind === "draft_note")).toMatchObject({ status: "queued", error_code: "bad_note" });
    w.advance(60_000);
    await w.worker.tick();
    expect(r.repo.latestNote(r.id)!.row.version).toBe(1);
  });
});

describe("surviving crashes and repeats", () => {
  it("a job repeated after a crash doesn't do its work twice: a saved transcript is reused and a saved draft is kept", async () => {
    const w = world();
    const r = await w.recorded();
    r.repo.addTranscript(r.id, 1, "gemini", "test-transcription-model", MIXED_TRANSCRIPT); // the previous attempt got this far
    await w.worker.tick();
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM consultation_transcripts").get()).toEqual({ n: 1 });
    expect(r.repo.require(r.id).status).toBe("needs_review");

    // ...and the same for the draft: a second draft job (a repeat) finds the note already there.
    const before = w.noteProvider.generate.mock.calls.length;
    db(w).prepare("INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, generation) VALUES ('again', ?, ?, 'draft_note', 9)").run(r.org, r.id);
    await w.worker.tick();
    expect(w.noteProvider.generate.mock.calls.length).toBe(before);
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM consultation_notes").get()).toEqual({ n: 1 });
  });

  it("a worker that dies mid-job loses nothing: its lease runs out and another worker takes the job, and the dead one can no longer finish it", async () => {
    const w = world();
    const r = await w.recorded();
    const a = new ConsultationJobs(w.db, w.clock);
    const b = new ConsultationJobs(w.db, w.clock);
    const first = a.claim("A", 120_000).job!;
    expect(first).toMatchObject({ kind: "transcribe", attempts: 1 });
    expect(b.claim("B", 120_000).job).toBeUndefined(); // never handed out twice while the lease is live
    expect(a.heartbeat(first.id, "B", 120_000)).toBe(false); // someone else's lease can't be renewed
    expect(a.heartbeat(first.id, "A", 120_000)).toBe(true);

    w.advance(119_000); // still within the renewed lease
    expect(b.claim("B", 120_000).job).toBeUndefined();
    w.advance(3 * 60_000); // worker A died
    const second = b.claim("B", 120_000).job!;
    expect(second).toMatchObject({ id: first.id, attempts: 2 });
    expect(a.succeed(first.id, "A")).toBe(false); // the dead worker's late answer is ignored
    expect(a.fail(first.id, "A", { code: "x", message: "x" })).toBe(false);
    expect(b.succeed(first.id, "B")).toBe(true);
    expect(r.repo.require(r.id).status).toBe("processing");
  });

  it("two workers racing for the same job: exactly one gets it", async () => {
    const w = world();
    await w.recorded();
    const workers = Array.from({ length: 6 }, () => new ConsultationJobs(w.db, w.clock));
    const claims = workers.map((j, i) => j.claim(`W${i}`, 120_000).job).filter(Boolean);
    expect(claims).toHaveLength(1);
  });

  it("a job that keeps being abandoned stops after its attempts and the doctor is told, instead of looping for ever", async () => {
    const w = world();
    const r = await w.recorded();
    w.db.prepare("UPDATE consultation_jobs SET status = 'running', attempts = max_attempts, lease_owner = 'dead', lease_expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(await w.worker.tick()).toBe(0);
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(w.jobs()[0]).toMatchObject({ status: "failed", error_code: "worker_lost" });
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "worker_lost" });
  });

  it("deleting the recording while it is being transcribed saves nothing", async () => {
    const w = world();
    const r = await w.recorded();
    w.transcriber.transcribe.mockImplementation(async () => {
      await r.recordings.deleteAudio(r.id); // the doctor deletes it while the speech service is working
      return structuredClone(MIXED_TRANSCRIPT);
    });
    await w.worker.tick();
    expect(db(w).prepare("SELECT COUNT(*) AS n FROM consultation_transcripts").get()).toEqual({ n: 0 });
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "audio_deleted" });
    expect(w.jobs().map((j) => j.status)).toEqual(["cancelled"]); // and no draft was queued
    expect(w.noteProvider.generate).not.toHaveBeenCalled();
  });

  it("a consultation deleted while its job was waiting simply has no job any more", async () => {
    const w = world();
    const r = await w.recorded();
    r.repo.delete(r.id);
    expect(await w.worker.tick()).toBe(0);
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(w.jobs()).toEqual([]);
  });

  it("damaged audio is reported as damaged and never sent to the speech service", async () => {
    const w = world();
    const r = await w.recorded();
    const key = r.repo.recordingOf(r.id)!.storage_key;
    const file = path.join(dir, partKey(key, 1));
    const sealed = fs.readFileSync(file);
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    fs.writeFileSync(file, sealed);
    await w.worker.tick();
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(r.repo.require(r.id)).toMatchObject({ status: "failed", failure_code: "audio_damaged" });
  });
});

describe("two customers' work never mixes", () => {
  it("each recording goes to the speech service as itself and each result is filed under its own doctor and workspace", async () => {
    const w = world();
    const a = await w.recorded({ seed: 11, email: "a@clinic-a.test" });
    const b = await w.recorded({ seed: 22, email: "b@clinic-b.test" });
    w.transcriber.transcribe.mockImplementation(async (req) => ({
      ...structuredClone(MIXED_TRANSCRIPT),
      segments: [{ speaker: "doctor", text: `fingerprint ${sha256(req.audio).slice(0, 12)}`, language: "en", uncertain: false }],
    }));
    w.noteProvider.generate.mockImplementation(async () => ({ text: JSON.stringify({ sections: [], flags: [] }) }));
    expect(await w.worker.tick()).toBe(4);

    const text = (r: typeof a) => r.repo.latestTranscript(r.id)!.content.segments[0]!.text;
    expect(text(a)).toBe(`fingerprint ${sha256(a.bytes).slice(0, 12)}`);
    expect(text(b)).toBe(`fingerprint ${sha256(b.bytes).slice(0, 12)}`);
    expect(w.db.prepare("SELECT org_id, consultation_id FROM consultation_transcripts ORDER BY org_id").all()).toEqual(
      [{ org_id: a.org, consultation_id: a.id }, { org_id: b.org, consultation_id: b.id }].sort((x, y) => x.org_id.localeCompare(y.org_id)),
    );
    expect(() => b.repo.latestTranscript(a.id)).toThrow(expect.objectContaining({ status: 404 })); // B still can't see A's
    expect(() => a.repo.latestNote(b.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("a job can't be filed under a different customer than its consultation (the database refuses)", async () => {
    const w = world();
    const a = await w.recorded();
    const other = seedOrganization(w.db, "Someone else");
    expect(() => w.db.prepare("INSERT INTO consultation_jobs (id, org_id, consultation_id, kind, generation) VALUES ('forged', ?, ?, 'draft_note', 5)").run(other, a.id)).toThrow(/same organization/);
    expect(() => w.db.prepare("UPDATE consultation_jobs SET org_id = ? ").run(other)).toThrow(/cannot be pointed|FOREIGN|same/i);
  });

  it("the doctor's chosen language reaches the speech service for each consultation separately", async () => {
    const w = world();
    await w.recorded({ hint: "hi", seed: 1 });
    await w.recorded({ hint: "gu", seed: 2 });
    await w.recorded({ hint: "auto", seed: 3 });
    await w.worker.tick();
    expect(w.transcriber.transcribe.mock.calls.map((c) => c[0].languageHint).sort()).toEqual(["auto", "gu", "hi"]);
  });
});

describe("work that may no longer be done is parked, not run", () => {
  /** Changes who the doctor is to the system, directly in the database, the way an administrator's action would. */
  const change = {
    suspendWorkspace: (w: ReturnType<typeof world>, org: string) => w.db.prepare("UPDATE organizations SET status = 'suspended' WHERE id = ?").run(org),
    reactivateWorkspace: (w: ReturnType<typeof world>, org: string) => w.db.prepare("UPDATE organizations SET status = 'active' WHERE id = ?").run(org),
    disableDoctor: (w: ReturnType<typeof world>, user: string) => w.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user),
    enableDoctor: (w: ReturnType<typeof world>, user: string) => w.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user),
    setRole: (w: ReturnType<typeof world>, org: string, user: string, role: string) => w.db.prepare("UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?").run(role, org, user),
    remove: (w: ReturnType<typeof world>, org: string, user: string) => w.db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(org, user),
  };

  it("switching Doctor Consultations off stops everything: nothing is processed or sent while it is off, and the work resumes when it is back on", async () => {
    const w = world();
    const r = await w.recorded();
    w.feature.current = false;
    for (let i = 0; i < 3; i++) expect(await w.worker.tick()).toBe(0);
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(w.jobs()).toEqual([{ kind: "transcribe", generation: 1, status: "queued", attempts: 0, error_code: null }]);
    expect(consoleOutput.filter((l) => /feature is switched off/.test(l))).toHaveLength(1);
    w.feature.current = true;
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
  });

  it.each([
    ["the workspace is suspended", (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.suspendWorkspace(w, r.org), (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.reactivateWorkspace(w, r.org)],
    ["the doctor's account is disabled", (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.disableDoctor(w, r.doctor.userId), (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.enableDoctor(w, r.doctor.userId)],
    ["the doctor is moved to another role", (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.setRole(w, r.org, r.doctor.userId, "member"), (w: ReturnType<typeof world>, r: { org: string; doctor: { userId: string } }) => change.setRole(w, r.org, r.doctor.userId, "doctor")],
  ])("when %s, queued work is neither run nor sent to the AI service, and nothing is lost: it runs once that is put right", async (_what, breakIt, fixIt) => {
    const w = world();
    const r = await w.recorded();
    breakIt(w, r);
    for (let i = 0; i < 3; i++) expect(await w.worker.tick()).toBe(0);
    expect(w.transcriber.transcribe).not.toHaveBeenCalled();
    expect(w.noteProvider.generate).not.toHaveBeenCalled();
    expect(w.jobs()).toEqual([{ kind: "transcribe", generation: 1, status: "queued", attempts: 0, error_code: null }]); // untouched: no attempt was used up
    expect(r.repo.require(r.id).status).toBe("processing"); // and not failed
    fixIt(w, r);
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
  });

  it("a doctor who was removed from the workspace has their queued work parked, while a colleague's carries on", async () => {
    const w = world();
    const org = seedOrganization(w.db, "Shared clinic");
    const gone = await w.recorded({ org, email: "gone@clinic.test", seed: 1 });
    const stays = await w.recorded({ org, email: "stays@clinic.test", seed: 2 });
    change.remove(w, org, gone.doctor.userId);
    expect(await w.worker.tick()).toBe(2); // only the colleague's two jobs
    expect(w.transcriber.transcribe).toHaveBeenCalledTimes(1);
    expect(stays.repo.require(stays.id).status).toBe("needs_review");
    expect(gone.repo.require(gone.id).status).toBe("processing");
  });

  it("work that was already running when the doctor was removed isn't taken up again after its lease expires", async () => {
    const w = world();
    const r = await w.recorded();
    const queue = new ConsultationJobs(w.db, w.clock);
    expect(queue.claim("W", 120_000).job).toBeDefined(); // a worker takes it...
    change.remove(w, r.org, r.doctor.userId); // ...the doctor is removed, then the worker dies
    w.advance(5 * 60_000);
    expect(queue.claim("W2", 120_000).job).toBeUndefined();
  });
});

describe("a worker that is slow or no longer holds the job", () => {
  it("a call to the AI service that never answers is stopped at the deadline and retried, so it can't hold every other doctor's work", async () => {
    const w = world({}, { deadlineMs: 60 });
    const r = await w.recorded();
    w.transcriber.transcribe.mockImplementation((request) => new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await w.worker.tick()).toBe(1);
    expect(w.jobs()[0]).toMatchObject({ status: "queued", attempts: 1, error_code: "provider_timeout" });
    expect(r.repo.require(r.id).status).toBe("processing");
    w.transcriber.transcribe.mockImplementation(async () => structuredClone(MIXED_TRANSCRIPT));
    w.advance(60_000);
    expect(await w.worker.tick()).toBe(2);
    expect(r.repo.require(r.id).status).toBe("needs_review");
  });

  it("a worker that lost the job (it was taken over) doesn't tell the doctor it failed", async () => {
    const w = world();
    const r = await w.recorded();
    w.transcriber.transcribe.mockImplementation(async () => {
      w.db.prepare("UPDATE consultation_jobs SET lease_owner = 'another-worker'").run(); // someone else holds it now
      throw new ProcessingError("provider_auth", "Transcription can't run: the AI service rejected the server's credentials. Ask your administrator.", false);
    });
    await w.worker.tick();
    expect(r.repo.require(r.id).status).toBe("processing"); // not marked failed by a worker that no longer owned the job
    expect(audit(w.db)).toEqual([]);
  });

  it("an AI draft is only ever added while a consultation is waiting for one: not on top of a note under review or approved", async () => {
    const w = world();
    const r = await w.recorded();
    await w.worker.tick();
    expect(r.repo.require(r.id).status).toBe("needs_review");
    const transcriptId = r.repo.latestTranscript(r.id)!.id;
    expect(() => r.repo.addAiDraft(r.id, transcriptId, { sections: [], flags: [] }, "gemini", "m")).toThrow(expect.objectContaining({ code: "not_processing", status: 409 }));
    expect(r.repo.noteVersions(r.id)).toHaveLength(1);
  });
});

describe("housekeeping", () => {
  it("clears an upload that was started and never finished, so pieces of a recording never linger", async () => {
    const w = world();
    const org = seedOrganization(w.db, "Clinic");
    const doctor = seedMember(w.db, org, "d@clinic.test", "doctor");
    const repo = new ConsultationRepository(w.db, org, doctor.userId, () => vault);
    const recordings = new RecordingService(repo, w.store, () => vault, org, { maxBytes: 50e6, maxMinutes: 60 });
    const id = repo.create({ patientLabel: "X", languageHint: "auto", consent: { textVersion: CONSENT_VERSION, textSha256: "h", language: "en", givenBy: "patient", method: "verbal" } });
    recordings.start(id, "audio/webm");
    await recordings.putPart(id, 1, audioBytes(3000));
    expect(fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).includes("part-"))).toHaveLength(1);

    w.advance(60 * 60_000); // an hour: still plausibly in progress
    await w.worker.tick();
    expect(repo.require(id).status).toBe("uploading");
    w.advance(24 * 60 * 60_000); // a day and an hour: abandoned
    await w.worker.tick();
    expect(repo.require(id).status).toBe("ready");
    expect(repo.recordingOf(id)).toBeUndefined();
    expect(fs.readdirSync(dir, { recursive: true }).filter((f) => String(f).includes("part-"))).toEqual([]);
  });

  it("waits longer between each retry, up to a limit, with a little spread so retries don't all arrive together", () => {
    const steady = (attempts: number) => backoffMs(attempts, () => 0.5);
    expect([1, 2, 3, 4].map(steady)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(steady(20)).toBe(10 * 60_000);
    expect(backoffMs(1, () => 0)).toBe(12_000);
    expect(backoffMs(1, () => 1)).toBe(18_000);
  });
});

/** The database of a world, for the odd direct check. */
const db = (w: ReturnType<typeof world>) => w.db;
