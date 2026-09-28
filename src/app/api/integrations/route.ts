import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** All integrations (one per type in Phase 1) and the recent sync history. Never includes credentials. */
export async function GET() {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { integrations } = getServices();
    return NextResponse.json({ integrations: integrations.list(), runs: integrations.listRuns() });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations", err);
  }
}
