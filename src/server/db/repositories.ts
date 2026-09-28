import "server-only";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AIResponse } from "@/lib/ai-response";
import type { KnowledgeScope } from "@/lib/knowledge-scope";
import type { AttachmentDTO, CitationDTO, DocumentStatus, ProviderId } from "@/lib/types";

// ── Documents ────────────────────────────────────────────────────────────────

export interface DocumentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  created_at: string;
  /** Distinct embedding models used by this document's chunks (comma-separated), if any. */
  embedding_models: string | null;
  /** Where the document came from (NULL = uploaded). */
  source_type: string | null;
  source_url: string | null;
  source_external_id: string | null;
  integration_id: string | null;
  content_hash: string | null;
  source_modified_at: string | null;
}

/** Identity and origin of a document imported by an integration. */
export interface DocumentSource {
  type: "website" | "google_drive" | "onedrive";
  /** Normalized URL (website) or the provider's file ID. */
  externalId: string;
  url: string | null;
  integrationId: string;
  modifiedAt?: string | null;
}

interface SourceDocumentMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  chunkCount: number;
  contentHash: string;
  source: DocumentSource;
}

export class DocumentRepository {
  constructor(private readonly db: Database.Database) {}

  create(doc: { id: string; filename: string; mimeType: string; sizeBytes: number }): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, filename, mime_type, size_bytes, status)
         VALUES (@id, @filename, @mimeType, @sizeBytes, 'processing')`,
      )
      .run(doc);
  }

  markReady(id: string, mimeType: string, pageCount: number | null, chunkCount: number): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'ready', error = NULL, mime_type = ?, page_count = ?, chunk_count = ?
         WHERE id = ?`,
      )
      .run(mimeType, pageCount, chunkCount, id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare(`UPDATE documents SET status = 'failed', error = ? WHERE id = ?`).run(error, id);
  }

  private static readonly SELECT = `
    SELECT d.*,
           (SELECT group_concat(DISTINCT c.embedding_model) FROM chunks c WHERE c.document_id = d.id)
             AS embedding_models
    FROM documents d`;

  list(): DocumentRow[] {
    return this.db.prepare(`${DocumentRepository.SELECT} ORDER BY d.created_at DESC`).all() as DocumentRow[];
  }

  get(id: string): DocumentRow | undefined {
    return this.db.prepare(`${DocumentRepository.SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
  }

  /** Deletes the document; its chunks are removed by ON DELETE CASCADE. */
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id).changes > 0;
  }

  /** Opening chunk of the most recent ready documents, used to suggest starter questions. */
  sampleExcerpts(embeddingModel: string, maxDocs: number): { documentId: string; filename: string; content: string }[] {
    return this.db
      .prepare(
        `SELECT d.id AS documentId, d.filename, c.content
         FROM documents d
         JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0 AND c.embedding_model = ?
         WHERE d.status = 'ready'
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(embeddingModel, maxDocs) as { documentId: string; filename: string; content: string }[];
  }

  stats(): { total: number; ready: number; failed: number; chunks: number; bytes: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'ready'), 0) AS ready,
                COALESCE(SUM(status = 'failed'), 0) AS failed,
                COALESCE(SUM(chunk_count), 0) AS chunks,
                COALESCE(SUM(size_bytes), 0) AS bytes
         FROM documents`,
      )
      .get() as { total: number; ready: number; failed: number; chunks: number; bytes: number };
  }

  // ── Documents imported by integrations ──

  findBySource(type: string, externalId: string): DocumentRow | undefined {
    return this.db
      .prepare(`${DocumentRepository.SELECT} WHERE d.source_type = ? AND d.source_external_id = ?`)
      .get(type, externalId) as DocumentRow | undefined;
  }

  createSourceDocument(id: string, m: SourceDocumentMeta): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, filename, mime_type, size_bytes, page_count, status, chunk_count,
                                source_type, source_url, source_external_id, integration_id, content_hash, source_modified_at)
         VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, m.filename, m.mimeType, m.sizeBytes, m.pageCount, m.chunkCount, m.source.type, m.source.url, m.source.externalId, m.source.integrationId, m.contentHash, m.source.modifiedAt ?? null);
  }

  /** New content for an existing imported document (its chunks are replaced by the caller in the same transaction). */
  replaceSourceDocument(id: string, m: SourceDocumentMeta): void {
    this.db
      .prepare(
        `UPDATE documents SET filename = ?, mime_type = ?, size_bytes = ?, page_count = ?, status = 'ready', error = NULL,
                chunk_count = ?, source_url = ?, integration_id = ?, content_hash = ?, source_modified_at = ?
         WHERE id = ?`,
      )
      .run(m.filename, m.mimeType, m.sizeBytes, m.pageCount, m.chunkCount, m.source.url, m.source.integrationId, m.contentHash, m.source.modifiedAt ?? null, id);
  }

  /** Content unchanged: keep chunks, refresh the name/URL shown. */
  updateSourceMetadata(id: string, filename: string, source: DocumentSource): void {
    this.db
      .prepare(`UPDATE documents SET filename = ?, source_url = ?, integration_id = ?, source_modified_at = COALESCE(?, source_modified_at) WHERE id = ?`)
      .run(filename, source.url, source.integrationId, source.modifiedAt ?? null, id);
  }

  /** Documents left in 'processing' by a crash or restart can never finish. */
  failStaleProcessing(): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'failed', error = 'Processing was interrupted. Please upload the file again.'
         WHERE status = 'processing'`,
      )
      .run();
  }
}

