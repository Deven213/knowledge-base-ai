import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { AuditLog } from "../audit/audit";
import type { AppConfig } from "../config";
import { isFeatureEnabled } from "../features/service";
import { getProvider } from "../llm/registry";
import { ProviderConfigService } from "../llm/resolve";
import { getAudioStore } from "./audio-store";
import { processingGate } from "./gate";
import { ConsultationJobs, type ClaimedJob } from "./jobs";
import { ConsultationProcessor, type ProcessorDeps } from "./processing";
import { ProcessingError } from "./processing-error";
import { geminiTranscriber } from "./transcription/gemini";
import { consultationVault } from "./vault";

// The background worker. It runs inside the server process (the same hosting model as the integration syncs: this app keeps its state on
// one machine's disk), but the work itself lives in the database queue, not in memory, so it survives restarts, and a second worker
// process could share the same queue without double-processing (claims are atomic and leased).
//
// It does NOTHING until the privacy gate is open (gate.ts): jobs simply wait in the queue. Recordings are never sent to an AI service
// before the provider and its data handling have been reviewed.

const TICK_MS = 5_000;
const LEASE_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
const ABANDONED_UPLOAD_MS = 24 * 60 * 60_000;
const SWEEP_EVERY_MS = 15 * 60_000;
const MAX_JOBS_PER_TICK = 10;
/** The longest one job (a transcription of a long recording is the slow one) may run before it is stopped and retried. */
const JOB_DEADLINE_MS = 15 * 60_000;
/**
 * Stored audio that no recording refers to is removed once it is this old (a folder is only ever written after its recording row exists, so a
 * young one is never an orphan). A full day, not an hour, on purpose: the sweep is irreversible, and if a database is restored from a backup (or
 * another copy is pointed at the same folder), recordings that database does not know about must survive long enough to be noticed.
 */
const ORPHAN_AGE_MS = 24 * 60 * 60_000;

export interface WorkerDeps extends Omit<ProcessorDeps, "isCancelled" | "doctorOf"> {
  /** Whether jobs may run now, and why not (for the server log only). */
  gateOpen: () => { open: boolean; reason: string | null };
  /** The platform administrator's switch for Doctor Consultations. While it is off nothing is processed, whatever is queued. */
  featureEnabled: () => boolean;
}

