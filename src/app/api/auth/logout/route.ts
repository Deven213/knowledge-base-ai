// public-route: ending your own session must work even when the session is already gone.
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-routes";
import { getAuth, sessionTokenFromRequest } from "@/server/auth/service";
import { internalError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the session (deletes it on the server and clears the cookie), then goes to the landing page. */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    getAuth().deleteSession(sessionTokenFromRequest(request));
    const res = NextResponse.redirect(new URL("/", request.url), 303);
    res.cookies.delete({ name: SESSION_COOKIE, path: "/" });
    return res;
  } catch (err) {
    return internalError("POST /api/auth/logout", err);
  }
}
