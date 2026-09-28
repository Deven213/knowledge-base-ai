import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  INTEGRATION_META,
  INTEGRATION_TYPES,
  type IntegrationConfig,
  type IntegrationStatus,
  type IntegrationType,
  type SyncRunItemDTO,
  type SyncRunStatus,
} from "@/lib/integrations";
import type { EncryptedSecret } from "../security/crypto";

export interface IntegrationRow {
  id: string;
  type: IntegrationType;
  name: string;
  enabled: number;
  status: IntegrationStatus;
  configuration_json: string;
  account_label: string | null;
  last_error: string | null;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncRunRow {
  id: string;
  integration_id: string;
  status: SyncRunStatus;
  started_at: string;
  completed_at: string | null;
  files_found: number;
  files_added: number;
  files_updated: number;
  files_skipped: number;
  files_failed: number;
  error_message: string | null;
  details_json: string | null;
  integration_type: IntegrationType;
  integration_name: string;
}

export interface RunTotals {
  found: number;
  added: number;
  updated: number;
  skipped: number;
  failed: number;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
/** OAuth authorizations must be completed within this window. */
export const OAUTH_STATE_TTL_MINUTES = 10;

export class IntegrationRepository {
  constructor(private readonly db: Database.Database) {}

  /** One connection per type in Phase 1; created on first use (disabled, not connected). */
  seed(): void {
    const insert = this.db.prepare(
      `INSERT INTO integration_connections (id, type, name, enabled, status)
       SELECT ?, ?, ?, 0, 'not_connected' WHERE NOT EXISTS (SELECT 1 FROM integration_connections WHERE type = ?)`,
    );
    this.db.transaction(() => {
      for (const type of INTEGRATION_TYPES) insert.run(randomUUID(), type, INTEGRATION_META[type].name, type);
    })();
  }

  list(): IntegrationRow[] {
    this.seed();
    return this.db
      .prepare(`SELECT * FROM integration_connections ORDER BY CASE type WHEN 'website' THEN 0 WHEN 'google_drive' THEN 1 ELSE 2 END`)
      .all() as IntegrationRow[];
  }

  get(id: string): IntegrationRow | undefined {
    return this.db.prepare(`SELECT * FROM integration_connections WHERE id = ?`).get(id) as IntegrationRow | undefined;
  }

  getByType(type: IntegrationType): IntegrationRow {
    this.seed();
    return this.db.prepare(`SELECT * FROM integration_connections WHERE type = ?`).get(type) as IntegrationRow;
  }

  config(row: IntegrationRow): IntegrationConfig {
    try {
      return JSON.parse(row.configuration_json) as IntegrationConfig;
    } catch {
      return {};
    }
  }

  update(id: string, fields: { enabled?: boolean; configuration?: IntegrationConfig; status?: IntegrationStatus; accountLabel?: string | null; lastError?: string | null; lastSyncAt?: string }): IntegrationRow {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.enabled !== undefined) (sets.push("enabled = ?"), values.push(fields.enabled ? 1 : 0));
    if (fields.configuration !== undefined) (sets.push("configuration_json = ?"), values.push(JSON.stringify(fields.configuration)));
    if (fields.status !== undefined) (sets.push("status = ?"), values.push(fields.status));
    if (fields.accountLabel !== undefined) (sets.push("account_label = ?"), values.push(fields.accountLabel));
    if (fields.lastError !== undefined) (sets.push("last_error = ?"), values.push(fields.lastError));
    if (fields.lastSyncAt !== undefined) (sets.push("last_sync_at = ?"), values.push(fields.lastSyncAt));
    if (sets.length) this.db.prepare(`UPDATE integration_connections SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = ?`).run(...values, id);
    return this.get(id)!;
  }

  // ── Encrypted OAuth credentials ──

  saveCredentials(integrationId: string, secret: EncryptedSecret): void {
    this.db
      .prepare(
        `INSERT INTO integration_credentials (integration_id, ciphertext, iv, auth_tag) VALUES (?, ?, ?, ?)
         ON CONFLICT(integration_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, auth_tag = excluded.auth_tag, updated_at = ${NOW}`,
      )
      .run(integrationId, secret.ciphertext, secret.iv, secret.authTag);
  }

