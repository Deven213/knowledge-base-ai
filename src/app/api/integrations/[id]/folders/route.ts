import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Folders inside `?parent=` (default: the drive's root), for the folder picker. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const parent = new URL(request.url).searchParams.get("parent") ?? undefined;
    return NextResponse.json(await getServices().integrations.listFolders(id, parent));
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/folders", err);
  }
}
