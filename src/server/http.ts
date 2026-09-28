import "server-only";
import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { FEATURE_DISABLED_MESSAGE, type FeatureKey } from "@/lib/features";
import { PROVIDER_IDS, type ProviderId } from "@/lib/types";
import { getFeatureFlags } from "./features/service";

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export function zodMessage(err: ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}

export function parseProviderId(value: string): ProviderId | null {
  return (PROVIDER_IDS as readonly string[]).includes(value) ? (value as ProviderId) : null;
}

/**
 * Server-side feature check for API routes. Returns a 403 response when any of the features is
 * unavailable (switched off, or a dependency is off), otherwise null.
 */
export function requireFeature(...keys: FeatureKey[]): NextResponse | null {
  const flags = getFeatureFlags();
  const off = keys.map((k) => flags.find((f) => f.key === k)!).find((f) => !f.available);
  if (!off) return null;
  return NextResponse.json(
    { error: `${off.name} is disabled. ${FEATURE_DISABLED_MESSAGE}`, code: "feature_disabled", feature: off.key },
    { status: 403 },
  );
}

/**
 * Rejects cross-site requests. Browsers always send an Origin header on cross-origin POSTs, so a
 * page on another site can't make the user's browser upload files or spend AI credits here.
 * Requests without an Origin (curl, server-to-server) are allowed.
 */
export function rejectCrossSite(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  try {
    if (new URL(origin).host === request.headers.get("host")) return null;
  } catch {
    // Malformed Origin: treat as cross-site.
  }
  return jsonError(403, "Cross-site requests are not allowed.");
}

/** Last-resort handler: log server-side, return a generic message (no internals leak to the client). */
export function internalError(context: string, err: unknown): NextResponse {
  console.error(`[api] ${context}`, err instanceof Error ? `${err.name}: ${err.message}` : err);
  const message =
    err instanceof Error && err.message.startsWith("Invalid configuration")
      ? err.message
      : "Something went wrong on the server. Check the server logs.";
  return jsonError(500, message);
}
