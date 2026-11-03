import "server-only";
import { NextResponse } from "next/server";
import type { IssuedCredentialsDTO } from "@/lib/types";
import { auditActor, auditIp } from "../audit/audit";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { jsonError } from "../http";
import type { TenantContext } from "../tenant";
import { PlatformAdminService, PlatformError, type IssuedCredentials, type PlatformContext } from "./service";

// Shared plumbing for the /api/platform routes (every one of them is behind withTenant("platform:admin")).

export function platformService(): PlatformAdminService {
  return new PlatformAdminService(getDb(), { temporaryPasswordHours: getConfig().TEMPORARY_PASSWORD_HOURS });
}

/** Who is acting and from where, for the audit record. */
export function platformContext(request: Request, tenant: TenantContext): PlatformContext {
  return { actor: auditActor(tenant), ip: auditIp(request, getConfig().TRUSTED_PROXY_HOPS) };
}

/** The normal product login page: what the Super Admin passes on together with the credentials. */
export function loginUrl(): string {
  return `${getConfig().APP_BASE_URL}/login`;
}

/** The credentials as the Super Admin's browser receives them (once), with the login page to send along. */
export function credentialsDto(credentials: IssuedCredentials): IssuedCredentialsDTO {
  return { ...credentials, loginUrl: loginUrl() };
}

/** A JSON response that browsers and proxies must not keep: used for everything that carries a temporary password. */
export function noStoreJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** The response for an expected platform error (not found, conflict, invalid input), or null for anything else. */
export function platformErrorResponse(err: unknown): NextResponse | null {
  return err instanceof PlatformError ? jsonError(err.status, err.message) : null;
}
