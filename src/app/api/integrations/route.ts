import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The caller's organization's integrations (one per type in Phase 1) and their recent sync history. Never includes credentials. */
export const GET = withTenant("integrations:manage", async (_request, tenant) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { integrations } = getTenantServices(tenant);
    return NextResponse.json({ integrations: integrations.list(), runs: integrations.listRuns() });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations", err);
  }
});