/** Wait before the next attempt: 15 s, 30 s, 1 min, 2 min... capped, with a little jitter so retries don't arrive together. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(15_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(base * (0.8 + random() * 0.4));
}

export class ConsultationWorker {
  readonly jobs: ConsultationJobs;
  private readonly processor: ConsultationProcessor;
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private busy = false;
  private lastSweep = 0;
  private reportedGate: string | null | undefined;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly clock: () => Date = () => new Date(),
    private readonly jobDeadlineMs: number = JOB_DEADLINE_MS,
  ) {
    this.jobs = new ConsultationJobs(deps.db, clock);
    this.processor = new ConsultationProcessor({ ...deps, isCancelled: (id) => this.jobs.isCancelled(id), doctorOf: (o, c) => this.jobs.doctorOf(o, c) });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: housekeeping, then run every job that is due (at most MAX_JOBS_PER_TICK). Returns how many ran. Tests call this directly. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    try {
      await this.sweepAbandonedUploads();
      const gate = this.deps.gateOpen();
      if (!gate.open) {
        // Say why, once per change, in the operator's log: the doctor sees a plain "waiting" message instead.
        if (this.reportedGate !== gate.reason) console.info(`[consultations] processing is paused: ${gate.reason}`);
        this.reportedGate = gate.reason;
        return 0;
      }
      if (!this.deps.featureEnabled()) {
        if (this.reportedGate !== "feature off") console.info("[consultations] processing is paused: the Doctor Consultations feature is switched off");
        this.reportedGate = "feature off";
        return 0;
      }
      this.reportedGate = null;
      let ran = 0;
      while (ran < MAX_JOBS_PER_TICK) {
        const { job, exhausted } = this.jobs.claim(this.workerId, LEASE_MS);
        for (const lost of exhausted) this.failConsultation(lost, new ProcessingError("worker_lost", "Processing was interrupted several times. You can try again.", false));
        if (!job) break;
        await this.runJob(job);
        ran += 1;
      }
      return ran;
    } catch (err) {
      console.error("[consultations] worker pass failed:", err instanceof Error ? err.name : "unknown error");
      return 0;
    } finally {
      this.busy = false;
    }
  }

  private async runJob(job: ClaimedJob): Promise<void> {
    const abort = new AbortController();
    let timedOut = false;
    // Keep the lease while the (possibly long) AI call runs; if it is lost (the job was cancelled or taken over), stop.
    const heartbeat = setInterval(() => {
      if (!this.jobs.heartbeat(job.id, this.workerId, LEASE_MS)) abort.abort();
    }, LEASE_MS / 3);
    heartbeat.unref?.();
    // A hard deadline, so one hung call to the AI service can't hold the worker (and with it every other doctor's work) for ever.
    const deadline = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.jobDeadlineMs);
    deadline.unref?.();
    try {
      await this.processor.run(job, abort.signal);
      this.jobs.succeed(job.id, this.workerId);
    } catch (err) {
      const failure = timedOut ? new ProcessingError("provider_timeout", "Processing took too long and will be retried automatically.", true) : err instanceof ProcessingError ? err : this.unexpected(job, err);
      if (failure.retryable && job.attempts < job.maxAttempts) {
        this.jobs.retryLater(job.id, this.workerId, { code: failure.code, message: failure.message }, backoffMs(job.attempts));
      } else if (this.jobs.fail(job.id, this.workerId, { code: failure.code, message: failure.message })) {
        // Only if THIS worker still held the job: a job that was cancelled or taken over is not this worker's to report on.
        this.failConsultation(job, failure);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
    }
  }

  /** An error nobody planned for: logged without content, shown to the doctor as a generic failure, and not retried (it would repeat). */
  private unexpected(job: ClaimedJob, err: unknown): ProcessingError {
    // Only the kind of error: a message (a parse error, say) can quote the transcript.
    const code = (err as { code?: unknown })?.code;
    console.error(`[consultations] ${job.kind} job failed unexpectedly: ${err instanceof Error ? err.name : "unknown error"}${typeof code === "string" ? ` (${code})` : ""}`);
    return new ProcessingError("internal_error", "Something went wrong while processing this recording. You can try again, or contact support if it keeps happening.", false);
  }

  /** The job failed for good: tell the doctor what happened (and let them retry), and leave a record. */
  private failConsultation(job: ClaimedJob, failure: ProcessingError): void {
    const scope = this.processor.scopedFor(job.orgId, job.consultationId);
    if (!scope) return;
    const row = scope.repo.require(job.consultationId);
    if (row.status === "processing") scope.repo.setStatus(job.consultationId, "failed", { code: failure.code, message: failure.message });
    new AuditLog(this.deps.db).record({
      actor: null,
      action: "consultation.processing.fail",
      targetOrgId: job.orgId,
      targetUserId: scope.doctorId,
      targetLabel: job.consultationId,
      outcome: "failed",
      details: { kind: job.kind, code: failure.code, attempts: job.attempts },
    });
  }

  /**
   * Housekeeping, every so often: (1) recordings that were started and never finished lose their pieces and the doctor can start again;
   * (2) stored audio that no recording refers to (left behind if a deletion couldn't remove a file, say) is removed. Together they mean
   * audio never lingers anywhere the database no longer knows about.
   */
  private async sweepAbandonedUploads(): Promise<void> {
    const now = this.clock().getTime();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    try {
      const known = this.jobs.referencedStorageKeys();
      for (const folder of await this.deps.store.listFolders()) {
        if (!known.has(folder.name) && now - folder.modifiedAt > ORPHAN_AGE_MS) await this.deps.store.deletePrefix(folder.name);
      }
    } catch (err) {
      console.error("[consultations] could not sweep orphaned audio", err instanceof Error ? err.name : "unknown error");
    }
    for (const { orgId, consultationId } of this.jobs.abandonedUploads(ABANDONED_UPLOAD_MS)) {
      try {
        await this.processor.scopedFor(orgId, consultationId)?.recordings.discard(consultationId);
      } catch (err) {
        console.error("[consultations] could not clear an abandoned upload", err instanceof Error ? err.name : err);
      }
    }
  }
}

/** The real dependencies: this deployment's config, database, audio store and AI provider. */
export function productionDeps(db: Database.Database, config: AppConfig): WorkerDeps {
  const providers = new ProviderConfigService(db, config);
  return {
    db,
    config,
    transcriber: geminiTranscriber,
    noteProvider: getProvider("gemini"),
    store: getAudioStore(config),
    vault: () => consultationVault(config),
    gemini: () => {
      const g = providers.resolve("gemini");
      return { apiKey: g.apiKey ?? undefined, model: g.model ?? undefined };
    },
    gateOpen: () => processingGate(config, providers.resolve("gemini").apiKey ?? undefined),
    featureEnabled: () => isFeatureEnabled("consultations"),
  };
}

const globalForWorker = globalThis as unknown as { __kbConsultationWorker?: ConsultationWorker };

/** Starts the one worker of this process (once, even across dev hot reloads). Does nothing unless consultations are configured. */
export function startConsultationWorker(db: Database.Database, config: AppConfig): ConsultationWorker | undefined {
  if (!config.CONSULTATIONS_WORKER || !config.CONSULTATIONS_ENCRYPTION_KEY) return undefined;
  if (!globalForWorker.__kbConsultationWorker) {
    globalForWorker.__kbConsultationWorker = new ConsultationWorker(productionDeps(db, config));
    globalForWorker.__kbConsultationWorker.start();
  }
  return globalForWorker.__kbConsultationWorker;
}
