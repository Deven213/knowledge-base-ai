import { NextResponse } from "next/server";
import { z } from "zod";
import { safeRedirect } from "@/lib/auth-routes";
import { clearFailures, clientKey, getAuth, recordFailure, sessionCookie, tooManyFailures } from "@/server/auth/service";
import { internalError, jsonError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().max(320),
  password: z.string().max(200),
  redirect: z.string().max(500).optional(),
});

const INVALID = "Invalid email or password.";

/** Email + password sign-in. The same message for every failure: nothing reveals which part was wrong. */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const client = clientKey(request);
  try {
    if (tooManyFailures(client)) return jsonError(429, "Too many sign-in attempts. Please wait a few minutes and try again.");
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    const auth = getAuth();
    const email = parsed.success ? auth.verifyCredentials(parsed.data.email, parsed.data.password) : null;
    if (!email) {
      recordFailure(client);
      return jsonError(401, INVALID);
    }
    clearFailures(client);
    const { token, expiresAt } = auth.createSession(email);
    const res = NextResponse.json({ redirect: safeRedirect(parsed.success ? parsed.data.redirect : undefined) });
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    return internalError("POST /api/auth/login", err);
  }
}
