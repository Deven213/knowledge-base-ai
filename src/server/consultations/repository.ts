import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type ConsultationDetailDTO,
  type ConsultationStatus,
  type ConsultationSummaryDTO,
  type JobStage,
  type LanguageHint,
  type NoteContent,
  type NoteVersionDTO,
  type TranscriptContent,
} from "@/lib/consultations";
import type { ConsentGivenBy, ConsentLanguage, ConsentMethod } from "@/lib/consultation-consent";
import type { Vault } from "../security/vault";
import { sealContext } from "./aad";
import { ConsultationError, notFound } from "./errors";
import { DOCTOR_WAITING_MESSAGE, type Gate } from "./gate";

// Everything about ONE doctor's consultations inside ONE organization. Both come from the signed-in session when the object is
// built (services.ts), never from a request, and every statement below filters on them, so there is no way to name another
// doctor's or another customer's consultation: it simply is not found. Patient labels, transcripts and notes are sealed before
// they are written and opened on the way out (security/vault.ts), bound to this organization and consultation.
//
// The worker (worker.ts) builds the same object for the doctor and organization a queued job belongs to.

export const JOB_MAX_ATTEMPTS = 4;

interface ConsultationRow {
  id: string;
  doctor_user_id: string;
  patient_label: Buffer;
  language_hint: LanguageHint;
  status: ConsultationStatus;
  failure_code: string | null;
  failure_message: string | null;
  approved_note_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecordingRow {
  id: string;
  consultation_id: string;
  status: "uploading" | "stored" | "deleted";
  mime_type: string;
  storage_key: string;
  part_size: number;
  size_bytes: number | null;
  part_count: number | null;
  duration_ms: number | null;
  sha256: string | null;
  created_at: string;
  stored_at: string | null;
}

export interface PartRow {
  part_number: number;
  size_bytes: number;
  sha256: string;
}

export interface NoteRow {
  id: string;
  version: number;
  transcript_id: string;
  source: "ai" | "doctor";
  provider: string | null;
  model: string | null;
  created_at: string;
  approved_at: string | null;
  approved_by_user_id: string | null;
}

export interface NewConsultation {
  patientLabel: string;
  languageHint: LanguageHint;
  consent: { textVersion: string; textSha256: string; language: ConsentLanguage; givenBy: ConsentGivenBy; method: ConsentMethod };
}

const now = () => new Date().toISOString();

export class ConsultationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
    private readonly doctorId: string,
    private readonly vault: () => Vault,
  ) {}

  // ── Consultations ──────────────────────────────────────────────────────────

  /** Creates the consultation AND its consent record in one step: there is no consultation without consent. */
  create(input: NewConsultation): string {
    const id = randomUUID();
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO consultations (id, org_id, doctor_user_id, patient_label, language_hint) VALUES (?, ?, ?, ?, ?)`)
        .run(id, this.orgId, this.doctorId, this.vault().sealText(input.patientLabel, sealContext.patient(this.orgId, id)), input.languageHint);
      this.db
        .prepare(
          `INSERT INTO consultation_consents (id, org_id, consultation_id, text_version, text_sha256, language, given_by, method, recorded_by_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), this.orgId, id, input.consent.textVersion, input.consent.textSha256, input.consent.language, input.consent.givenBy, input.consent.method, this.doctorId);
    })();
    return id;
  }

  private row(id: string): ConsultationRow | undefined {
    return this.db
      .prepare(
        `SELECT id, doctor_user_id, patient_label, language_hint, status, failure_code, failure_message, approved_note_id, created_at, updated_at
           FROM consultations WHERE org_id = ? AND doctor_user_id = ? AND id = ?`,
      )
      .get(this.orgId, this.doctorId, id) as ConsultationRow | undefined;
  }

  /** The caller's consultation, or a "not found" refusal (the same answer whether it doesn't exist or belongs to someone else). */
  require(id: string): ConsultationRow {
    const row = this.row(id);
    if (!row) throw notFound();
    return row;
  }

  exists(id: string): boolean {
    return this.row(id) !== undefined;
  }

  /** Whether consent is on record. Creating a consultation always records it, so this only guards against a row that was tampered with. */
  hasConsent(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM consultation_consents WHERE org_id = ? AND consultation_id = ?`).get(this.orgId, id);
  }

  private summary(row: ConsultationRow, recording: RecordingRow | undefined, approvedAt: string | null): ConsultationSummaryDTO {
    return {
      id: row.id,
      patientLabel: this.vault().openText(row.patient_label, sealContext.patient(this.orgId, row.id)),
      languageHint: row.language_hint,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      recording: recording ? { status: recording.status, durationMs: recording.duration_ms, sizeBytes: recording.size_bytes } : null,
      approvedAt,
    };
  }

  private approvedAt(consultationId: string): string | null {
    const row = this.db
      .prepare(`SELECT approved_at FROM consultation_notes WHERE org_id = ? AND consultation_id = ? AND approved_at IS NOT NULL ORDER BY version DESC LIMIT 1`)
      .get(this.orgId, consultationId) as { approved_at: string } | undefined;
    return row?.approved_at ?? null;
  }

  list(limit = 200): ConsultationSummaryDTO[] {
    const rows = this.db
      .prepare(
        `SELECT id, doctor_user_id, patient_label, language_hint, status, failure_code, failure_message, approved_note_id, created_at, updated_at
           FROM consultations WHERE org_id = ? AND doctor_user_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(this.orgId, this.doctorId, limit) as ConsultationRow[];
    return rows.map((r) => this.summary(r, this.recording(r.id), this.approvedAt(r.id)));
  }

  detail(id: string, gate: Gate): ConsultationDetailDTO | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    const recording = this.recording(id);
    const consent = this.db
      .prepare(`SELECT recorded_at, given_by, method, language, text_version FROM consultation_consents WHERE org_id = ? AND consultation_id = ?`)
      .get(this.orgId, id) as { recorded_at: string; given_by: ConsentGivenBy; method: ConsentMethod; language: ConsentLanguage; text_version: string };
    const stage = this.stage(row, gate);
    const latest = this.latestNoteRow(id);
    return {
      ...this.summary(row, recording, this.approvedAt(id)),
      consent: { recordedAt: consent.recorded_at, givenBy: consent.given_by, method: consent.method, language: consent.language, textVersion: consent.text_version },
      failureMessage: row.status === "failed" ? row.failure_message : null,
      stage,
      waitingReason: stage === "waiting" ? DOCTOR_WAITING_MESSAGE : null,
      receivedParts: recording?.status === "uploading" ? this.parts(recording.id).map((p) => p.part_number) : [],
      noteVersion: latest?.version ?? null,
      hasTranscript: this.latestTranscriptRow(id) !== undefined,
    };
  }

  /** What the background worker is doing for this consultation, as the doctor sees it. */
  private stage(row: ConsultationRow, gate: Gate): JobStage {
    if (row.status === "needs_review" || row.status === "approved") return "done";
    if (row.status === "failed") return "failed";
    if (row.status !== "processing") return "waiting";
    const job = this.latestJob(row.id);
    if (!job) return "waiting";
    if (job.status === "failed") return "failed";
    // A queued job that nothing may pick up yet (the privacy gate is closed) is waiting, not working.
    if (job.status === "queued" && !gate.open) return "waiting";
    return job.kind === "transcribe" ? "transcribing" : "drafting";
  }

  setStatus(id: string, status: ConsultationStatus, failure?: { code: string; message: string }): void {
    this.require(id);
    this.db
      .prepare(`UPDATE consultations SET status = ?, failure_code = ?, failure_message = ?, updated_at = ? WHERE org_id = ? AND doctor_user_id = ? AND id = ?`)
      .run(status, failure?.code ?? null, failure?.message ?? null, now(), this.orgId, this.doctorId, id);
  }

  /** Deletes the consultation and, through the cascades, its consent, recording record, transcript, notes and jobs. Returns what must be removed from the audio store. */
  delete(id: string): { storageKey: string | null } | undefined {
    if (!this.row(id)) return undefined;
    const recording = this.recording(id);
    this.db.prepare(`DELETE FROM consultations WHERE org_id = ? AND doctor_user_id = ? AND id = ?`).run(this.orgId, this.doctorId, id);
    return { storageKey: recording && recording.status !== "deleted" ? recording.storage_key : null };
  }

  // ── Recording ──────────────────────────────────────────────────────────────

  recording(consultationId: string): RecordingRow | undefined {
    return this.db
      .prepare(
        `SELECT id, consultation_id, status, mime_type, storage_key, part_size, size_bytes, part_count, duration_ms, sha256, created_at, stored_at
           FROM consultation_recordings WHERE org_id = ? AND consultation_id = ?`,
      )
      .get(this.orgId, consultationId) as RecordingRow | undefined;
  }

  /** The caller's recording, found through a consultation of theirs. */
  recordingOf(consultationId: string): RecordingRow | undefined {
    this.require(consultationId);
    return this.recording(consultationId);
  }

  startRecording(consultationId: string, input: { mimeType: string; partSize: number; storageKey: string }): RecordingRow {
    this.db.transaction(() => {
      this.require(consultationId);
      this.db
        .prepare(`INSERT INTO consultation_recordings (id, org_id, consultation_id, status, mime_type, storage_key, part_size) VALUES (?, ?, ?, 'uploading', ?, ?, ?)`)
        .run(randomUUID(), this.orgId, consultationId, input.mimeType, input.storageKey, input.partSize);
      this.setStatus(consultationId, "uploading");
    })();
    return this.recording(consultationId)!;
  }

  parts(recordingId: string): PartRow[] {
    return this.db
      .prepare(`SELECT part_number, size_bytes, sha256 FROM consultation_upload_parts WHERE org_id = ? AND recording_id = ? ORDER BY part_number`)
      .all(this.orgId, recordingId) as PartRow[];
  }

  savePart(recordingId: string, part: PartRow): void {
    this.db
      .prepare(
        `INSERT INTO consultation_upload_parts (recording_id, org_id, part_number, size_bytes, sha256) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(recording_id, part_number) DO UPDATE SET size_bytes = excluded.size_bytes, sha256 = excluded.sha256`,
      )
      .run(recordingId, this.orgId, part.part_number, part.size_bytes, part.sha256);
  }

  /** Forgets upload parts the recording does not have (left over from an abandoned earlier attempt). */
  removeParts(recordingId: string, numbers: number[]): void {
    const remove = this.db.prepare(`DELETE FROM consultation_upload_parts WHERE org_id = ? AND recording_id = ? AND part_number = ?`);
    this.db.transaction(() => numbers.forEach((n) => remove.run(this.orgId, recordingId, n)))();
  }

  /** All the audio this WORKSPACE holds, in bytes: stored recordings plus the parts of uploads still in progress. */
  storedAudioBytes(): number {
    const stored = this.db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS n FROM consultation_recordings WHERE org_id = ? AND status = 'stored'`).get(this.orgId) as { n: number };
    // Parts only count while their upload is unfinished: once a recording is stored, its size is already in the first figure.
    const parts = this.db
      .prepare(`SELECT COALESCE(SUM(p.size_bytes), 0) AS n FROM consultation_upload_parts p JOIN consultation_recordings r ON r.id = p.recording_id WHERE p.org_id = ? AND r.org_id = ? AND r.status = 'uploading'`)
      .get(this.orgId, this.orgId) as { n: number };
    return stored.n + parts.n;
  }

  /** The recording is complete and checked: keep it, move the consultation to "processing" and queue the first job, as one step. */
  finishRecording(consultationId: string, recordingId: string, info: { sizeBytes: number; partCount: number; durationMs: number; sha256: string }): void {
    this.db.transaction(() => {
      this.require(consultationId);
      const stored = this.db
        .prepare(
          `UPDATE consultation_recordings SET status = 'stored', size_bytes = ?, part_count = ?, duration_ms = ?, sha256 = ?, stored_at = ?
            WHERE org_id = ? AND consultation_id = ? AND id = ? AND status = 'uploading'`,
        )
        .run(info.sizeBytes, info.partCount, info.durationMs, info.sha256, now(), this.orgId, consultationId, recordingId);
      if (stored.changes !== 1) throw new ConsultationError(409, "not_uploading", "This recording is not being uploaded any more.");
      this.setStatus(consultationId, "processing");
      this.enqueue(consultationId, "transcribe", 1);
    })();
  }

  /** Throws away an unfinished upload (nothing was ever stored as a complete recording) and lets the doctor start again. */
  discardUnfinishedRecording(consultationId: string): string | undefined {
    return this.db.transaction(() => {
      this.require(consultationId);
      const recording = this.recording(consultationId);
      if (!recording || recording.status !== "uploading") return undefined;
      this.db.prepare(`DELETE FROM consultation_recordings WHERE org_id = ? AND consultation_id = ? AND id = ?`).run(this.orgId, consultationId, recording.id);
      this.setStatus(consultationId, "ready");
      return recording.storage_key;
    })();
  }

  /** The audio has been deleted from the store: record that, and forget the parts. The recording row stays as the record that it existed. */
  markAudioDeleted(consultationId: string): void {
    this.db.transaction(() => {
      const consultation = this.require(consultationId);
      const recording = this.recording(consultationId);
      if (!recording) return;
      this.db.prepare(`DELETE FROM consultation_upload_parts WHERE org_id = ? AND recording_id = ?`).run(this.orgId, recording.id);
      this.db
        .prepare(`UPDATE consultation_recordings SET status = 'deleted', deleted_at = ? WHERE org_id = ? AND consultation_id = ? AND id = ?`)
        .run(now(), this.orgId, consultationId, recording.id);
      // Work that was still waiting for this audio can never run: stop it, and tell the doctor why nothing will arrive.
      this.cancelOpenJobs(consultationId);
      if (consultation.status === "processing") {
        this.setStatus(consultationId, "failed", { code: "audio_deleted", message: "The recording was deleted before it was processed, so no note could be prepared." });
      }
    })();
  }

  /** Stops queued or running work for this consultation (a running job notices before it saves anything). */
  cancelOpenJobs(consultationId: string): void {
    this.db
      .prepare(
        `UPDATE consultation_jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
          WHERE org_id = ? AND consultation_id = ? AND status IN ('queued','running')`,
      )
      .run(now(), now(), this.orgId, consultationId);
  }

  // ── Jobs (what this doctor's consultation has queued) ──────────────────────

  enqueue(consultationId: string, kind: "transcribe" | "draft_note", generation: number): void {
    this.require(consultationId);
    // run_after is stamped here, with the same kind of clock the worker compares it with. (SQLite's own "now" can round up to the next
    // millisecond while JavaScript's truncates, so a job queued and claimed within the same millisecond could look "not due yet".)
    this.db
      .prepare(`INSERT OR IGNORE INTO consultation_jobs (id, org_id, consultation_id, kind, generation, max_attempts, run_after) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), this.orgId, consultationId, kind, generation, JOB_MAX_ATTEMPTS, now());
  }

  latestJob(consultationId: string): { kind: "transcribe" | "draft_note"; generation: number; status: string; error_code: string | null; error_message: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT kind, generation, status, error_code, error_message FROM consultation_jobs
          WHERE org_id = ? AND consultation_id = ? ORDER BY generation DESC, CASE kind WHEN 'draft_note' THEN 1 ELSE 0 END DESC LIMIT 1`,
      )
      .get(this.orgId, consultationId) as ReturnType<ConsultationRepository["latestJob"]>;
  }

  /** The doctor asked to try again after a failure: a new generation of work (the old attempts stay as history). */
  retry(consultationId: string): void {
    this.db.transaction(() => {
      const row = this.require(consultationId);
      if (row.status !== "failed") throw new ConsultationError(409, "not_failed", "Only a consultation whose processing failed can be retried.");
      // Start from what is missing. If the transcript already exists and only the drafting failed, the audio is NOT sent to the speech service again.
      const hasTranscript = this.latestTranscriptRow(consultationId) !== undefined;
      const recording = this.recording(consultationId);
      if (!hasTranscript && (!recording || recording.status !== "stored")) throw new ConsultationError(409, "no_audio", "The recording is no longer stored, so it can't be processed again.");
      const last = this.db
        .prepare(`SELECT MAX(generation) AS g FROM consultation_jobs WHERE org_id = ? AND consultation_id = ?`)
        .get(this.orgId, consultationId) as { g: number | null };
      this.setStatus(consultationId, "processing");
      this.enqueue(consultationId, hasTranscript ? "draft_note" : "transcribe", (last.g ?? 0) + 1);
    })();
  }

  // ── Transcript (kept exactly as received; never edited) ────────────────────

  addTranscript(consultationId: string, version: number, provider: string, model: string, content: TranscriptContent): string {
    this.require(consultationId);
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO consultation_transcripts (id, org_id, consultation_id, version, provider, model, content) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, this.orgId, consultationId, version, provider, model, this.vault().sealJson(content, sealContext.transcript(this.orgId, consultationId, version)));
    return id;
  }

  private latestTranscriptRow(consultationId: string) {
    return this.db
      .prepare(`SELECT id, version, provider, model, content, created_at FROM consultation_transcripts WHERE org_id = ? AND consultation_id = ? ORDER BY version DESC LIMIT 1`)
      .get(this.orgId, consultationId) as { id: string; version: number; provider: string; model: string; content: Buffer; created_at: string } | undefined;
  }

  latestTranscript(consultationId: string) {
    this.require(consultationId);
    const row = this.latestTranscriptRow(consultationId);
    if (!row) return undefined;
    return {
      id: row.id,
      version: row.version,
      provider: row.provider,
      model: row.model,
      createdAt: row.created_at,
      content: this.vault().openJson<TranscriptContent>(row.content, sealContext.transcript(this.orgId, consultationId, row.version)),
    };
  }

  // ── Notes (every edit is a new version; an approved version is final) ──────

  private latestNoteRow(consultationId: string): NoteRow | undefined {
    return this.db
      .prepare(
        `SELECT id, version, transcript_id, source, provider, model, created_at, approved_at, approved_by_user_id
           FROM consultation_notes WHERE org_id = ? AND consultation_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(this.orgId, consultationId) as NoteRow | undefined;
  }

  private openNote(consultationId: string, row: NoteRow): NoteContent {
    const sealed = this.db
      .prepare(`SELECT content FROM consultation_notes WHERE org_id = ? AND consultation_id = ? AND id = ?`)
      .get(this.orgId, consultationId, row.id) as { content: Buffer };
    return this.vault().openJson<NoteContent>(sealed.content, sealContext.note(this.orgId, consultationId, row.version));
  }

  /** The newest note version with its content and the list of every version, or undefined before a draft exists. */
  latestNote(consultationId: string): { row: NoteRow; content: NoteContent; versions: NoteVersionDTO[] } | undefined {
    this.require(consultationId);
    const row = this.latestNoteRow(consultationId);
    if (!row) return undefined;
    return { row, content: this.openNote(consultationId, row), versions: this.noteVersions(consultationId) };
  }

  noteVersions(consultationId: string): NoteVersionDTO[] {
    const rows = this.db
      .prepare(`SELECT version, source, created_at, approved_at FROM consultation_notes WHERE org_id = ? AND consultation_id = ? ORDER BY version DESC`)
      .all(this.orgId, consultationId) as { version: number; source: "ai" | "doctor"; created_at: string; approved_at: string | null }[];
    return rows.map((r) => ({ version: r.version, source: r.source, createdAt: r.created_at, approvedAt: r.approved_at }));
  }

  /** Whether the AI has already drafted a note from this transcript (so a repeated job doesn't draft twice). */
  hasAiNoteFor(consultationId: string, transcriptId: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM consultation_notes WHERE org_id = ? AND consultation_id = ? AND transcript_id = ? AND source = 'ai' LIMIT 1`)
      .get(this.orgId, consultationId, transcriptId);
  }

  /** The AI's draft, saved as the next version, and the consultation handed to the doctor for review. */
  addAiDraft(consultationId: string, transcriptId: string, content: NoteContent, provider: string, model: string): void {
    this.db.transaction(() => {
      // A draft is only ever added while the consultation is waiting for one. A late or repeated writer (a job that lost its lease) must not
      // put a new version on top of a note the doctor is reviewing or has approved.
      if (this.require(consultationId).status !== "processing") throw new ConsultationError(409, "not_processing", "This consultation is not waiting for a draft.");
      const version = (this.latestNoteRow(consultationId)?.version ?? 0) + 1;
      this.db
        .prepare(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, provider, model) VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?)`)
        .run(randomUUID(), this.orgId, consultationId, version, transcriptId, this.vault().sealJson(content, sealContext.note(this.orgId, consultationId, version)), provider, model);
      this.setStatus(consultationId, "needs_review");
    })();
  }

  /** The doctor's edit, saved as a new version. `baseVersion` must be the newest one, so two windows can't silently overwrite each other. */
  addDoctorVersion(consultationId: string, baseVersion: number, content: NoteContent): number {
    return this.db.transaction(() => {
      this.require(consultationId);
      const latest = this.latestNoteRow(consultationId);
      if (!latest) throw new ConsultationError(409, "no_draft", "There is no draft note to edit yet.");
      if (latest.approved_at) throw new ConsultationError(409, "note_approved", "This note is approved. Reopen it to make changes.");
      if (latest.version !== baseVersion) throw new ConsultationError(409, "stale_note", "The note was changed somewhere else. Reload it to see the latest version.");
      const version = latest.version + 1;
      this.db
        .prepare(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'doctor', ?, ?)`)
        .run(randomUUID(), this.orgId, consultationId, version, latest.transcript_id, this.vault().sealJson(content, sealContext.note(this.orgId, consultationId, version)), this.doctorId);
      this.db.prepare(`UPDATE consultations SET updated_at = ? WHERE org_id = ? AND doctor_user_id = ? AND id = ?`).run(now(), this.orgId, this.doctorId, consultationId);
      return version;
    })();
  }

  /** Approves one version, once. Only the newest version can be approved, and an approved version is final. */
  approve(consultationId: string, version: number): void {
    this.db.transaction(() => {
      const row = this.require(consultationId);
      const latest = this.latestNoteRow(consultationId);
      if (!latest) throw new ConsultationError(409, "no_draft", "There is no draft note to approve yet.");
      if (latest.version !== version) throw new ConsultationError(409, "stale_note", "The note was changed somewhere else. Reload it before approving.");
      if (latest.approved_at) throw new ConsultationError(409, "already_approved", "This note is already approved.");
      if (row.status !== "needs_review") throw new ConsultationError(409, "not_reviewable", "This consultation is not waiting for review.");
      const stamp = now();
      this.db
        .prepare(`UPDATE consultation_notes SET approved_by_user_id = ?, approved_at = ? WHERE org_id = ? AND consultation_id = ? AND id = ? AND approved_at IS NULL`)
        .run(this.doctorId, stamp, this.orgId, consultationId, latest.id);
      this.db
        .prepare(`UPDATE consultations SET status = 'approved', approved_note_id = ?, updated_at = ? WHERE org_id = ? AND doctor_user_id = ? AND id = ?`)
        .run(latest.id, stamp, this.orgId, this.doctorId, consultationId);
    })();
  }

  /** Opens an approved note for changes: the approved version stays exactly as approved, and a new editable version starts as its copy. */
  reopen(consultationId: string): number {
    return this.db.transaction(() => {
      const row = this.require(consultationId);
      const latest = this.latestNoteRow(consultationId);
      if (row.status !== "approved" || !latest?.approved_at) throw new ConsultationError(409, "not_approved", "Only an approved note can be reopened.");
      const version = latest.version + 1;
      const content = this.openNote(consultationId, latest);
      this.db
        .prepare(`INSERT INTO consultation_notes (id, org_id, consultation_id, version, transcript_id, source, content, created_by_user_id) VALUES (?, ?, ?, ?, ?, 'doctor', ?, ?)`)
        .run(randomUUID(), this.orgId, consultationId, version, latest.transcript_id, this.vault().sealJson(content, sealContext.note(this.orgId, consultationId, version)), this.doctorId);
      this.setStatus(consultationId, "needs_review");
      return version;
    })();
  }
}

