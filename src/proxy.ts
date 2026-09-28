import { NextResponse, type NextRequest } from "next/server";
import { isProtectedApi, isProtectedPage, loginUrlFor, SESSION_COOKIE } from "@/lib/auth-routes";
import { isSessionTokenValid } from "@/server/auth/session-lookup";

/**
 * Request gate: product pages and APIs require a valid session (checked against the database, so a
 * signed-out or expired session is rejected immediately). The landing page, /login and the sign-in
 * API are public. Product layouts check the session again on the server.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const signedIn = isSessionTokenValid(request.cookies.get(SESSION_COOKIE)?.value);
  if (signedIn) return NextResponse.next();

  if (isProtectedApi(pathname)) {
    return NextResponse.json({ error: "Sign in to continue.", code: "unauthenticated" }, { status: 401 });
  }
  if (isProtectedPage(pathname)) {
    return NextResponse.redirect(new URL(loginUrlFor(`${pathname}${search}`), request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/app/:path*", "/chat/:path*", "/settings/:path*", "/api/:path*"],
};
