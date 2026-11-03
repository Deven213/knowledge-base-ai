import "server-only";
import type Database from "better-sqlite3";

/**
 * Housekeeping that runs once at startup, outside any request and before anyone is signed in. These
 * statements deliberately span ALL organizations: they only repair work that a crash or restart left
 * half-done and never read or return customer content. Request code must never use this class; it is
 * the only place that is allowed to touch tenant tables without an organization.
 */
export class SystemMaintenance {
  constructor(private readonly db: Database.Database) {}

  /** Documents left in 'processing' by a crash or restart can never finish. */
  failStaleProcessing(): number {
    return this.db
      .prepare(
        `UPDATE documents SET status = 'failed', error = 'Processing was interrupted. Please upload the file again.'
         WHERE status = 'processing'`,
      )
      .run().changes;
  }

  /** Syncs run inside the server process; any still "running" at startup were interrupted. */
  failInterruptedRuns(): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE integration_sync_runs SET status = 'error', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                  error_message = 'The sync was interrupted because the server restarted.' WHERE status = 'running'`,
        )
        .run();
      this.db
        .prepare(`UPDATE integration_connections SET status = 'error', last_error = 'The last sync was interrupted because the server restarted.' WHERE status = 'syncing'`)
        .run();
    })();
  }
}
