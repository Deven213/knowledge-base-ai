import path from "node:path";
import { NextResponse } from "next/server";
import { toDocumentDTO } from "@/server/dto";
import { internalError, jsonError, requireFeature } from "@/server/http";
import { SUPPORTED_EXTENSIONS } from "@/server/knowledge/extract";
import { ingestDocument } from "@/server/knowledge/ingest";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withTenant("documents:read", async (_request, tenant) => {
  const featureOff = requireFeature("knowledge_base");
  if (featureOff) return featureOff;
  try {
    const { documents, embedder } = getTenantServices(tenant);
    return NextResponse.json({ documents: documents.list().map((d) => toDocumentDTO(d, embedder.modelId)) });
  } catch (err) {
    return internalError("GET /api/documents", err);
  }
});

export const POST = withTenant("documents:write", async (request, tenant) => {
  const featureOff = requireFeature("documents");
  if (featureOff) return featureOff;
  try {
    const services = getTenantServices(tenant);
    const maxBytes = services.config.MAX_UPLOAD_MB * 1024 * 1024;

    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > maxBytes + 64 * 1024) {
      return jsonError(413, `File is too large. The limit is ${services.config.MAX_UPLOAD_MB} MB.`);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonError(400, "Expected a multipart/form-data upload.");
    }
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(400, 'No file provided in the "file" field.');
    if (file.size === 0) return jsonError(400, "The uploaded file is empty.");
    if (file.size > maxBytes) {
      return jsonError(413, `File is too large. The limit is ${services.config.MAX_UPLOAD_MB} MB.`);
    }

    const filename = path.basename(file.name).slice(0, 255) || "document";
    const ext = path.extname(filename).toLowerCase();
    if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
      return jsonError(415, `Unsupported file type. Upload a ${SUPPORTED_EXTENSIONS.join(", ")} file.`);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await ingestDocument(services, { filename, buffer });

    const row = services.documents.get(result.documentId);
    const document = row ? toDocumentDTO(row, services.embedder.modelId) : null;
    // Extraction failures are the user's file, not a server fault: 422 with the stored reason.
    return NextResponse.json({ document }, { status: result.status === "ready" ? 201 : 422 });
  } catch (err) {
    return internalError("POST /api/documents", err);
  }
});
