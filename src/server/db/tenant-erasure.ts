import "server-only";
import type Database from "better-sqlite3";

// What it takes to delete a customer's workspace safely. Everything customer-owned (documents, their search index,
// chats, integrations and their stored credentials, invitations, settings, sessions, memberships) is removed by the
// database itself: every one of those tables references organizations(id) ON DELETE CASCADE, directly or through a
// parent row (tests/tenant-erasure.test.ts checks that for EVERY table, so a table added later can't be forgotten).
// This module holds the checks around that single DELETE:
//   - counts for the confirmation dialog and the audit record (numbers only, never content);
//   - refusing to delete while work for the workspace is still running;
//   - deciding which ACCOUNTS may go with the workspace. Two foreign keys point at users with ON DELETE CASCADE
//     (conversations.user_id and invitations.invited_by), so deleting an account could silently delete rows that
//     belong to ANOTHER customer. An account is only removed when nothing of that kind exists outside this workspace.
// It is the only place besides the repositories that reads customer tables, and only the Super Admin service uses it.

export interface TenantDataSummary {
  documents: number;
  conversations: number;
  /** Integrations that were actually connected (the empty placeholders every workspace gets don't count). */
  integrations: number;
  /** Doctor consultations (health information: each has a sealed recording, transcript and note). */
  consultations: number;
}

const count = (db: Database.Database, sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;

export function summarizeTenantData(db: Database.Database, orgId: string): TenantDataSummary {
  return {
    documents: count(db, `SELECT COUNT(*) AS n FROM documents WHERE org_id = ?`, orgId),
    conversations: count(db, `SELECT COUNT(*) AS n FROM conversations WHERE org_id = ?`, orgId),
    integrations: count(db, `SELECT COUNT(*) AS n FROM integration_connections WHERE org_id = ? AND status <> 'not_connected'`, orgId),
    consultations: count(db, `SELECT COUNT(*) AS n FROM consultations WHERE org_id = ?`, orgId),
  };
}

/**
 * The storage folders of this workspace's recordings that still hold audio. The database cascade removes the records but cannot reach
 * files, so whoever deletes a workspace removes these AFTER the deletion commits (db/storage-erasure.ts). Opaque random names only.
 */
export function storedObjectKeys(db: Database.Database, orgId: string): string[] {
  return (db.prepare(`SELECT storage_key FROM consultation_recordings WHERE org_id = ? AND status <> 'deleted'`).all(orgId) as { storage_key: string }[]).map((r) => r.storage_key);
}

/** A sentence saying why the workspace can't be deleted right now, or null when nothing is still running for it. */
export function workInProgress(db: Database.Database, orgId: string): string | null {
  if (db.prepare(`SELECT 1 FROM documents WHERE org_id = ? AND status = 'processing' LIMIT 1`).get(orgId)) {
    return "A document is still being processed for this workspace. Wait for it to finish, then try again.";
  }
  if (
    db
      .prepare(`SELECT 1 FROM integration_sync_runs r JOIN integration_connections c ON c.id = r.integration_id WHERE c.org_id = ? AND r.status = 'running' LIMIT 1`)
      .get(orgId)
  ) {
    return "An integration sync is still running for this workspace. Wait for it to finish, then try again.";
  }
  if (db.prepare(`SELECT 1 FROM consultation_jobs WHERE org_id = ? AND status = 'running' LIMIT 1`).get(orgId)) {
    return "A consultation recording is being processed for this workspace. Wait for it to finish, then try again.";
  }
  return null;
}

/**
 * Splits the people of a workspace into accounts that exist only because of it (safe to delete with it) and accounts to
 * keep. An account is kept if it belongs to another workspace, has chats in another workspace, or issued an
 * invitation in another workspace: deleting it would delete THAT data through the foreign keys.
 */
export function splitAccounts(db: Database.Database, orgId: string, userIds: string[]): { remove: string[]; keep: string[] } {
  const remove: string[] = [];
  const keep: string[] = [];
  for (const userId of userIds) {
    const elsewhere =
      db.prepare(`SELECT 1 FROM memberships WHERE user_id = ? AND org_id <> ? LIMIT 1`).get(userId, orgId) ||
      db.prepare(`SELECT 1 FROM conversations WHERE user_id = ? AND org_id <> ? LIMIT 1`).get(userId, orgId) ||
      db.prepare(`SELECT 1 FROM invitations WHERE invited_by = ? AND org_id <> ? LIMIT 1`).get(userId, orgId) ||
      // Health records name the doctor, the person who recorded consent and the people who wrote or approved a note as plain foreign keys (no
      // cascade, so an account can never silently take records with it). A person who is named in ANOTHER workspace's records, even after being
      // removed from that workspace, must stay: deleting them would fail, and the whole deletion would roll back.
      db.prepare(`SELECT 1 FROM consultations WHERE doctor_user_id = ? AND org_id <> ? LIMIT 1`).get(userId, orgId) ||
      db.prepare(`SELECT 1 FROM consultation_consents WHERE recorded_by_user_id = ? AND org_id <> ? LIMIT 1`).get(userId, orgId) ||
      db.prepare(`SELECT 1 FROM consultation_notes WHERE (created_by_user_id = ? OR approved_by_user_id = ?) AND org_id <> ? LIMIT 1`).get(userId, userId, orgId);
    (elsewhere ? keep : remove).push(userId);
  }
  return { remove, keep };
}
