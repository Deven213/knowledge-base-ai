import { NextResponse } from "next/server";
import { z } from "zod";
import type { AuditEntryDTO } from "@/lib/types";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  before: z.coerce.number().int().min(1).optional(),
  workspace: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
});

/** The audit log, newest first (Super Admin only). Reading it is itself recorded. */
export const GET = withTenant("platform:admin", (request, tenant) => {
  try {
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const entries = platformService().readAuditLog(platformContext(request, tenant), {
      limit: parsed.data.limit ?? 100,
      beforeId: parsed.data.before,
      targetOrgId: parsed.data.workspace,
      action: parsed.data.action,
    });
    const body: { entries: AuditEntryDTO[] } = {
      entries: entries.map((e) => ({
        id: e.id,
        at: e.at,
        actorEmail: e.actorEmail,
        action: e.action,
        targetOrgId: e.targetOrgId,
        targetLabel: e.targetLabel,
        outcome: e.outcome,
        ip: e.ip,
        details: e.details,
      })),
    };
    return NextResponse.json(body);
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("GET /api/platform/audit", err);
  }
});
