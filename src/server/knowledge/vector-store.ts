import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface StoredChunkInput {
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  embedding: Float32Array;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
  score: number;
}

export interface SearchOptions {
  topK: number;
  minScore: number;
  /** Only vectors produced by this model are comparable with the query. */
  embeddingModel: string;
  /** Restrict to these documents; undefined or empty means all ready documents. */
  documentIds?: string[];
}

/** Storage and similarity search over chunk embeddings. Swap this for pgvector later. */
export interface VectorStore {
  addChunks(documentId: string, embeddingModel: string, chunks: StoredChunkInput[]): void;
  /** Removes a document's chunks (before re-indexing new content for it). */
  deleteChunks(documentId: string): void;
  search(query: Float32Array, options: SearchOptions): SearchHit[];
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function fromBlob(b: Buffer): Float32Array {
  // Copy into an aligned buffer; SQLite blobs are not guaranteed 4-byte aligned.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** Vectors are L2-normalised, so the dot product equals cosine similarity. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector size mismatch: ${a.length} vs ${b.length}`);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

/**
 * Brute-force cosine search over SQLite BLOBs. Exact, simple, and fast enough
 * for tens of thousands of chunks, which is the scale of this MVP.
 *
 * A store belongs to ONE organization, fixed when it is created: it only writes chunks for that
 * organization and only ever searches that organization’s chunks, so one customer’s question can never
 * retrieve another customer’s text, whatever document IDs it supplies. (A store can’t be built without an org.)
 */
export class SqliteVectorStore implements VectorStore {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
  ) {
    if (!orgId) throw new Error("SqliteVectorStore needs an organization.");
  }

  addChunks(documentId: string, embeddingModel: string, chunks: StoredChunkInput[]): void {
    const insert = this.db.prepare(
      `INSERT INTO chunks (id, org_id, document_id, chunk_index, content, page_start, page_end, embedding, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const c of chunks) {
        insert.run(
          randomUUID(),
          this.orgId,
          documentId,
          c.chunkIndex,
          c.content,
          c.pageStart,
          c.pageEnd,
          toBlob(c.embedding),
          embeddingModel,
        );
      }
    })();
  }

  deleteChunks(documentId: string): void {
    this.db.prepare(`DELETE FROM chunks WHERE document_id = ? AND org_id = ?`).run(documentId, this.orgId);
  }

  search(query: Float32Array, options: SearchOptions): SearchHit[] {
    const params: unknown[] = [this.orgId, this.orgId, options.embeddingModel];
    let filter = "";
    if (options.documentIds && options.documentIds.length > 0) {
      filter = `AND c.document_id IN (${options.documentIds.map(() => "?").join(",")})`;
      params.push(...options.documentIds);
    }

    const rows = this.db
      .prepare(
        `SELECT c.id, c.document_id, c.chunk_index, c.content, c.page_start, c.page_end, c.embedding, d.filename
         FROM chunks c JOIN documents d ON d.id = c.document_id
         WHERE c.org_id = ? AND d.org_id = ? AND d.status = 'ready' AND c.embedding_model = ? ${filter}`,
      )
      .all(...params) as {
      id: string;
      document_id: string;
      chunk_index: number;
      content: string;
      page_start: number | null;
      page_end: number | null;
      embedding: Buffer;
      filename: string;
    }[];

    const hits: SearchHit[] = [];
    for (const r of rows) {
      const score = dot(query, fromBlob(r.embedding));
      if (score < options.minScore) continue;
      hits.push({
        chunkId: r.id,
        documentId: r.document_id,
        filename: r.filename,
        chunkIndex: r.chunk_index,
        content: r.content,
        pageStart: r.page_start,
        pageEnd: r.page_end,
        score,
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, options.topK);
  }
}
