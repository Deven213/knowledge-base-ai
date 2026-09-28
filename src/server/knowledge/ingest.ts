import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DocumentRepository, type DocumentSource } from "../db/repositories";
import { chunkPages, DEFAULT_CHUNK_OPTIONS, type Chunk, type ChunkOptions } from "./chunker";
import type { Embedder } from "./embedder";
import { ExtractionError, extractDocument, type ExtractedDocument } from "./extract";
import type { VectorStore } from "./vector-store";

export interface IngestDeps {
  db: Database.Database;
  embedder: Embedder;
  vectorStore: VectorStore;
  chunkOptions?: ChunkOptions;
}

export interface IngestResult {
  documentId: string;
  status: "ready" | "failed";
  error: string | null;
}

interface Processed {
  extracted: ExtractedDocument;
  chunks: Chunk[];
  vectors: Float32Array[];
}

/** The one ingestion pipeline: text extraction → chunking → local embeddings (storage is done by the caller). */
async function processFile(deps: IngestDeps, filename: string, buffer: Buffer): Promise<Processed> {
  const extracted = await extractDocument(filename, buffer);
  const chunks = chunkPages(extracted.pages, deps.chunkOptions ?? DEFAULT_CHUNK_OPTIONS);
  if (chunks.length === 0) throw new ExtractionError("No text could be extracted from this file.");
  const vectors = await deps.embedder.embedDocuments(chunks.map((c) => c.content));
  return { extracted, chunks, vectors };
}

function storeChunks(deps: IngestDeps, documentId: string, p: Processed): void {
  deps.vectorStore.addChunks(
    documentId,
    deps.embedder.modelId,
    p.chunks.map((c, i) => ({
      chunkIndex: c.index,
      content: c.content,
      pageStart: c.pageStart,
      pageEnd: c.pageEnd,
      embedding: p.vectors[i]!,
    })),
  );
}

/**
 * Document → text extraction → chunking → local embeddings → vector storage.
 * The document row is recorded first so failures are visible in the UI.
 */
export async function ingestDocument(
  deps: IngestDeps,
  file: { filename: string; buffer: Buffer },
): Promise<IngestResult> {
  const docs = new DocumentRepository(deps.db);
  const documentId = randomUUID();
  docs.create({
    id: documentId,
    filename: file.filename,
    mimeType: "application/octet-stream",
    sizeBytes: file.buffer.length,
  });

  try {
    const processed = await processFile(deps, file.filename, file.buffer);
    // Chunks and the final status are written atomically: a document is never 'ready' with partial chunks.
    deps.db.transaction(() => {
      storeChunks(deps, documentId, processed);
      docs.markReady(documentId, processed.extracted.mimeType, processed.extracted.pageCount, processed.chunks.length);
    })();
    return { documentId, status: "ready", error: null };
  } catch (err) {
    const message =
      err instanceof ExtractionError ? err.message : "Processing failed due to an internal error. Check the server logs.";
    if (!(err instanceof ExtractionError)) console.error("[ingest] unexpected failure", err);
    docs.markFailed(documentId, message);
    return { documentId, status: "failed", error: message };
  }
}

export interface SourceFile {
  /** Name used to detect the file type (its extension), e.g. "page.txt" or "Policy.pdf". */
  filename: string;
  /** Name shown in Documents and citations. */
  displayName: string;
  buffer: Buffer;
  source: DocumentSource;
}

export interface UpsertResult {
  outcome: "added" | "updated" | "skipped" | "failed";
  documentId: string | null;
  message: string | null;
}

export const contentHash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

/**
 * Adds or updates a document that comes from an integration, through the same pipeline as uploads.
 * - Identity is (source type, external ID): syncing again never creates a duplicate.
 * - Unchanged content (same hash, indexed with the current embedding model) is skipped.
 * - Changed content replaces the document's chunks and embeddings in one transaction.
 * - If a new version can't be processed, the existing version is kept.
 */
export async function upsertSourceDocument(deps: IngestDeps, file: SourceFile): Promise<UpsertResult> {
  const docs = new DocumentRepository(deps.db);
  const hash = contentHash(file.buffer);
  const existing = docs.findBySource(file.source.type, file.source.externalId);

  if (existing && existing.content_hash === hash && existing.status === "ready" && existing.embedding_models === deps.embedder.modelId) {
    docs.updateSourceMetadata(existing.id, file.displayName, file.source);
    return { outcome: "skipped", documentId: existing.id, message: "Unchanged" };
  }

  let processed: Processed;
  try {
    processed = await processFile(deps, file.filename, file.buffer);
  } catch (err) {
    const message = err instanceof ExtractionError ? err.message : "Processing failed due to an internal error.";
    if (!(err instanceof ExtractionError)) console.error("[ingest] unexpected failure", err);
    return { outcome: "failed", documentId: existing?.id ?? null, message: existing ? `${message} The previous version was kept.` : message };
  }

  const meta = {
    filename: file.displayName,
    mimeType: processed.extracted.mimeType,
    sizeBytes: file.buffer.length,
    pageCount: processed.extracted.pageCount,
    chunkCount: processed.chunks.length,
    contentHash: hash,
    source: file.source,
  };

  if (existing) {
    deps.db.transaction(() => {
      deps.vectorStore.deleteChunks(existing.id);
      storeChunks(deps, existing.id, processed);
      docs.replaceSourceDocument(existing.id, meta);
    })();
    return { outcome: "updated", documentId: existing.id, message: null };
  }

  const documentId = randomUUID();
  deps.db.transaction(() => {
    docs.createSourceDocument(documentId, meta);
    storeChunks(deps, documentId, processed);
  })();
  return { outcome: "added", documentId, message: null };
}
