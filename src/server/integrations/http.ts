import "server-only";
import { NextResponse } from "next/server";
import { internalError, jsonError, requireFeature } from "../http";
import { IntegrationError } from "./errors";

/** Every integration API route requires the Integrations feature (sync_integrations) (and, through it, the Knowledge Base). */
export const requireSyncIntegrations = () => requireFeature("sync_integrations");

/** User-facing message for integration errors; technical details stay in the server log. */
export function integrationErrorResponse(context: string, err: unknown): NextResponse {
  if (err instanceof IntegrationError) return jsonError(err.status, err.message);
  return internalError(context, err);
}
