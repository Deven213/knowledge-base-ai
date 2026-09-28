import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sync history for one integration (newest first). */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ runs: getServices().integrations.runsFor(id) });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/sync-runs", err);
  }
}
