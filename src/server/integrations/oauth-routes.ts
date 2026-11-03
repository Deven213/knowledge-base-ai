import "server-only";
import { NextResponse } from "next/server";
import { getConfig } from "../config";
import { requireFeature } from "../http";
import { getTenantServices } from "../services";
import { withTenant } from "../tenant";
import { INTEGRATION_META } from "@/lib/integrations";
import { IntegrationError } from "./errors";
import type { OAuthType } from "./oauth";

// Browser-facing OAuth endpoints. Both answer with redirects back to the integration's own page,
// carrying a short user-facing result in the query string (never tokens). Both only work for a signed-in
// member who may manage integrations, and both act on THAT member's organization's connection: the
// pending authorization is looked up through the organization, so a state started by one customer can
// never be completed (or used up) by another.

const COOKIE = "kb_oauth_state";
function backToPage(type: OAuthType, params: Record<string, string>): NextResponse {
  const url = new URL(INTEGRATION_META[type].href, getConfig().APP_BASE_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v.slice(0, 300));
  const res = NextResponse.redirect(url, 303);
  res.cookies.delete({ name: COOKIE, path: "/api/integrations" });
  return res;
}

/** GET …/connect: start the flow. The state is stored server-side AND in an httpOnly cookie. */
export function connectHandler(type: OAuthType) {
  return withTenant("integrations:manage", async (_request, tenant) => {
    if (requireFeature("sync_integrations")) return backToPage(type, { error: "Integrations are disabled by the administrator." });
    try {
      const { url, state } = getTenantServices(tenant).integrations.beginOAuth(type);
      const res = NextResponse.redirect(url, 303);
      res.cookies.set({ name: COOKIE, value: state, httpOnly: true, sameSite: "lax", secure: getConfig().APP_BASE_URL.startsWith("https://"), path: "/api/integrations", maxAge: 600 });
      return res;
    } catch (err) {
      if (!(err instanceof IntegrationError)) console.error(`[integrations:${type}] connect failed`, err);
      return backToPage(type, { error: err instanceof IntegrationError ? err.message : `Could not connect ${INTEGRATION_META[type].name}.` });
    }
  });
}

/** GET …/callback: the provider sends the user back here with ?code&state (or ?error). */
export function callbackHandler(type: OAuthType) {
  return withTenant("integrations:manage", async (request, tenant) => {
    const params = new URL(request.url).searchParams;
    const cookieState = request.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? null;
    try {
      await getTenantServices(tenant).integrations.completeOAuth(type, {
        state: params.get("state"),
        cookieState: cookieState ? decodeURIComponent(cookieState) : null,
        code: params.get("code"),
        error: params.get("error"),
      });
      return backToPage(type, { connected: type });
    } catch (err) {
      if (!(err instanceof IntegrationError)) console.error(`[integrations:${type}] callback failed`, err);
      return backToPage(type, { error: err instanceof IntegrationError ? err.message : `${INTEGRATION_META[type].name} authentication failed.` });
    }
  });
}
