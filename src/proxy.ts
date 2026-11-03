import { NextResponse, type NextRequest } from "next/server";
import { isProtectedApi, isProtectedPage, loginUrlFor, PASSWORD_CHANGE_PATH, SESSION_COOKIE } from "@/lib/auth-routes";
import { sessionState } from "@/server/auth/session-lookup";

/**
 * Request gate: product pages and APIs require a valid session (checked against the database, so a
 * signed-out or expired session is rejected immediately). The landing page, /login and the sign-in
 * API are public. Product layouts and every API route check the session again on the server.
 *
 * A person who still has a temporary password may open nothing but the change-password page: every other product
 * page redirects there and every other product API answers 403 (the routes under /api/auth enforce the same rule
 * themselves, and withTenant refuses everything else, so this is one layer of several).
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const state = sessionState(request.cookies.get(SESSION_COOKIE)?.value);
  if (state === "ok") return NextResponse.next();
  if (state === "password_change_required") {
    if (isProtectedApi(pathname)) {
      return NextResponse.json({ error: "You must choose a new password before continuing.", code: "password_change_required" }, { status: 403 });
    }
    if (isProtectedPage(pathname) && pathname !== PASSWORD_CHANGE_PATH) return NextResponse.redirect(new URL(PASSWORD_CHANGE_PATH, request.url));
    return NextResponse.next();
  }

  if (isProtectedApi(pathname)) {
    return NextResponse.json({ error: "Sign in to continue.", code: "unauthenticated" }, { status: 401 });
  }
  if (isProtectedPage(pathname)) {
    return NextResponse.redirect(new URL(loginUrlFor(`${pathname}${search}`), request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Must list every prefix in PROTECTED_PAGE_PREFIXES (tests/auth.test.ts checks it); Next needs this to be a literal.
  matcher: ["/admin/:path*", "/app/:path*", "/chat/:path*", "/settings/:path*", "/platform/:path*", "/change-password/:path*", "/api/:path*"],
};
