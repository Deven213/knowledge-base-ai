import "server-only";
import type Database from "better-sqlite3";
import { clientIp } from "../auth/throttle";

// An append-only record of sensitive access and administrative changes (table audit_log: its triggers refuse
// UPDATE and DELETE). Writing is available to every part of the server; READING spans organizations, so it
// lives in a separate class that only the platform administrator's code may construct (tests/tenant-guards).
//
// Rules for what goes in:
//  - who (user id + email copy, and the workspace they were working in), what (a stable action name), which
//    workspace or person it concerned, the outcome, and the client IP when it can be trusted;
//  - never a password, token, key, cookie or hash, and never customer content (documents, chats). 'details' is
//    small primitive metadata and is filtered again here as a safety net.

export const AUDIT_ACTIONS = [
  // Super Admin console: reading customer lists and records is itself sensitive access.
  "platform.organizations.list",
  "platform.organization.view",
  "platform.organization.create",
  "platform.organization.suspend",
  "platform.organization.reactivate",
  "platform.organization.delete",
  "platform.customer_admin.add",
  "platform.credentials.reissue",
  "platform.credentials.revoke",
  "platform.invitation.revoke",
  "platform.user.disable",
  "platform.user.enable",
  "platform.audit.view",
  "platform.access_denied",
  // The server operator repairing the owner account named in .env (scripts/owner-recover.mjs); no signed-in actor.
  "platform.owner.recover",
  // A platform administrator signing in.
  "auth.platform_admin.login",
  // A person using an invitation link (including a Customer Admin setting their password for the first time).
  "auth.invitation.accept",
  // A person replacing their password (including the mandatory change of a temporary one).
  "auth.password.change",
  // Customer Admin changes inside their own workspace.
  "org.invitation.create",
  "org.invitation.revoke",
  "org.member.role_change",
  "org.member.remove",
  // Doctor consultations (health information). Reading is recorded as well as changing; details never hold content.
  "consultation.create",
  "consultation.consent.record",
  "consultation.recording.start",
  "consultation.recording.store",
  "consultation.recording.discard",
  "consultation.audio.listen",
  "consultation.audio.delete",
  "consultation.transcript.view",
  "consultation.note.view",
  "consultation.note.edit",
  "consultation.note.approve",
  "consultation.note.reopen",
  "consultation.retry",
  "consultation.delete",
  "consultation.access_denied",
  "consultation.processing.complete",
  "consultation.processing.fail",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export type AuditOutcome = "success" | "denied" | "failed";

export interface AuditActor {
  userId: string;
  email: string;
  /** The workspace the person was signed in to when they acted. */
  orgId: string | null;
}

export type AuditDetails = Record<string, string | number | boolean | null>;

export interface AuditEvent {
  actor: AuditActor | null;
  action: AuditAction;
  targetOrgId?: string | null;
  targetUserId?: string | null;
  /** Human-readable name of the target (a workspace name or an email), for reading the log without joins. */
  targetLabel?: string | null;
  outcome?: AuditOutcome;
  ip?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorOrgId: string | null;
  action: string;
  targetOrgId: string | null;
  targetUserId: string | null;
  targetLabel: string | null;
  outcome: AuditOutcome;
  ip: string | null;
  details: AuditDetails;
}

const FORBIDDEN_KEY = /pass(word)?|secret|token|hash|cookie|authorization|credential|api[-_]?key/i;
/** A long opaque string looks like a token or key (UUIDs are 36 characters and stay readable). */
const TOKEN_LIKE = /^[A-Za-z0-9_+/=-]{40,}$/;
const MAX_VALUE_LENGTH = 200;
const MAX_KEYS = 12;

/** Keeps small primitive values and drops anything that looks like a secret. Exported for tests. */
export function sanitizeDetails(details: Record<string, unknown> | undefined): AuditDetails {
  const clean: AuditDetails = {};
  for (const [key, value] of Object.entries(details ?? {})) {
    if (Object.keys(clean).length >= MAX_KEYS) break;
    if (FORBIDDEN_KEY.test(key)) continue;
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) clean[key] = value;
    else if (typeof value === "string") clean[key] = TOKEN_LIKE.test(value) ? "[redacted]" : value.slice(0, MAX_VALUE_LENGTH);
  }
  return clean;
}

/** The person behind a request, in the shape the audit log stores. Takes the tenant context structurally. */
export function auditActor(tenant: { userId: string; userEmail: string; orgId: string }): AuditActor {
  return { userId: tenant.userId, email: tenant.userEmail, orgId: tenant.orgId };
}

/** The client's IP, only when the proxy setup makes it trustworthy (see TRUSTED_PROXY_HOPS); otherwise null. */
export function auditIp(request: Request, trustedProxyHops: number): string | null {
  return clientIp(request, trustedProxyHops);
}

/** Writes audit events. Call it inside the same transaction as the change it describes, so neither exists without the other. */
export class AuditLog {
  constructor(private readonly db: Database.Database) {}

  record(event: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (actor_user_id, actor_email, actor_org_id, action, target_org_id, target_user_id, target_label, outcome, ip, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.actor?.userId ?? null,
        event.actor?.email ?? null,
        event.actor?.orgId ?? null,
        event.action,
        event.targetOrgId ?? null,
        event.targetUserId ?? null,
        event.targetLabel?.slice(0, MAX_VALUE_LENGTH) ?? null,
        event.outcome ?? "success",
        event.ip ?? null,
        JSON.stringify(sanitizeDetails(event.details)),
      );
  }
}

interface AuditRow {
  id: number;
  at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_org_id: string | null;
  action: string;
  target_org_id: string | null;
  target_user_id: string | null;
  target_label: string | null;
  outcome: AuditOutcome;
  ip: string | null;
  details: string | null;
}

/** Reads the whole log (every organization). Only the platform administrator's code may construct it. */
export class AuditReader {
  constructor(private readonly db: Database.Database) {}

  list(options: { limit?: number; beforeId?: number; targetOrgId?: string; action?: string } = {}): AuditEntry[] {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 500);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.beforeId !== undefined) {
      where.push("id < ?");
      params.push(options.beforeId);
    }
    if (options.targetOrgId) {
      where.push("target_org_id = ?");
      params.push(options.targetOrgId);
    }
    if (options.action) {
      where.push("action = ?");
      params.push(options.action);
    }
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as AuditRow[];
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorUserId: r.actor_user_id,
      actorEmail: r.actor_email,
      actorOrgId: r.actor_org_id,
      action: r.action,
      targetOrgId: r.target_org_id,
      targetUserId: r.target_user_id,
      targetLabel: r.target_label,
      outcome: r.outcome,
      ip: r.ip,
      details: safeParse(r.details),
    }));
  }
}

function safeParse(json: string | null): AuditDetails {
  try {
    const value = json ? (JSON.parse(json) as unknown) : {};
    return value && typeof value === "object" && !Array.isArray(value) ? sanitizeDetails(value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
