import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a sync in the background (202). Poll GET /api/integrations for progress. The sync only ever writes into the caller's organization. */
export const POST = withTenant<{ id: string }>("integrations:manage", async (_request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ run: getTenantServices(tenant).integrations.startSync(id) }, { status: 202 });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/[id]/sync", err);
  }
});
