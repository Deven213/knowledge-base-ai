import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Starts a sync in the background (202). Poll GET /api/integrations for progress. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ run: getServices().integrations.startSync(id) }, { status: 202 });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/[id]/sync", err);
  }
}
