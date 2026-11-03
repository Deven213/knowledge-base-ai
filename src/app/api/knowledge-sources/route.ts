import { NextResponse } from "next/server";
import { internalError, requireFeature } from "@/server/http";
import { listKnowledgeSources, searchableDocuments } from "@/server/knowledge/scope";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Chat with" options: All Knowledge Base plus each website, cloud drive and uploaded document with indexed content (the caller's organization only). */
export const GET = withTenant("documents:read", async (_request, tenant) => {
  const featureOff = requireFeature("knowledge_base");
  if (featureOff) return featureOff;
  try {
    const { documents, embedder } = getTenantServices(tenant);
    return NextResponse.json({ sources: listKnowledgeSources(searchableDocuments(documents.list(), embedder.modelId)) });
  } catch (err) {
    return internalError("GET /api/knowledge-sources", err);
  }
});
