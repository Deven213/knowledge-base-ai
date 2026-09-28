// Which URLs need a signed-in session, and where sign-in may send people afterwards.
// Pure functions: shared by the proxy (request gate), the login page and the auth API.

export const SESSION_COOKIE = "kb_session";

/** The product (admin, app entry, chat, settings). Everything else — landing page, /login — is public. */
export const PROTECTED_PAGE_PREFIXES = ["/admin", "/app", "/chat", "/settings"] as const;

/** The only API routes reachable without a session: signing in and out. */
const PUBLIC_API_PREFIXES = ["/api/auth/"] as const;

const DEFAULT_AFTER_LOGIN = "/admin";

const underPrefix = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isProtectedPage(pathname: string): boolean {
  return PROTECTED_PAGE_PREFIXES.some((p) => underPrefix(pathname, p));
}

export function isProtectedApi(pathname: string): boolean {
  return underPrefix(pathname, "/api") && !PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * Where to go after signing in: the requested product page (path + query) if it is one, otherwise
 * the dashboard. Never another site (no "//host", "\\", schemes) — no open redirects.
 */
export function safeRedirect(target: string | null | undefined): string {
  if (!target || typeof target !== "string" || target.length > 500) return DEFAULT_AFTER_LOGIN;
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\") || /[\u0000-\u001f]/.test(target)) {
    return DEFAULT_AFTER_LOGIN;
  }
  let url: URL;
  try {
    url = new URL(target, "http://local.invalid");
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== "http://local.invalid" || !isProtectedPage(url.pathname)) return DEFAULT_AFTER_LOGIN;
  return `${url.pathname}${url.search}`;
}

/** "/login?redirect=/admin/documents" for a protected page. */
export function loginUrlFor(pathWithQuery: string): string {
  const target = safeRedirect(pathWithQuery);
  return target === DEFAULT_AFTER_LOGIN && pathWithQuery !== DEFAULT_AFTER_LOGIN
    ? "/login"
    : `/login?redirect=${encodeURIComponent(target).replace(/%2F/gi, "/")}`;
}
