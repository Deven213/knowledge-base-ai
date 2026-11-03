import { NextResponse } from "next/server";
import type { StatsDTO } from "@/lib/types";
import { internalError, requireFeature } from "@/server/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dashboard numbers for the caller's organization (counts only). */
export const GET = withTenant("documents:read", async (_request, tenant) => {
  const featureOff = requireFeature("dashboard");
  if (featureOff) return featureOff;
  try {
    const { documents, conversations, providerConfig, embedder } = getTenantServices(tenant);
    const active = providerConfig.activeProvider();
    const status = providerConfig.status(active);
    const body: StatsDTO = {
      documents: documents.stats(),
      ...conversations.counts(),
      activeProvider: active,
      activeProviderReady: status.ready,
      activeModel: status.model.value,
      embeddingModel: embedder.modelId,
    };
    return NextResponse.json(body);
  } catch (err) {
    return internalError("GET /api/stats", err);
  }
});
