import "server-only";
import path from "node:path";
import {
  ATTACHMENT_LIMITS,
  IMAGE_MEDIA_TYPES,
  attachmentKindFromName,
} from "@/lib/attachments";
import type { AttachmentDTO } from "@/lib/types";
import { chunkPages } from "../knowledge/chunker";
import type { Embedder } from "../knowledge/embedder";
import { ExtractionError, extractDocument, sniffImage, type ExtractedDocument } from "../knowledge/extract";
import { dot } from "../knowledge/vector-store";
import type { SourceChunk } from "./citations";

// Files attached to a chat message are TEMPORARY: they are validated, used for this one request and
// discarded. They only reach the knowledge base if the user ticks "Add to Knowledge Base".

export interface IncomingAttachment {
  name: string;
  buffer: Buffer;
  addToKnowledgeBase?: boolean;
}

export interface PreparedImage {
  name: string;
  mediaType: (typeof IMAGE_MEDIA_TYPES)[keyof typeof IMAGE_MEDIA_TYPES];
  data: Buffer;
}

export interface PreparedDocument {
  name: string;
  buffer: Buffer;
  extracted: ExtractedDocument;
  addToKnowledgeBase: boolean;
}

export interface PreparedAttachments {
  images: PreparedImage[];
  documents: PreparedDocument[];
  /** Metadata for every accepted file, in upload order; stored with the user's message. */
  meta: AttachmentDTO[];
}

/** A problem with an attached file that the user can fix (HTTP 400). */
export class AttachmentError extends Error {}

export const EMPTY_ATTACHMENTS: PreparedAttachments = { images: [], documents: [], meta: [] };

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/**
 * Validates and reads attachments on the server. File types are decided by the actual bytes
 * (magic numbers, Office archive contents), never by the browser-sent MIME type.
 */
export async function prepareAttachments(files: IncomingAttachment[]): Promise<PreparedAttachments> {
  if (files.length > ATTACHMENT_LIMITS.maxFiles) {
    throw new AttachmentError(`You can attach up to ${ATTACHMENT_LIMITS.maxFiles} files per message.`);
  }
  const total = files.reduce((sum, f) => sum + f.buffer.length, 0);
  if (total > ATTACHMENT_LIMITS.maxTotalBytes) {
    throw new AttachmentError(`Attachments are too large together (max ${mb(ATTACHMENT_LIMITS.maxTotalBytes)} per message).`);
  }

  const out: PreparedAttachments = { images: [], documents: [], meta: [] };
  const seen = new Set<string>();

  for (const file of files) {
    const name = path.basename(file.name).slice(0, 255) || "attachment";
    const key = `${name}:${file.buffer.length}`;
    if (seen.has(key)) continue; // the same file attached twice
    seen.add(key);

    if (file.buffer.length === 0) throw new AttachmentError(`${name}: the file is empty.`);
    const kind = attachmentKindFromName(name);

    if (kind === "image") {
      if (file.buffer.length > ATTACHMENT_LIMITS.maxImageBytes) {
        throw new AttachmentError(`${name}: images can be at most ${mb(ATTACHMENT_LIMITS.maxImageBytes)}.`);
      }
      const sniffed = sniffImage(file.buffer);
      if (!sniffed) throw new AttachmentError(`${name}: this is not a valid PNG, JPG or WEBP image.`);
      const mediaType = IMAGE_MEDIA_TYPES[sniffed];
      out.images.push({ name, mediaType, data: file.buffer });
      out.meta.push({ name, kind: "image", mediaType, sizeBytes: file.buffer.length });
    } else if (kind === "document") {
      if (file.buffer.length > ATTACHMENT_LIMITS.maxDocumentBytes) {
        throw new AttachmentError(`${name}: documents can be at most ${mb(ATTACHMENT_LIMITS.maxDocumentBytes)}.`);
      }
      let extracted: ExtractedDocument;
      try {
        extracted = await extractDocument(name, file.buffer);
      } catch (err) {
        if (err instanceof ExtractionError) throw new AttachmentError(`${name}: ${err.message}`);
        throw err;
      }
      out.documents.push({ name, buffer: file.buffer, extracted, addToKnowledgeBase: !!file.addToKnowledgeBase });
      out.meta.push({ name, kind: "document", mediaType: extracted.mimeType, sizeBytes: file.buffer.length });
    } else {
      throw new AttachmentError(
        `${name}: unsupported file type. Use PDF, DOCX, TXT, MD, CSV, XLSX, PPTX, PNG, JPG or WEBP.`,
      );
    }
  }
  return out;
}

/** Attachments up to this size are sent in full; larger ones are narrowed to the most relevant chunks. */
export const FULL_TEXT_CHARS = 24_000;
/** Upper bound on chunks sent from large attachments (split across the attached documents). */
export const MAX_ATTACHMENT_CHUNKS = 8;
/** Cap on chunks embedded per request, so a huge attachment can't stall the server. */
const MAX_CHUNKS_TO_EMBED = 1_500;

/**
 * Chooses which parts of the attached documents go into the prompt. Small attachments are sent
 * whole (the user explicitly attached them, so no similarity threshold applies). Large ones are
 * chunked and embedded in memory, and the chunks most similar to the question are kept. Nothing
 * is written to the vector store.
 */
export async function selectAttachmentSources(
  embedder: Embedder,
  question: string,
  documents: PreparedDocument[],
): Promise<SourceChunk[]> {
  const perDoc = documents.map((doc) => ({ doc, chunks: chunkPages(doc.extracted.pages) }));
  const toSource = (doc: PreparedDocument, c: { content: string; pageStart: number | null; pageEnd: number | null }, score: number | null): SourceChunk => ({
    source: "attachment",
    documentId: null,
    filename: doc.name,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    content: c.content,
    score,
  });

  const totalChars = perDoc.reduce((sum, d) => sum + d.chunks.reduce((s, c) => s + c.content.length, 0), 0);
  if (totalChars <= FULL_TEXT_CHARS) {
    return perDoc.flatMap(({ doc, chunks }) => chunks.map((c) => toSource(doc, c, null)));
  }

  const query = await embedder.embedQuery(question);
  const perDocLimit = Math.max(2, Math.floor(MAX_ATTACHMENT_CHUNKS / documents.length));
  const selected: SourceChunk[] = [];
  for (const { doc, chunks } of perDoc) {
    const candidates = chunks.slice(0, MAX_CHUNKS_TO_EMBED);
    const vectors = await embedder.embedDocuments(candidates.map((c) => c.content));
    const best = candidates
      .map((c, i) => ({ c, score: dot(query, vectors[i]!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, perDocLimit)
      .sort((a, b) => a.c.index - b.c.index); // keep document order for readability
    selected.push(...best.map(({ c, score }) => toSource(doc, c, score)));
  }
  return selected;
}

/** Used when the user sends attachments without typing anything. */
export function defaultQuestion(attachments: PreparedAttachments): string {
  if (attachments.documents.length && attachments.images.length) return "Summarize the attached files and describe the attached images.";
  if (attachments.images.length) return attachments.images.length > 1 ? "Describe the attached images." : "Describe the attached image.";
  return attachments.documents.length > 1 ? "Summarize the attached documents." : "Summarize the attached document.";
}
