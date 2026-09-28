import { NextResponse } from "next/server";
import { internalError, jsonError, requireFeature } from "@/server/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const featureOff = requireFeature("documents");
  if (featureOff) return featureOff;
  try {
    const { id } = await ctx.params;
    const { documents } = getServices();
    if (!documents.delete(id)) return jsonError(404, "Document not found.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError("DELETE /api/documents/[id]", err);
  }
}
