import "server-only";
import { parseAIResponse } from "@/lib/ai-response";
import { parseKnowledgeScope } from "@/lib/knowledge-scope";
import type { AttachmentDTO, CitationDTO, ConversationSummaryDTO, DocumentDTO, MessageDTO } from "@/lib/types";
import type { ConversationRow, DocumentRow, MessageRow } from "./db/repositories";

export function toDocumentDTO(row: DocumentRow, currentEmbeddingModel: string): DocumentDTO {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    status: row.status,
    error: row.error,
    chunkCount: row.chunk_count,
    indexCurrent: row.status !== "ready" || row.embedding_models === currentEmbeddingModel,
    source:
      row.source_type === "website" || row.source_type === "google_drive" || row.source_type === "onedrive"
        ? { type: row.source_type, url: row.source_url, integrationId: row.integration_id }
        : null,
    createdAt: row.created_at,
  };
}

function parseJsonArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

/** Stored structured answers are re-validated on read; anything invalid falls back to plain text. */
function parseStructured(json: string | null) {
  if (!json) return null;
  try {
    return parseAIResponse(JSON.parse(json));
  } catch {
    return null;
  }
}

export function toMessageDTO(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    citations: parseJsonArray<CitationDTO>(row.citations_json),
    attachments: parseJsonArray<AttachmentDTO>(row.attachments_json),
    structured: parseStructured(row.structured_json),
    language: row.language ?? parseStructured(row.structured_json)?.language ?? "en",
    provider: row.provider,
    model: row.model,
    noContext: row.no_context === 1,
    createdAt: row.created_at,
  };
}

export function toConversationSummaryDTO(row: ConversationRow): ConversationSummaryDTO {
  return {
    id: row.id,
    title: row.title,
    knowledgeScope: row.knowledge_scope_json ? parseKnowledgeScope(safeJson(row.knowledge_scope_json)) : null,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
