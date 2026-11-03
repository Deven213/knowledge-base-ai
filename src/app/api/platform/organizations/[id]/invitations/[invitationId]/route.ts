import { NextResponse } from "next/server";
import { internalError } from "@/server/http";
import { platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string; invitationId: string };

/** Withdraws a pending invitation of this workspace, so its link stops working. */
export const DELETE = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const { id, invitationId } = await ctx.params;
    platformService().revokeInvitation(platformContext(request, tenant), id, invitationId);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("DELETE /api/platform/organizations/[id]/invitations/[invitationId]", err);
  }
});
