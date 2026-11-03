import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Removes the stored OAuth tokens. Configuration, imported documents and sync history are kept. */
export const POST = withTenant<{ id: string }>("integrations:manage", async (_request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ integration: await getTenantServices(tenant).integrations.disconnect(id) });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/[id]/disconnect", err);
  }
});
