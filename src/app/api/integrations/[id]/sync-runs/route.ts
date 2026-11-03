import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sync history for one integration (newest first). */
export const GET = withTenant<{ id: string }>("integrations:manage", async (_request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ runs: getTenantServices(tenant).integrations.runsFor(id) });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/sync-runs", err);
  }
});
