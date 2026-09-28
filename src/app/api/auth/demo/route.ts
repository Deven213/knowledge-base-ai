import { NextResponse } from "next/server";
import { safeRedirect } from "@/lib/auth-routes";
import { getAuth, sessionCookie } from "@/server/auth/service";
import { getConfig } from "@/server/config";
import { internalError, jsonError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Use Demo Account": a plain form POST from the login page that signs in as the demo user on the
 * server, so the demo password never has to travel through browser JavaScript. Available only while
 * the login page shows the demo credentials (DEMO_SHOW_CREDENTIALS).
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    if (!getConfig().DEMO_SHOW_CREDENTIALS) return jsonError(404, "Not found.");
    const form = await request.formData().catch(() => null);
    const target = safeRedirect(typeof form?.get("redirect") === "string" ? (form!.get("redirect") as string) : undefined);
    const auth = getAuth();
    const { token, expiresAt } = auth.createSession(auth.demoEmail);
    const res = NextResponse.redirect(new URL(target, request.url), 303);
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    return internalError("POST /api/auth/demo", err);
  }
}