// ── Provider settings (model overrides only; API keys live in .env) ─────────

export class ProviderSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  getModel(provider: ProviderId): string | null {
    const row = this.db.prepare(`SELECT model FROM provider_settings WHERE provider = ?`).get(provider) as
      | { model: string | null }
      | undefined;
    return row?.model ?? null;
  }

  /** `null` clears the UI override so the env value (if any) applies. */
  saveModel(provider: ProviderId, model: string | null): void {
    this.db
      .prepare(
        `INSERT INTO provider_settings (provider, model) VALUES (?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           model = excluded.model,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(provider, model);
  }
}

// ── App settings (small key/value store) ─────────────────────────────────────

export class AppSettingsRepository {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(key, value);
  }
}

// ── Conversations & messages ─────────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  title: string;
  /** KnowledgeScope JSON ("Chat with"); null = All Knowledge Base. */
  knowledge_scope_json: string | null;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  citations_json: string | null;
  attachments_json: string | null;
  structured_json: string | null;
  provider: ProviderId | null;
  model: string | null;
  no_context: number;
  created_at: string;
  language: string | null;
  variants_json: string | null;
  context_json: string | null;
}

export interface NewMessage {
  role: "user" | "assistant";
  content: string;
  citations?: CitationDTO[];
  attachments?: AttachmentDTO[];
  structured?: AIResponse | null;
  provider?: ProviderId | null;
  model?: string | null;
  noContext?: boolean;
  /** Assistant messages: answer language, and the grounding snapshot used for language changes. */
  language?: string | null;
  context?: unknown;
}

/** One language version of an assistant answer. */
export interface AnswerVariant {
  content: string;
  structured: AIResponse | null;
  provider: ProviderId | null;
  model: string | null;
}

export class ConversationRepository {
  constructor(private readonly db: Database.Database) {}

  private static readonly SELECT = `
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c`;

  list(search?: string): ConversationRow[] {
    if (search?.trim()) {
      // Escape LIKE wildcards so the search is literal.
      const like = `%${search.trim().replace(/[!%_]/g, (m) => "!" + m)}%`;
      return this.db
        .prepare(
          `${ConversationRepository.SELECT}
           WHERE c.title LIKE ? ESCAPE '!'
              OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '!')
           ORDER BY c.updated_at DESC LIMIT 200`,
        )
        .all(like, like) as ConversationRow[];
    }
    return this.db
      .prepare(`${ConversationRepository.SELECT} ORDER BY c.updated_at DESC LIMIT 200`)
      .all() as ConversationRow[];
  }

  get(id: string): ConversationRow | undefined {
    return this.db.prepare(`${ConversationRepository.SELECT} WHERE c.id = ?`).get(id) as ConversationRow | undefined;
  }

  messages(conversationId: string): MessageRow[] {
    return this.db
      .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid`)
      .all(conversationId) as MessageRow[];
  }

  create(title: string, knowledgeScope?: KnowledgeScope | null): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO conversations (id, title, knowledge_scope_json) VALUES (?, ?, ?)`)
      .run(id, title, knowledgeScope ? JSON.stringify(knowledgeScope) : null);
    return id;
  }

  /** Changes which data this conversation searches (an explicit user choice). */
  setKnowledgeScope(id: string, knowledgeScope: KnowledgeScope): boolean {
    return this.db.prepare(`UPDATE conversations SET knowledge_scope_json = ? WHERE id = ?`).run(JSON.stringify(knowledgeScope), id).changes > 0;
  }

  /** Appends messages in order and bumps the conversation's updated_at, atomically. */
  addMessages(conversationId: string, messages: NewMessage[]): MessageRow[] {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, citations_json, attachments_json, structured_json, provider, model, no_context,
                             language, variants_json, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    this.db.transaction(() => {
      for (const m of messages) {
        const id = randomUUID();
        ids.push(id);
        insert.run(
          id,
          conversationId,
          m.role,
          m.content,
          m.citations ? JSON.stringify(m.citations) : null,
          m.attachments?.length ? JSON.stringify(m.attachments) : null,
          m.structured ? JSON.stringify(m.structured) : null,
          m.provider ?? null,
          m.model ?? null,
          m.noContext ? 1 : 0,
          m.language ?? null,
          // The first language version is the answer itself; others are added when the language changes.
          m.role === "assistant" && m.language
            ? JSON.stringify({ [m.language]: { content: m.content, structured: m.structured ?? null, provider: m.provider ?? null, model: m.model ?? null } })
            : null,
          m.context === undefined ? null : JSON.stringify(m.context),
        );
      }
      this.db
        .prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(conversationId);
    })();
    const get = this.db.prepare(`SELECT * FROM messages WHERE id = ?`);
    return ids.map((id) => get.get(id) as MessageRow);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id).changes > 0;
  }

  getMessage(id: string): MessageRow | undefined {
    return this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
  }

  /** The user message that an assistant message answers (the latest user message before it). */
  questionFor(message: MessageRow): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE conversation_id = ? AND role = 'user' AND rowid < (SELECT rowid FROM messages WHERE id = ?)
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(message.conversation_id, message.id) as MessageRow | undefined;
  }

  /**
   * Shows another language version of an assistant message, in place (same message, same citations).
   * `variants` is the full set of saved versions, including the one being shown.
   */
  setAnswerLanguage(id: string, language: string, variant: AnswerVariant, variants: Record<string, AnswerVariant>): MessageRow {
    this.db
      .prepare(
        `UPDATE messages SET language = ?, content = ?, structured_json = ?, provider = ?, model = ?, variants_json = ? WHERE id = ?`,
      )
      .run(
        language,
        variant.content,
        variant.structured ? JSON.stringify(variant.structured) : null,
        variant.provider,
        variant.model,
        JSON.stringify(variants),
        id,
      );
    return this.getMessage(id)!;
  }

  counts(): { conversations: number; questions: number } {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM conversations) AS conversations,
                (SELECT COUNT(*) FROM messages WHERE role = 'user') AS questions`,
      )
      .get() as { conversations: number; questions: number };
  }
}
