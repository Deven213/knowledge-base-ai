import { NextResponse } from "next/server";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Folders inside `?parent=` (default: the drive's root), for the folder picker. */
export const GET = withTenant<{ id: string }>("integrations:manage", async (request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const { id } = await ctx.params;
    const parent = new URL(request.url).searchParams.get("parent") ?? undefined;
    return NextResponse.json(await getTenantServices(tenant).integrations.listFolders(id, parent));
  } catch (err) {
    return integrationErrorResponse("GET /api/integrations/[id]/folders", err);
  }
});
