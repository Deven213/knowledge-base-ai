import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One sync run with its per-item results. */
export const GET = withTenant<{ id: string; runId: string }>("integrations:manage", async (_request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id, runId } = await ctx.params;
    const run = getTenantServices(tenant).integrations.runDetail(runId, id);
    return NextResponse.json({ run });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/sync-runs/[runId]", err);
  }
});
