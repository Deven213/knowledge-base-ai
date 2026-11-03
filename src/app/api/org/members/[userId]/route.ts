import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditLog, auditActor, auditIp } from "@/server/audit/audit";
import { IdentityRepository, LastOwnerError } from "@/server/auth/identity";
import { canChangeRole, ROLES } from "@/server/authz/permissions";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { forbidden, withTenant } from "@/server/tenant";
import { internalError, jsonError, zodMessage } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { userId: string };
const patchSchema = z.object({ role: z.enum(ROLES) }).strict();

// Both handlers only ever touch a membership of the CALLER's workspace (the organization comes from the
// session). A person who isn't a member of it is reported exactly like one that doesn't exist.

/** Changes someone's role. You can't grant a role above your own, only an owner can create or change an owner, and the last owner can't be demoted. */
export const PATCH = withTenant<Params>("members:manage", async (request, tenant, ctx) => {
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { userId } = await ctx.params;
    const identity = new IdentityRepository(getDb());
    const current = identity.getMembership(tenant.orgId, userId);
    if (!current) return jsonError(404, "Member not found.");
    if (!canChangeRole(tenant.role, current.role, parsed.data.role)) return forbidden();
    const db = getDb();
    db.transaction(() => {
      identity.changeRole(tenant.orgId, userId, parsed.data.role);
      new AuditLog(db).record({
        actor: auditActor(tenant),
        action: "org.member.role_change",
        targetOrgId: tenant.orgId,
        targetUserId: userId,
        ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS),
        details: { from: current.role, to: parsed.data.role },
      });
    })();
    return NextResponse.json({ members: identity.listMembers(tenant.orgId) });
  } catch (err) {
    if (err instanceof LastOwnerError) return jsonError(409, err.message);
    return internalError("PATCH /api/org/members/[userId]", err);
  }
});

/** Removes someone from the workspace (their sessions in it end at once). The last owner can't be removed. */
export const DELETE = withTenant<Params>("members:manage", async (request, tenant, ctx) => {
  try {
    const { userId } = await ctx.params;
    const identity = new IdentityRepository(getDb());
    const current = identity.getMembership(tenant.orgId, userId);
    if (!current) return jsonError(404, "Member not found.");
    if (!canChangeRole(tenant.role, current.role, null)) return forbidden();
    const db = getDb();
    db.transaction(() => {
      identity.removeMember(tenant.orgId, userId);
      new AuditLog(db).record({
        actor: auditActor(tenant),
        action: "org.member.remove",
        targetOrgId: tenant.orgId,
        targetUserId: userId,
        ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS),
        details: { role: current.role },
      });
    })();
    return NextResponse.json({ members: identity.listMembers(tenant.orgId) });
  } catch (err) {
    if (err instanceof LastOwnerError) return jsonError(409, err.message);
    return internalError("DELETE /api/org/members/[userId]", err);
  }
});
