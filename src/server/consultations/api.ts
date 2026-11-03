import "server-only";
import type { NextResponse } from "next/server";
import { AuditLog, auditActor, auditIp, type AuditAction, type AuditOutcome } from "../audit/audit";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { internalError, jsonError, requireFeature } from "../http";
import { getTenantServices } from "../services";
import type { TenantContext } from "../tenant";
import { ConsultationError } from "./errors";
import { consultationsConfigured, processingGate, type Gate } from "./gate";

// What every consultation route has in common, in one place so no route can forget a step:
//   1. the Doctor Consultations feature must be on (the platform administrator's switch);
//   2. the server must have the key that seals the data (otherwise: "not set up", never a crash);
//   3. the consultation id in the URL must look like one;
//   4. refusals become clean JSON, anything unexpected becomes a generic 500 (the real error goes to the server log, never the
//      browser), and an attempt on a consultation that is not the caller's is written to the audit log (a guessed or stale id).
// The caller has already passed withTenant("consultations:use"): signed in, in an organization, holding the Doctor role.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reading what a consultation contains (its transcript, its note, its audio) must leave a record: if the record cannot be written, the read is
 * refused rather than served unlogged. Every other event is best-effort (a failure to log it never blocks the doctor).
 */
const MUST_BE_RECORDED = new Set<AuditAction>(["consultation.transcript.view", "consultation.note.view", "consultation.audio.listen"]);

/**
 * Refused attempts are recorded, but a signed-in person can't be allowed to fill an append-only table that can never be pruned: after this many in
 * the window, further ones from the same person are dropped (the first ones are the evidence).
 */
const DENIED_PER_WINDOW = 20;
const DENIED_WINDOW_MS = 10 * 60_000;
const deniedSeen = new Map<string, { since: number; count: number }>();

/** Test hook: forget who has been refused how often. */
export function resetDeniedThrottleForTests(): void {
  deniedSeen.clear();
}

function mayRecordDenied(userId: string, now = Date.now()): boolean {
  const entry = deniedSeen.get(userId);
  if (!entry || now - entry.since > DENIED_WINDOW_MS) {
    deniedSeen.set(userId, { since: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= DENIED_PER_WINDOW;
}

export interface ConsultationContext {
  tenant: TenantContext;
  services: ReturnType<typeof getTenantServices>;
  gate: Gate;
  /** Records an event in the audit log. Never pass content (patient label, transcript, note) in `details`. */
  audit: (action: AuditAction, consultationId: string | null, details?: Record<string, unknown>, outcome?: AuditOutcome) => void;
}

export async function consultationRoute(
  name: string,
  tenant: TenantContext,
  request: Request,
  consultationId: string | null,
  run: (ctx: ConsultationContext) => Promise<Response | NextResponse> | Response | NextResponse,
): Promise<Response> {
  const config = getConfig();
  const db = getDb();
  const audit: ConsultationContext["audit"] = (action, id, details, outcome = "success") => {
    if (action === "consultation.access_denied" && !mayRecordDenied(tenant.userId)) return;
    try {
      new AuditLog(db).record({
        actor: auditActor(tenant),
        action,
        targetOrgId: tenant.orgId,
        targetUserId: tenant.userId,
        targetLabel: id,
        outcome,
        ip: auditIp(request, config.TRUSTED_PROXY_HOPS),
        details,
      });
    } catch (err) {
      console.error("[audit] could not record a consultation event:", err instanceof Error ? err.name : "unknown error");
      if (MUST_BE_RECORDED.has(action)) throw err; // fail closed: nothing is read that could not be logged
    }
  };

  const off = requireFeature("consultations");
  if (off) return off;
  if (!consultationsConfigured(config)) return jsonError(503, "Consultations are not set up on this server yet. Ask your administrator.");
  if (consultationId !== null && !UUID.test(consultationId)) {
    audit("consultation.access_denied", null, { reason: "malformed_id" }, "denied");
    return jsonError(404, "That consultation was not found.");
  }
  try {
    const services = getTenantServices(tenant);
    const gate = processingGate(config, services.providerConfig.resolve("gemini").apiKey ?? undefined);
    return await run({ tenant, services, gate, audit });
  } catch (err) {
    if (err instanceof ConsultationError) {
      // Only "not yours or not there" is an access attempt. "No note yet", "no transcript yet" and "no audio" are ordinary answers about the doctor's own consultation.
      if (err.code === "not_found" && consultationId !== null) audit("consultation.access_denied", consultationId, { reason: err.code }, "denied");
      return Response.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return internalError(name, err);
  }
}