  getCredentials(integrationId: string): EncryptedSecret | null {
    const row = this.db.prepare(`SELECT ciphertext, iv, auth_tag FROM integration_credentials WHERE integration_id = ?`).get(integrationId) as
      | { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }
      | undefined;
    return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.auth_tag } : null;
  }

  deleteCredentials(integrationId: string): void {
    this.db.prepare(`DELETE FROM integration_credentials WHERE integration_id = ?`).run(integrationId);
  }

  // ── OAuth state (CSRF protection + PKCE verifier) ──

  createOAuthState(state: string, integrationId: string, codeVerifier: string): void {
    this.db.prepare(`DELETE FROM oauth_states WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-${OAUTH_STATE_TTL_MINUTES} minutes')`).run();
    this.db.prepare(`INSERT INTO oauth_states (state, integration_id, code_verifier) VALUES (?, ?, ?)`).run(state, integrationId, codeVerifier);
  }

  /** Single use: the state is deleted whether or not it is still valid. */
  consumeOAuthState(state: string): { integrationId: string; codeVerifier: string } | null {
    const row = this.db
      .prepare(
        `SELECT integration_id, code_verifier, created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-${OAUTH_STATE_TTL_MINUTES} minutes') AS fresh
         FROM oauth_states WHERE state = ?`,
      )
      .get(state) as { integration_id: string; code_verifier: string; fresh: number } | undefined;
    this.db.prepare(`DELETE FROM oauth_states WHERE state = ?`).run(state);
    return row && row.fresh ? { integrationId: row.integration_id, codeVerifier: row.code_verifier } : null;
  }

  // ── Sync runs ──

  private static readonly RUN_SELECT = `
    SELECT r.*, c.type AS integration_type, c.name AS integration_name
    FROM integration_sync_runs r JOIN integration_connections c ON c.id = r.integration_id`;

  startRun(integrationId: string): SyncRunRow {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO integration_sync_runs (id, integration_id, status) VALUES (?, ?, 'running')`).run(id, integrationId);
    return this.getRun(id)!;
  }

  updateRunProgress(runId: string, totals: RunTotals): void {
    this.db
      .prepare(`UPDATE integration_sync_runs SET files_found = ?, files_added = ?, files_updated = ?, files_skipped = ?, files_failed = ? WHERE id = ?`)
      .run(totals.found, totals.added, totals.updated, totals.skipped, totals.failed, runId);
  }

  finishRun(runId: string, status: SyncRunStatus, totals: RunTotals, items: SyncRunItemDTO[], errorMessage: string | null): SyncRunRow {
    this.db
      .prepare(
        `UPDATE integration_sync_runs SET status = ?, completed_at = ${NOW}, files_found = ?, files_added = ?, files_updated = ?,
                files_skipped = ?, files_failed = ?, error_message = ?, details_json = ? WHERE id = ?`,
      )
      .run(status, totals.found, totals.added, totals.updated, totals.skipped, totals.failed, errorMessage, JSON.stringify(items.slice(0, 500)), runId);
    return this.getRun(runId)!;
  }

  getRun(runId: string): SyncRunRow | undefined {
    return this.db.prepare(`${IntegrationRepository.RUN_SELECT} WHERE r.id = ?`).get(runId) as SyncRunRow | undefined;
  }

  listRuns(integrationId?: string, limit = 20): SyncRunRow[] {
    return integrationId
      ? (this.db.prepare(`${IntegrationRepository.RUN_SELECT} WHERE r.integration_id = ? ORDER BY r.started_at DESC LIMIT ?`).all(integrationId, limit) as SyncRunRow[])
      : (this.db.prepare(`${IntegrationRepository.RUN_SELECT} ORDER BY r.started_at DESC LIMIT ?`).all(limit) as SyncRunRow[]);
  }

  latestRun(integrationId: string): SyncRunRow | undefined {
    return this.listRuns(integrationId, 1)[0];
  }

  /** Syncs run inside the server process; any still "running" at startup were interrupted. */
  failInterruptedRuns(): void {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE integration_sync_runs SET status = 'error', completed_at = ${NOW}, error_message = 'The sync was interrupted because the server restarted.' WHERE status = 'running'`)
        .run();
      this.db
        .prepare(`UPDATE integration_connections SET status = 'error', last_error = 'The last sync was interrupted because the server restarted.' WHERE status = 'syncing'`)
        .run();
    })();
  }
}
