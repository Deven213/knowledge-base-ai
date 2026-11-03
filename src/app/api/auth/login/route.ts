// public-route: this is how people sign in, so it can't require a session.
import { NextResponse } from "next/server";
import { z } from "zod";
import { PASSWORD_CHANGE_PATH, safeRedirect } from "@/lib/auth-routes";
import { AuditLog, auditIp } from "@/server/audit/audit";
import { getAuth, sessionCookie } from "@/server/auth/service";
import { loginThrottle, throttleKeys } from "@/server/auth/throttle";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { internalError, jsonError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().max(320),
  password: z.string().max(200),
  redirect: z.string().max(500).optional(),
});

const INVALID = "Invalid email or password.";

/**
 * Email + password sign-in against the users table. The same message for every failure (wrong password,
 * unknown email, disabled account, no workspace): nothing reveals which part was wrong or whether an email
 * is registered. Failed attempts are limited per account, and per client IP when the proxy setup is known.
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const config = getConfig();
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    const keys = throttleKeys(request, config.TRUSTED_PROXY_HOPS, parsed.success ? parsed.data.email : undefined);
    if (loginThrottle.isBlocked(keys)) return jsonError(429, "Too many sign-in attempts. Please wait a few minutes and try again.");

    const auth = getAuth();
    const user = parsed.success ? await auth.authenticate(parsed.data.email, parsed.data.password) : await auth.authenticate(undefined, undefined);
    // The password was right, so saying why is safe: a temporary password that has run out (or was revoked).
    if (user && auth.temporaryPasswordExpired(user)) {
      return NextResponse.json({ error: "Your temporary password has expired. Ask your administrator for new credentials.", code: "temporary_password_expired" }, { status: 403 });
    }
    const org = user ? auth.defaultOrganization(user.id) : undefined;
    // The password was right, so saying why is safe: the person's workspace has been suspended.
    if (user && !org && auth.onlySuspendedWorkspaces(user.id)) {
      return NextResponse.json({ error: "Your workspace is suspended. Please contact your administrator.", code: "workspace_suspended" }, { status: 403 });
    }
    // Same reasoning: the password was right, and an account that no workspace contains would otherwise look exactly like a
    // wrong password (this is what the owner address added to .env after the first owner existed ran into).
    if (user && !org && auth.belongsToNoWorkspace(user.id)) {
      return NextResponse.json({ error: "Your account doesn't belong to any workspace yet. Ask your administrator to add you to one.", code: "no_workspace" }, { status: 403 });
    }
    if (!user || !org) {
      loginThrottle.recordFailure(keys);
      return jsonError(401, INVALID);
    }
    // Only the account's counter is reset: signing in to your own account must not wipe the IP's failure count.
    loginThrottle.clear(keys.filter((k) => k.startsWith("acct:")));

    // Sign-ins of platform administrators are sensitive access: recorded before the session exists (no record, no session).
    if (user.is_platform_admin === 1) {
      new AuditLog(getDb()).record({
        actor: { userId: user.id, email: user.email, orgId: org.orgId },
        action: "auth.platform_admin.login",
        ip: auditIp(request, config.TRUSTED_PROXY_HOPS),
      });
    }
    auth.identity.touchLogin(user.id);
    const { token, expiresAt } = auth.createSession(user.id, org.orgId);
    // With a temporary password the only place to go is the page where a new one is chosen.
    const mustChange = user.must_change_password === 1;
    const res = NextResponse.json({ redirect: mustChange ? PASSWORD_CHANGE_PATH : safeRedirect(parsed.success ? parsed.data.redirect : undefined), passwordChangeRequired: mustChange });
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    return internalError("POST /api/auth/login", err);
  }
}
