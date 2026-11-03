import { NextResponse } from "next/server";
import { AuditLog, auditActor, auditIp } from "@/server/audit/audit";
import { InvitationRepository } from "@/server/auth/invitations";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { internalError, jsonError } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Withdraws a pending invitation of the caller's workspace. Another workspace's invitation is reported as not found. */
export const DELETE = withTenant<{ id: string }>("members:manage", async (request, tenant, ctx) => {
  try {
    const { id } = await ctx.params;
    const db = getDb();
    const revoked = db.transaction(() => {
      if (!new InvitationRepository(db, tenant.orgId).revoke(id)) return false;
      new AuditLog(db).record({
        actor: auditActor(tenant),
        action: "org.invitation.revoke",
        targetOrgId: tenant.orgId,
        ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS),
        details: { invitationId: id },
      });
      return true;
    })();
    if (!revoked) return jsonError(404, "Invitation not found.");
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return internalError("DELETE /api/org/invitations/[id]", err);
  }
});
