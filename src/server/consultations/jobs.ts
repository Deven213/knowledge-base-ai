import "server-only";
import type Database from "better-sqlite3";

// The durable queue's worker side. Like the startup housekeeping, this is the one place that looks across organizations, because a worker has
// to find whatever work is due, whoever it belongs to. It reads and writes ONLY the job table (and, to find an owner, the doctor of a
// job's consultation): it never reads a consultation's content. Once a job is claimed, everything about the consultation goes through
// a ConsultationRepository built for that job's own organization and doctor (worker.ts), so a job can only ever touch its own data.
//
// How work survives failure:
//   - A worker claims a job with a LEASE that it keeps renewing. If the process dies, the lease runs out and another claim picks the
//     job up again: nothing is stranded.
//   - A job that keeps being abandoned (or keeps failing) stops after max_attempts and is marked failed instead of looping forever.
//   - (consultation, kind, generation) is unique, so queueing the same work twice does nothing; a deliberate retry is a new generation.

export interface ClaimedJob {
  id: string;
  orgId: string;
  consultationId: string;
  kind: "transcribe" | "draft_note";
  generation: number;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string;
  org_id: string;
  consultation_id: string;
  kind: "transcribe" | "draft_note";
  generation: number;
  status: "queued" | "running";
  attempts: number;
  max_attempts: number;
}

export interface AbandonedUpload {
  orgId: string;
  consultationId: string;
}

export class ConsultationJobs {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private iso(offsetMs = 0): string {
    return new Date(this.clock().getTime() + offsetMs).toISOString();
  }

  /**
   * Takes the next due job: one that is queued and due, or one whose worker stopped renewing its lease. Returns undefined when there is
   * nothing to do. A job that has already used all its attempts is failed here instead of being run again; the second value lists those
   * so the caller can tell the doctor.
   */
  claim(workerId: string, leaseMs: number): { job?: ClaimedJob; exhausted: ClaimedJob[] } {
    const exhausted: ClaimedJob[] = [];
    let job: ClaimedJob | undefined;
    this.db
      .transaction(() => {
        for (;;) {
          const now = this.iso();
          const row = this.db
            .prepare(
              // Only work that may still be done: the workspace is active, and the doctor it belongs to is still an active member with the
              // Doctor role. A suspended workspace, a disabled account, or a doctor who was removed or moved to another role parks the work
              // (nothing is sent to the AI service) until that is put right; it is not failed, so nothing is lost.
              `SELECT id, org_id, consultation_id, kind, generation, status, attempts, max_attempts FROM consultation_jobs
                WHERE ((status = 'queued' AND run_after <= ?) OR (status = 'running' AND lease_expires_at < ?))
                  AND EXISTS (SELECT 1 FROM consultations c
                                JOIN organizations o ON o.id = c.org_id AND o.status = 'active'
                                JOIN users u ON u.id = c.doctor_user_id AND u.status = 'active'
                                JOIN memberships m ON m.org_id = c.org_id AND m.user_id = c.doctor_user_id AND m.role = 'doctor'
                               WHERE c.id = consultation_jobs.consultation_id AND c.org_id = consultation_jobs.org_id)
                ORDER BY run_after, created_at LIMIT 1`,
            )
            .get(now, now) as JobRow | undefined;
          if (!row) return;
          const claimed: ClaimedJob = { id: row.id, orgId: row.org_id, consultationId: row.consultation_id, kind: row.kind, generation: row.generation, attempts: row.attempts + 1, maxAttempts: row.max_attempts };
          if (row.attempts >= row.max_attempts) {
            // Every attempt was used (the last ones were abandoned mid-run): stop here rather than loop for ever.
            this.db
              .prepare(
                `UPDATE consultation_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?,
                        error_code = 'worker_lost', error_message = 'Processing was interrupted several times.' WHERE id = ?`,
              )
              .run(now, now, row.id);
            exhausted.push(claimed);
            continue;
          }
          this.db
            .prepare(`UPDATE consultation_jobs SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
            .run(workerId, this.iso(leaseMs), now, row.id);
          job = claimed;
          return;
        }
      })
      .immediate();
    return { job, exhausted };
  }

  /** Renews the lease of a running job. False means the job is no longer this worker's (cancelled, or taken over): stop working on it. */
  heartbeat(jobId: string, workerId: string, leaseMs: number): boolean {
    return this.db.prepare(`UPDATE consultation_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`).run(this.iso(leaseMs), this.iso(), jobId, workerId).changes === 1;
  }

  succeed(jobId: string, workerId: string): boolean {
    return this.db
      .prepare(`UPDATE consultation_jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?, error_code = NULL, error_message = NULL WHERE id = ? AND lease_owner = ? AND status = 'running'`)
      .run(this.iso(), this.iso(), jobId, workerId).changes === 1;
  }

  /** The job failed for good: it will not be tried again unless the doctor asks (a new generation). */
  fail(jobId: string, workerId: string, error: { code: string; message: string }): boolean {
    return this.db
      .prepare(`UPDATE consultation_jobs SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?, error_code = ?, error_message = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`)
      .run(this.iso(), this.iso(), error.code, error.message.slice(0, 300), jobId, workerId).changes === 1;
  }

  /** The job failed in a way that may pass (a busy AI service): put it back in the queue to run again after `delayMs`. */
  retryLater(jobId: string, workerId: string, error: { code: string; message: string }, delayMs: number): boolean {
    return this.db
      .prepare(`UPDATE consultation_jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, run_after = ?, updated_at = ?, error_code = ?, error_message = ? WHERE id = ? AND lease_owner = ? AND status = 'running'`)
      .run(this.iso(delayMs), this.iso(), error.code, error.message.slice(0, 300), jobId, workerId).changes === 1;
  }

  isCancelled(jobId: string): boolean {
    return (this.db.prepare(`SELECT status FROM consultation_jobs WHERE id = ?`).get(jobId) as { status: string } | undefined)?.status === "cancelled";
  }

  /** Who the consultation belongs to, found through the job's own organization. Undefined if it has been deleted. */
  doctorOf(orgId: string, consultationId: string): string | undefined {
    return (this.db.prepare(`SELECT doctor_user_id FROM consultations WHERE org_id = ? AND id = ?`).get(orgId, consultationId) as { doctor_user_id: string } | undefined)?.doctor_user_id;
  }

  /** Every storage folder that some recording still refers to. Anything in storage that is not here belongs to nothing. */
  referencedStorageKeys(): Set<string> {
    return new Set((this.db.prepare(`SELECT storage_key FROM consultation_recordings`).all() as { storage_key: string }[]).map((r) => r.storage_key));
  }

  /** Uploads that were started and never finished, older than `olderThanMs`: the audio pieces of an abandoned recording shouldn't linger. */
  abandonedUploads(olderThanMs: number): AbandonedUpload[] {
    return (
      this.db.prepare(`SELECT org_id, consultation_id FROM consultation_recordings WHERE status = 'uploading' AND created_at < ?`).all(this.iso(-olderThanMs)) as { org_id: string; consultation_id: string }[]
    ).map((r) => ({ orgId: r.org_id, consultationId: r.consultation_id }));
  }
}
