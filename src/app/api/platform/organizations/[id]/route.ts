import { NextResponse } from "next/server";
import { z } from "zod";
import type { PlatformOrganizationDetailDTO } from "@/lib/types";
import { getConfig } from "@/server/config";
import { purgeStoredObjects } from "@/server/db/storage-erasure";
import { internalError, jsonError, zodMessage } from "@/server/http";
import { platformContext, platformErrorResponse, platformService } from "@/server/platform/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };
const patchSchema = z.object({ status: z.enum(["active", "suspended"]) }).strict();
const deleteSchema = z.object({ confirmName: z.string().max(200) }).strict();

/** One workspace with its people and invitations (Super Admin only; no customer content). */
export const GET = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const { id } = await ctx.params;
    const detail: PlatformOrganizationDetailDTO = platformService().getOrganization(platformContext(request, tenant), id);
    return NextResponse.json(detail);
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("GET /api/platform/organizations/[id]", err);
  }
});

/** Suspends or reactivates a workspace. Suspending signs everyone in it out immediately; its data is kept. */
export const PATCH = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id } = await ctx.params;
    const organization = platformService().setOrganizationStatus(platformContext(request, tenant), id, parsed.data.status);
    return NextResponse.json({ organization });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("PATCH /api/platform/organizations/[id]", err);
  }
});

/**
 * Permanently deletes a customer: its workspace, everything the workspace owns, and the accounts that existed only for
 * it. The body must repeat the workspace's name (so a stray click can't delete anything). Refused for the workspace you
 * are signed in to and for any workspace that contains a Super Admin. All or nothing, and recorded in the audit log.
 */
export const DELETE = withTenant<Params>("platform:admin", async (request, tenant, ctx) => {
  try {
    const parsed = deleteSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, "Type the workspace's name to confirm the deletion.");
    const { id } = await ctx.params;
    const { storedObjects, ...deleted } = platformService().deleteOrganization(platformContext(request, tenant), id, parsed.data.confirmName);
    // The database no longer refers to the workspace's stored recordings; now remove the files themselves. Whatever can't be removed here
    // is reported and swept up later by the worker, so no recording outlives its workspace.
    const purged = await purgeStoredObjects(getConfig(), storedObjects);
    return NextResponse.json({ deleted: { ...deleted, recordingsRemoved: purged.removed, recordingsPending: purged.failed } });
  } catch (err) {
    return platformErrorResponse(err) ?? internalError("DELETE /api/platform/organizations/[id]", err);
  }
});
