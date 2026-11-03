import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuth, sessionTokenFromRequest } from "@/server/auth/service";
import { sessionDto } from "@/server/auth/session-dto";
import { getDb } from "@/server/db/client";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { tenantFromRequest, withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ orgId: z.uuid() }).strict();

/**
 * Moves this session to another workspace the caller belongs to. A workspace they don't belong to is
 * reported exactly like one that doesn't exist.
 */
export const POST = withTenant(null, async (request) => {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    if (!getAuth().switchOrganization(sessionTokenFromRequest(request), parsed.data.orgId)) return jsonError(404, "Workspace not found.");
    const tenant = tenantFromRequest(request)!;
    return NextResponse.json(sessionDto(getDb(), tenant));
  } catch (err) {
    return internalError("POST /api/auth/switch-org", err);
  }
});
