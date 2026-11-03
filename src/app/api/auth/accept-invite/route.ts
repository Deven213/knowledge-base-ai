// public-route: a person who was invited has no account or session yet, so this must work signed out.
import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditLog, auditIp } from "@/server/audit/audit";
import { acceptInvitation, findPendingInvitation, type AcceptResult } from "@/server/auth/invitations";
import { hashPassword, passwordProblem } from "@/server/auth/password";
import { getAuth, sessionCookie, sessionTokenFromRequest } from "@/server/auth/service";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { internalError, jsonError, rejectCrossSite, zodMessage } from "@/server/http";
import { passwordChangeRequired } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    token: z.string().max(200),
    // Needed only when the invited person doesn't have an account yet.
    password: z.string().max(200).optional(),
    name: z.string().trim().max(100).optional(),
  })
  .strict();

const INVALID = "This invitation link is invalid or has expired.";

/** Peek at an invitation (which workspace, which email) so the page can show what the person is joining. Reveals nothing for a bad token. */
export async function GET(request: Request) {
  try {
    const invitation = findPendingInvitation(getDb(), new URL(request.url).searchParams.get("token"));
    if (!invitation) return jsonError(404, INVALID);
    const hasAccount = !!getAuth().identity.findUserByEmail(invitation.email);
    return NextResponse.json({ organization: invitation.orgName, email: invitation.email, role: invitation.role, hasAccount });
  } catch (err) {
    return internalError("GET /api/auth/accept-invite", err);
  }
}

/**
 * Accepts an invitation: the membership is created and the link is used up in one step. A new person sets a
 * password and gets an account; someone who already has an account must be signed in as the invited email.
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { token, password, name } = parsed.data;
    const db = getDb();
    const auth = getAuth();

    // Someone who still has a temporary password may do nothing else first (not even join through an invitation).
    const signedIn = auth.getSession(sessionTokenFromRequest(request));
    if (signedIn?.mustChangePassword) return passwordChangeRequired();

    const invitation = findPendingInvitation(db, token);
    if (!invitation) return jsonError(404, INVALID);
    const hasAccount = !!auth.identity.findUserByEmail(invitation.email);

    let who: Parameters<typeof acceptInvitation>[2];
    if (hasAccount) {
      // Joining with an existing account requires being signed in as that account (no password is taken here).
      if (!signedIn) return jsonError(401, "This email already has an account. Sign in, then open the invitation link again.");
      who = { existingUserId: signedIn.userId };
    } else {
      const problem = passwordProblem(password, invitation.email);
      if (problem) return jsonError(400, problem);
      who = { newUser: { passwordHash: await hashPassword(password as string), displayName: name || null } };
    }
    // The membership, the used-up link and the audit record are written together or not at all.
    const result: AcceptResult = db.transaction(() => {
      const accepted = acceptInvitation(db, token, who);
      if (accepted.ok) {
        new AuditLog(db).record({
          actor: { userId: accepted.userId, email: invitation.email, orgId: accepted.orgId },
          action: "auth.invitation.accept",
          targetOrgId: accepted.orgId,
          targetLabel: invitation.orgName,
          ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS),
          details: { role: invitation.role, newAccount: accepted.createdAccount },
        });
      }
      return accepted;
    })();

    if (!result.ok) {
      if (result.reason === "email_mismatch") return jsonError(403, "This invitation was sent to a different email address.");
      if (result.reason === "already_member") return jsonError(409, "You are already a member of this workspace.");
      if (result.reason === "account_exists") return jsonError(409, "This email already has an account. Sign in, then open the invitation link again.");
      return jsonError(404, INVALID);
    }

    // Start (or move) the session in the workspace that was just joined.
    auth.identity.touchLogin(result.userId);
    const { token: sessionToken, expiresAt } = auth.createSession(result.userId, result.orgId);
    if (signedIn) auth.deleteSession(sessionTokenFromRequest(request));
    const res = NextResponse.json({ redirect: "/admin", organization: invitation.orgName });
    res.cookies.set(sessionCookie(sessionToken, expiresAt));
    return res;
  } catch (err) {
    return internalError("POST /api/auth/accept-invite", err);
  }
}
