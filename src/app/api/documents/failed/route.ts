import { NextResponse } from "next/server";
import type { ClearFailedDocumentsDTO } from "@/lib/types";
import { internalError, requireFeature } from "@/server/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * "Clear failed": removes the caller's organization's documents whose status is 'failed' and nothing else.
 *
 * - The caller and their organization come from the server-side session only. The request carries no
 *   body, tenant, user or document IDs, so there is nothing a browser could forge or leave stale.
 * - Deletion is a single atomic statement scoped to the organization that re-checks the status as it
 *   deletes; chunks go with their document (ON DELETE CASCADE). Uploaded files are never stored.
 */
export const DELETE = withTenant("documents:delete", async (_request, tenant) => {
  const featureOff = requireFeature("documents");
  if (featureOff) return featureOff;
  try {
    const deletedIds = getTenantServices(tenant).documents.deleteFailed();
    const deleted = deletedIds.length;
    const body: ClearFailedDocumentsDTO = {
      deleted,
      deletedIds,
      message: deleted === 0 ? "No failed documents to clear." : `${deleted} failed document${deleted === 1 ? "" : "s"} cleared successfully.`,
    };
    return NextResponse.json(body);
  } catch (err) {
    return internalError("DELETE /api/documents/failed", err);
  }
});
