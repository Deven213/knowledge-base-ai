// public-route: the one-click demo sign-in, available only when the demo account is deliberately enabled.
import { NextResponse } from "next/server";
import { safeRedirect } from "@/lib/auth-routes";
import { getAuth, sessionCookie } from "@/server/auth/service";
import { getConfig } from "@/server/config";
import { internalError, jsonError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Use Demo Account": a plain form POST from the login page that signs in as the demo user on the
 * server, so the demo password never has to travel through browser JavaScript. Available only while the
 * demo account exists (DEMO_USER_PASSWORD is set) AND the login page shows it (DEMO_SHOW_CREDENTIALS).
 * The demo user belongs only to its own "Demo workspace", never to a customer's.
 */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const auth = getAuth();
    const demo = getConfig().DEMO_SHOW_CREDENTIALS ? auth.demoUser() : undefined;
    const org = demo ? auth.defaultOrganization(demo.id) : undefined;
    if (!demo || demo.status !== "active" || !org) return jsonError(404, "Not found.");
    const form = await request.formData().catch(() => null);
    const target = safeRedirect(typeof form?.get("redirect") === "string" ? (form!.get("redirect") as string) : undefined);
    const { token, expiresAt } = auth.createSession(demo.id, org.orgId);
    const res = NextResponse.redirect(new URL(target, request.url), 303);
    res.cookies.set(sessionCookie(token, expiresAt));
    return res;
  } catch (err) {
    return internalError("POST /api/auth/demo", err);
  }
}
