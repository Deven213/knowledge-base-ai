import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth-routes";
import { getAuth } from "@/server/auth/service";
import { internalError, rejectCrossSite } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ends the session (deletes it on the server and clears the cookie), then goes to the landing page. */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  try {
    const token = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    getAuth().deleteSession(token ? decodeURIComponent(token) : null);
    const res = NextResponse.redirect(new URL("/", request.url), 303);
    res.cookies.delete({ name: SESSION_COOKIE, path: "/" });
    return res;
  } catch (err) {
    return internalError("POST /api/auth/logout", err);
  }
}
