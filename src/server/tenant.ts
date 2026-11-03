import "server-only";
import { NextResponse } from "next/server";
import { AuditLog, auditActor, auditIp } from "./audit/audit";
import { currentSession, getAuth, sessionTokenFromRequest, type Session } from "./auth/service";
import { roleCan, type Action } from "./authz/permissions";
import { getConfig } from "./config";
import { getDb } from "./db/client";
import type { Role } from "./db/constants";
import { internalError, rejectCrossSite } from "./http";

/**
 * Who a request is, and which organization it works in. It is always derived on the server from the
 * session cookie (never from a header, query string or body), and re-read from the database on every
 * request, so a removed membership or disabled account loses access immediately.
 */
export interface TenantContext {
  /** Same value as `orgId`. The voice/TTS code and its tests already key their per-tenant data by this name. */
  tenantId: string;
  orgId: string;
  userId: string;
  userEmail: string;
  displayName: string | null;
  role: Role;
  /** May change platform-wide settings (feature flags, the global AI provider). Not an organization role. */
  isPlatformAdmin: boolean;
  /** Still on a temporary password: every route except the password change itself is refused. */
  mustChangePassword: boolean;
}

function toTenant(session: Session | null): TenantContext | null {
  return session
    ? {
        tenantId: session.orgId,
        orgId: session.orgId,
        userId: session.userId,
        userEmail: session.email,
        displayName: session.displayName,
        role: session.role,
        isPlatformAdmin: session.isPlatformAdmin,
        mustChangePassword: session.mustChangePassword,
      }
    : null;
}

/** The signed-in caller of an API request, or null. */
export function tenantFromRequest(request: Request): TenantContext | null {
  return toTenant(getAuth().getSession(sessionTokenFromRequest(request)));
}

/** The signed-in caller of a page request (server components), or null. */
export async function currentTenant(): Promise<TenantContext | null> {
  return toTenant(await currentSession());
}

/** Whether the caller may perform an action. Platform actions need the platform flag; the rest follow the role. */
export function can(tenant: TenantContext, action: Action): boolean {
  return action === "platform:admin" ? tenant.isPlatformAdmin : roleCan(tenant.role, action);
}

export const unauthenticated = () => NextResponse.json({ error: "Sign in to continue.", code: "unauthenticated" }, { status: 401 });
/** A person who still has a temporary password may not do anything else until they have chosen their own. */
export const passwordChangeRequired = () =>
  NextResponse.json({ error: "You must choose a new password before continuing.", code: "password_change_required" }, { status: 403 });
export const forbidden = () => NextResponse.json({ error: "You don't have permission to do that.", code: "forbidden" }, { status: 403 });

/** Someone without platform rights asked for a platform action: leave a record (never blocks the 403 itself). */
function recordDeniedPlatformAccess(request: Request, tenant: TenantContext): void {
  try {
    new AuditLog(getDb()).record({
      actor: auditActor(tenant),
      action: "platform.access_denied",
      outcome: "denied",
      ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS),
      details: { method: request.method, path: new URL(request.url).pathname },
    });
  } catch (err) {
    console.error("[audit] could not record a denied platform access", err instanceof Error ? err.message : err);
  }
}

type RouteContext<P> = { params: Promise<P> };
type TenantHandler<P> = (request: Request, tenant: TenantContext, ctx: RouteContext<P>) => Response | Promise<Response>;

/**
 * Wraps a route handler so that it can only run for a signed-in caller who holds `action`
 * (`null` = any signed-in member). The handler receives the caller's TenantContext and must build all its
 * data access from it (getTenantServices). Mutating requests also get the cross-site check here, so no
 * route can forget it. Someone who still has a temporary password is refused here, on the server, for every route
 * unless it explicitly opts in (only the password change and "who am I" do): hiding pages in the browser is never
 * what protects the data.
 */
export function withTenant<P = Record<string, never>>(action: Action | null, handler: TenantHandler<P>, options: { allowWhilePasswordChangeRequired?: boolean } = {}) {
  return async (request: Request, ctx: RouteContext<P>): Promise<Response> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const crossSite = rejectCrossSite(request);
      if (crossSite) return crossSite;
    }
    let tenant: TenantContext | null;
    try {
      tenant = tenantFromRequest(request);
    } catch (err) {
      return internalError("session lookup", err);
    }
    if (!tenant) return unauthenticated();
    if (tenant.mustChangePassword && !options.allowWhilePasswordChangeRequired) return passwordChangeRequired();
    if (action && !can(tenant, action)) {
      if (action === "platform:admin") recordDeniedPlatformAccess(request, tenant);
      return forbidden();
    }
    return handler(request, tenant, ctx);
  };
}
