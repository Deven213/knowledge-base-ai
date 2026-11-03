import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@/server/features/service";
import { internalError, requireFeature } from "@/server/http";
import { suggestQuestions } from "@/server/rag/suggest";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Starter questions from the caller's organization's documents; the cache is per organization too. */
export const GET = withTenant("chat", async (_request, tenant) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  // Suggestions come from Knowledge Base documents: none while it's off.
  if (!isFeatureEnabled("knowledge_base")) return NextResponse.json({ questions: [] });
  try {
    const s = getTenantServices(tenant);
    const questions = await suggestQuestions({
      documents: s.documents,
      settings: s.orgSettings,
      providerConfig: s.providerConfig,
      getProvider: s.getProvider,
      embeddingModel: s.embedder.modelId,
    });
    return NextResponse.json({ questions });
  } catch (err) {
    return internalError("GET /api/suggestions", err);
  }
});
