import "server-only";
import type Database from "better-sqlite3";
import { AuditLog } from "../audit/audit";
import type { AppConfig } from "../config";
import type { LLMProvider } from "../llm/types";
import type { Vault } from "../security/vault";
import type { AudioStore } from "./audio-store";
import { ConsultationError } from "./errors";
import type { ClaimedJob } from "./jobs";
import { draftNote } from "./note-ai";
import { ProcessingError } from "./processing-error";
import { RecordingService } from "./recording";
import { ConsultationRepository } from "./repository";
import type { TranscriptionProvider } from "./transcription/types";

// The two kinds of background work. Each is built to be run again safely: a job that is repeated after a crash (or a retry) finds its
// result already saved and stops, and each step checks the job hasn't been cancelled (the doctor deleted the audio) before it saves.
//
//   transcribe  - open the stored recording, send it to the speech service, save the transcript, queue the note draft;
//   draft_note  - send the TRANSCRIPT (never the audio) to the note drafter, check the draft against the transcript, save it as version 1,
//                 and hand the consultation to the doctor for review.
//
// Both run as the doctor and organization the job belongs to, through the same scoped repository the web routes use.

export interface ProcessorDeps {
  db: Database.Database;
  config: AppConfig;
  transcriber: TranscriptionProvider;
  /** The provider layer used for notes (text only). */
  noteProvider: LLMProvider;
  store: AudioStore;
  vault: () => Vault;
  /** The Gemini key and the model that drafts notes, read at the moment of use. */
  gemini: () => { apiKey: string | undefined; model: string | undefined };
  isCancelled: (jobId: string) => boolean;
  doctorOf: (orgId: string, consultationId: string) => string | undefined;
}

export class ConsultationProcessor {
  constructor(private readonly deps: ProcessorDeps) {}

  /** The scoped repository for the job's own organization and doctor, or undefined if the consultation no longer exists. */
  scopedFor(orgId: string, consultationId: string): { repo: ConsultationRepository; recordings: RecordingService; doctorId: string } | undefined {
    const { db, config, store, vault } = this.deps;
    const doctorId = this.deps.doctorOf(orgId, consultationId);
    if (!doctorId) return undefined;
    const repo = new ConsultationRepository(db, orgId, doctorId, vault);
    const recordings = new RecordingService(repo, store, vault, orgId, { maxBytes: Math.floor(config.CONSULTATIONS_MAX_AUDIO_MB * 1024 * 1024), maxMinutes: config.CONSULTATIONS_MAX_MINUTES, quotaBytes: Math.floor(config.CONSULTATIONS_MAX_STORAGE_GB * 1024 * 1024 * 1024) });
    return { repo, recordings, doctorId };
  }

  async run(job: ClaimedJob, signal: AbortSignal): Promise<void> {
    const scope = this.scopedFor(job.orgId, job.consultationId);
    if (!scope) return; // deleted while queued: nothing to do
    if (job.kind === "transcribe") return this.transcribe(job, scope, signal);
    return this.draft(job, scope, signal);
  }

  private async transcribe(job: ClaimedJob, { repo, recordings }: NonNullable<ReturnType<ConsultationProcessor["scopedFor"]>>, signal: AbortSignal): Promise<void> {
    const { config } = this.deps;
    const gemini = this.deps.gemini();
    if (!gemini.apiKey || !config.CONSULTATIONS_TRANSCRIPTION_MODEL) throw new ProcessingError("provider_not_configured", "AI processing is not set up on this server.", false);
    const consultation = repo.require(job.consultationId);

    // Already transcribed (this job is a repeat after a crash): carry on to the next step.
    if (repo.latestTranscript(job.consultationId)?.version === job.generation) {
      repo.enqueue(job.consultationId, "draft_note", job.generation);
      return;
    }

    let audio;
    try {
      audio = await recordings.readAudio(job.consultationId);
    } catch (err) {
      if (err instanceof ConsultationError) throw new ProcessingError(err.code === "part_damaged" ? "audio_damaged" : "audio_missing", err.code === "part_damaged" ? err.message : "The recording is no longer stored, so it can't be processed.", false);
      throw err;
    }
    const transcript = await this.deps.transcriber.transcribe({
      audio: audio.bytes,
      mimeType: audio.mimeType,
      languageHint: consultation.language_hint,
      model: config.CONSULTATIONS_TRANSCRIPTION_MODEL,
      apiKey: gemini.apiKey,
      signal,
    });
    if (signal.aborted || this.deps.isCancelled(job.id)) return; // the doctor deleted the recording meanwhile: save nothing
    repo.addTranscript(job.consultationId, job.generation, this.deps.transcriber.id, config.CONSULTATIONS_TRANSCRIPTION_MODEL, transcript);
    repo.enqueue(job.consultationId, "draft_note", job.generation);
  }

  private async draft(job: ClaimedJob, { repo, doctorId }: NonNullable<ReturnType<ConsultationProcessor["scopedFor"]>>, signal: AbortSignal): Promise<void> {
    const { config } = this.deps;
    const gemini = this.deps.gemini();
    const model = config.CONSULTATIONS_NOTE_MODEL ?? gemini.model;
    if (!gemini.apiKey || !model) throw new ProcessingError("provider_not_configured", "AI processing is not set up on this server.", false);

    const transcript = repo.latestTranscript(job.consultationId);
    if (!transcript) throw new ProcessingError("no_transcript", "There is no transcript to draft a note from.", false);
    if (repo.hasAiNoteFor(job.consultationId, transcript.id)) return; // already drafted (a repeat after a crash)

    const { note, dropped } = await draftNote({ provider: this.deps.noteProvider, model, apiKey: gemini.apiKey, transcript: transcript.content, signal });
    if (signal.aborted || this.deps.isCancelled(job.id)) return;
    repo.addAiDraft(job.consultationId, transcript.id, note, "gemini", model);
    new AuditLog(this.deps.db).record({
      actor: null,
      action: "consultation.processing.complete",
      targetOrgId: job.orgId,
      targetUserId: doctorId,
      targetLabel: job.consultationId,
      details: { segments: transcript.content.segments.length, flags: note.flags.length, dropped },
    });
  }
}
