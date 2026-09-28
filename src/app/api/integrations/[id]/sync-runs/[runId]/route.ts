import { NextResponse } from "next/server";
import { jsonError } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One sync run with its per-item results. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; runId: string }> }) {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id, runId } = await ctx.params;
    const run = getServices().integrations.runDetail(runId, id);
    return NextResponse.json({ run });
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/sync-runs/[runId]", err);
  }
}
