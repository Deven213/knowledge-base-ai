import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Removes the stored OAuth tokens. Configuration, imported documents and sync history are kept. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    return NextResponse.json({ integration: await getServices().integrations.disconnect(id) });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/[id]/disconnect", err);
  }
}
