import { NextResponse } from "next/server";
import { z } from "zod";
import { ATTACHMENT_LIMITS } from "@/lib/attachments";
import { knowledgeScopeSchema } from "@/lib/knowledge-scope";
import { LANGUAGE_CODES } from "@/lib/languages";
import { getFeatureAvailability } from "@/server/features/service";
import { internalError, jsonError, requireFeature, zodMessage } from "@/server/http";
import { ingestDocument } from "@/server/knowledge/ingest";
import { LLMError } from "@/server/llm/types";
import { AttachmentError, prepareAttachments, type IncomingAttachment } from "@/server/rag/attachments";
import { AnswerInputError, askInConversation, ConversationNotFoundError } from "@/server/rag/chat";
import { getTenantServices } from "@/server/services";
import { can, withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const fieldsSchema = z
  .object({
    // May be empty when files are attached (a default instruction is used).
    question: z.string().trim().max(2000, "Question is too long (max 2000 characters)"),
    conversationId: z.uuid().optional(),
    documentIds: z.array(z.uuid()).max(500).optional(),
    knowledgeScope: knowledgeScopeSchema.optional(),
    language: z.enum(LANGUAGE_CODES).optional(),
  })
  .strict();

type Fields = z.infer<typeof fieldsSchema>;

/** Accepts JSON ({question, conversationId?, documentIds?}) or multipart/form-data with `files`. */
async function readRequest(request: Request): Promise<{ fields: unknown; files: IncomingAttachment[] } | NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.startsWith("multipart/form-data")) {
    return { fields: await request.json().catch(() => undefined), files: [] };
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ATTACHMENT_LIMITS.maxTotalBytes + 1024 * 1024) {
    return jsonError(413, `Attachments are too large (max ${ATTACHMENT_LIMITS.maxTotalBytes / 1024 / 1024} MB per message).`);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, "Could not read the uploaded message.");
  }
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  let documentIds: unknown;
  let knowledgeScope: unknown;
  let addToKb: unknown;
  try {
    documentIds = text("documentIds") ? JSON.parse(text("documentIds")!) : undefined;
    knowledgeScope = text("knowledgeScope") ? JSON.parse(text("knowledgeScope")!) : undefined;
    addToKb = text("addToKnowledgeBase") ? JSON.parse(text("addToKnowledgeBase")!) : [];
  } catch {
    return jsonError(400, "Malformed documentIds, knowledgeScope or addToKnowledgeBase field.");
  }
  const addIndexes = new Set(Array.isArray(addToKb) ? addToKb.filter((n): n is number => Number.isInteger(n)) : []);

  const uploads = form.getAll("files").filter((f): f is File => f instanceof File);
  const files = await Promise.all(
    uploads.map(async (f, i) => ({
      name: f.name,
      buffer: Buffer.from(await f.arrayBuffer()),
      addToKnowledgeBase: addIndexes.has(i),
    })),
  );
  return {
    fields: { question: text("question") ?? "", conversationId: text("conversationId"), documentIds, knowledgeScope, language: text("language") },
    files,
  };
}

export const POST = withTenant("chat", async (request, tenant) => {
  const featureOff = requireFeature("chat");
  if (featureOff) return featureOff;

  try {
    const read = await readRequest(request);
    if (read instanceof NextResponse) return read;

    const parsed = fieldsSchema.safeParse(read.fields);
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const fields: Fields = parsed.data;
    if (!fields.question && read.files.length === 0) return jsonError(400, "question: Question is required");

    const attachments = await prepareAttachments(read.files);
    const features = getFeatureAvailability();
    const addsToKnowledgeBase = attachments.documents.some((d) => d.addToKnowledgeBase);
    // "Add to Knowledge Base" writes documents, so it needs permission to upload.
    if (addsToKnowledgeBase && !can(tenant, "documents:write")) {
      return NextResponse.json({ error: "You don't have permission to add documents to the Knowledge Base.", code: "forbidden" }, { status: 403 });
    }
    // ...and the Documents feature (which needs the Knowledge Base).
    if (addsToKnowledgeBase && !features.documents) {
      return NextResponse.json(
        { error: "Adding files to the Knowledge Base is disabled by the administrator.", code: "feature_disabled", feature: "documents" },
        { status: 403 },
      );
    }
    const services = getTenantServices(tenant);
    // Document IDs come from the browser: every one must be a document of the caller's organization. Another
    // customer's ID is answered exactly like one that doesn't exist, and is never passed to the search.
    if (fields.documentIds && fields.documentIds.length > 0) {
      const own = services.documents.existingIds(fields.documentIds);
      if (fields.documentIds.some((id) => !own.has(id))) return jsonError(404, "Document not found.");
    }
    const result = await askInConversation(
      { ...services, addToKnowledgeBase: features.documents ? (file) => ingestDocument(services, file) : undefined },
      {
        ...fields,
        documentIds: features.knowledge_base ? fields.documentIds : undefined,
        attachments,
        useKnowledgeBase: features.knowledge_base,
        signal: request.signal,
      },
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof AnswerInputError || err instanceof AttachmentError) return jsonError(400, err.message);
    if (err instanceof ConversationNotFoundError) return jsonError(404, err.message);
    if (err instanceof LLMError) {
      if (err.kind === "cancelled") return jsonError(499, err.message);
      if (err.kind === "image_unsupported") return jsonError(400, err.message);
      // Upstream provider failure; the message is already redacted and user-safe.
      return jsonError(502, err.message);
    }
    return internalError("POST /api/ask", err);
  }
});
