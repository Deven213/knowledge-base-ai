import { NextResponse } from "next/server";
import { isFeatureEnabled } from "@/server/features/service";
import { internalError, requireFeature } from "@/server/http";
import { suggestQuestions } from "@/server/rag/suggest";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;
  // Suggestions come from Knowledge Base documents: none while it's off.
  if (!isFeatureEnabled("knowledge_base")) return NextResponse.json({ questions: [] });
  try {
    const s = getServices();
    const questions = await suggestQuestions({
      documents: s.documents,
      settings: s.settings,
      providerConfig: s.providerConfig,
      getProvider: s.getProvider,
      embeddingModel: s.embedder.modelId,
    });
    return NextResponse.json({ questions });
  } catch (err) {
    return internalError("GET /api/suggestions", err);
  }
}
