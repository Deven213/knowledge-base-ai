import { NextResponse } from "next/server";
import { internalError, jsonError, requireFeature } from "@/server/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A document that isn't this organization's is reported exactly like one that doesn't exist. */
export const DELETE = withTenant<{ id: string }>("documents:delete", async (_request, tenant, ctx) => {
  const featureOff = requireFeature("documents");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const { documents } = getTenantServices(tenant);
    if (!documents.delete(id)) return jsonError(404, "Document not found.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError("DELETE /api/documents/[id]", err);
  }
});
