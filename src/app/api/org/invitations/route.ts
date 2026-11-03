import { NextResponse } from "next/server";
import { z } from "zod";
import type { CreatedInvitationDTO, InvitationDTO } from "@/lib/types";
import { AuditLog, auditActor, auditIp } from "@/server/audit/audit";
import { IdentityRepository, normalizeEmail } from "@/server/auth/identity";
import { InvitationRepository, type InvitableRole } from "@/server/auth/invitations";
import { invitableRoles } from "@/server/authz/permissions";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { forbidden, withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ email: z.email().max(320), role: z.enum(["admin", "member", "doctor", "viewer"]) }).strict();

/** The caller's workspace's invitations (pending, accepted, revoked, expired). The links themselves are never stored, so they can't be shown again. */
export const GET = withTenant("members:manage", (_request, tenant) => {
  try {
    const invitations: InvitationDTO[] = new InvitationRepository(getDb(), tenant.orgId).list();
    return NextResponse.json({ invitations });
  } catch (err) {
    return internalError("GET /api/org/invitations", err);
  }
});

/** Creates a single-use invitation link for one email address. You can't invite above your own role, and never an owner. */
export const POST = withTenant("members:manage", async (request, tenant) => {
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { role } = parsed.data;
    const email = normalizeEmail(parsed.data.email);
    if (!invitableRoles(tenant.role).includes(role)) return forbidden();

    const db = getDb();
    const identity = new IdentityRepository(db);
    const existing = identity.findUserByEmail(email);
    if (existing && identity.getMembership(tenant.orgId, existing.id)) return jsonError(409, "That person is already a member of this workspace.");

    const config = getConfig();
    const invitations = new InvitationRepository(db, tenant.orgId);
    const created = db.transaction(() => {
      const made = invitations.create(email, role as InvitableRole, tenant.userId, config.INVITE_TTL_HOURS);
      new AuditLog(db).record({
        actor: auditActor(tenant),
        action: "org.invitation.create",
        targetOrgId: tenant.orgId,
        targetLabel: email,
        ip: auditIp(request, config.TRUSTED_PROXY_HOPS),
        details: { role },
      });
      return made;
    })();
    const invitation = invitations.list().find((i) => i.id === created.id)!;
    const body: CreatedInvitationDTO = { invitation, url: `${config.APP_BASE_URL}/invite?token=${created.token}` };
    return NextResponse.json(body, { status: 201 });
  } catch (err) {
    return internalError("POST /api/org/invitations", err);
  }
});
