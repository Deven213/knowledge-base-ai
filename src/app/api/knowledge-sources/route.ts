import { NextResponse } from "next/server";
import { internalError, requireFeature } from "@/server/http";
import { listKnowledgeSources, searchableDocuments } from "@/server/knowledge/scope";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Chat with" options: All Knowledge Base plus each website, cloud drive and uploaded document with indexed content. */
export async function GET() {
  const featureOff = requireFeature("knowledge_base");
  if (featureOff) return featureOff;
  try {
    const { documents, embedder } = getServices();
    return NextResponse.json({ sources: listKnowledgeSources(searchableDocuments(documents.list(), embedder.modelId)) });
  } catch (err) {
    return internalError("GET /api/knowledge-sources", err);
  }
}
