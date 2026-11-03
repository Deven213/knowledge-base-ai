import { NextResponse } from "next/server";
import { z } from "zod";
import { AuditLog, auditActor, auditIp } from "@/server/audit/audit";
import { getAuth, sessionCookie } from "@/server/auth/service";
import { hashPassword, passwordProblem, PASSWORD_MAX_LENGTH, verifyPassword } from "@/server/auth/password";
import { passwordChangeThrottle, throttleKeys } from "@/server/auth/throttle";
import { getConfig } from "@/server/config";
import { getDb } from "@/server/db/client";
import { internalError, jsonError } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ currentPassword: z.string().max(PASSWORD_MAX_LENGTH), newPassword: z.string().max(PASSWORD_MAX_LENGTH) }).strict();

/**
 * Chooses a new password. This is the ONE thing a person with a temporary password may do (the route opts in to
 * withTenant's password-change lock; everything else answers 403 until it has succeeded).
 *
 * The caller must prove the current (temporary) password again, so a session left open on a shared computer can't
 * be used to take the account over. The new password has to meet the policy and differ from the current one.
 * On success the old hash is overwritten (the temporary password stops working at that instant), EVERY session of
 * the account is ended and a fresh one is started here, and the change is recorded without any password in it.
 * Wrong current passwords are rate-limited per account and per client.
 */
export const POST = withTenant(
  null,
  async (request, tenant) => {
    try {
      const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success) return jsonError(400, "Enter your current password and the new one.");
      const { currentPassword, newPassword } = parsed.data;

      const config = getConfig();
      const keys = throttleKeys(request, config.TRUSTED_PROXY_HOPS, tenant.userEmail);
      if (passwordChangeThrottle.isBlocked(keys)) return jsonError(429, "Too many attempts. Please wait a few minutes and try again.");

      const db = getDb();
      const auth = getAuth();
      const user = auth.identity.findUserById(tenant.userId);
      if (!user) return jsonError(401, "Sign in to continue.");

      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        passwordChangeThrottle.recordFailure(keys);
        return jsonError(400, "The current password is not correct.");
      }
      const problem = passwordProblem(newPassword, user.email);
      if (problem) return jsonError(400, problem);
      if (newPassword === currentPassword) return jsonError(400, "Choose a password that is different from the current one.");

      const newHash = await hashPassword(newPassword);
      const session = db.transaction(() => {
        // Checked again inside the transaction: the password may have been changed (or reissued) while this was hashing.
        const fresh = auth.identity.findUserById(user.id);
        if (!fresh || fresh.password_hash !== user.password_hash) return null;
        auth.identity.setOwnPassword(user.id, newHash, new Date().toISOString());
        auth.deleteSessionsOfUser(user.id); // every sign-in of this account ends, including the one that made this request
        new AuditLog(db).record({
          actor: auditActor(tenant),
          action: "auth.password.change",
          ip: auditIp(request, config.TRUSTED_PROXY_HOPS),
          details: { forced: user.must_change_password === 1 },
        });
        return auth.createSession(user.id, tenant.orgId);
      })();
      if (!session) return jsonError(409, "Your password was changed somewhere else. Sign in again.");

      passwordChangeThrottle.clear(keys.filter((k) => k.startsWith("acct:")));
      const res = NextResponse.json({ changed: true, redirect: "/admin" }, { headers: { "Cache-Control": "no-store" } });
      res.cookies.set(sessionCookie(session.token, session.expiresAt));
      return res;
    } catch (err) {
      return internalError("POST /api/auth/change-password", err);
    }
  },
  { allowWhilePasswordChangeRequired: true },
);
