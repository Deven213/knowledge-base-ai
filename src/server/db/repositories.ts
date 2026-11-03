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

/**
 * One organization's documents. The organization is fixed when the repository is created and every
 * statement filters on it, so a document of another organization can't be listed, read, changed or
 * deleted through this class, whatever ID it is given. (A repository can't be built without an org.)
 */
export class DocumentRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
  ) {
    if (!orgId) throw new Error("DocumentRepository needs an organization.");
  }

  create(doc: { id: string; filename: string; mimeType: string; sizeBytes: number }): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, status)
         VALUES (@id, @orgId, @filename, @mimeType, @sizeBytes, 'processing')`,
      )
      .run({ ...doc, orgId: this.orgId });
  }

  markReady(id: string, mimeType: string, pageCount: number | null, chunkCount: number): void {
    this.db
      .prepare(
        `UPDATE documents SET status = 'ready', error = NULL, mime_type = ?, page_count = ?, chunk_count = ?
         WHERE id = ? AND org_id = ?`,
      )
      .run(mimeType, pageCount, chunkCount, id, this.orgId);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare(`UPDATE documents SET status = 'failed', error = ? WHERE id = ? AND org_id = ?`).run(error, id, this.orgId);
  }

  private static readonly SELECT = `
    SELECT d.*,
           (SELECT group_concat(DISTINCT c.embedding_model) FROM chunks c WHERE c.document_id = d.id)
             AS embedding_models
    FROM documents d`;

  list(): DocumentRow[] {
    return this.db.prepare(`${DocumentRepository.SELECT} WHERE d.org_id = ? ORDER BY d.created_at DESC`).all(this.orgId) as DocumentRow[];
  }

  get(id: string): DocumentRow | undefined {
    return this.db.prepare(`${DocumentRepository.SELECT} WHERE d.org_id = ? AND d.id = ?`).get(this.orgId, id) as DocumentRow | undefined;
  }

  /** Which of these IDs are this organization's documents (any other ID, including another customer's, is simply absent). */
  existingIds(ids: string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT id FROM documents WHERE org_id = ? AND id IN (${ids.map(() => "?").join(",")})`)
      .all(this.orgId, ...ids) as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  /** Deletes the document; its chunks are removed by ON DELETE CASCADE. */
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM documents WHERE id = ? AND org_id = ?`).run(id, this.orgId).changes > 0;
  }

  /**
   * Removes every document whose status is 'failed' and returns their IDs.
   *
   * This is one atomic statement, so the status is checked at the moment of deletion: a document that
   * has since become 'ready' (for example an integration re-sync repairing it) or is 'processing' is
   * never touched, however stale the caller's view of the list is. The documents' chunks go with them
   * (ON DELETE CASCADE); nothing else references a document, and original files are not stored.
   */
  deleteFailed(): string[] {
    const rows = this.db.prepare(`DELETE FROM documents WHERE status = 'failed' AND org_id = ? RETURNING id`).all(this.orgId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Opening chunk of the most recent ready documents, used to suggest starter questions. */
  sampleExcerpts(embeddingModel: string, maxDocs: number): { documentId: string; filename: string; content: string }[] {
    return this.db
      .prepare(
        `SELECT d.id AS documentId, d.filename, c.content
         FROM documents d
         JOIN chunks c ON c.document_id = d.id AND c.chunk_index = 0 AND c.embedding_model = ? AND c.org_id = d.org_id
         WHERE d.org_id = ? AND d.status = 'ready'
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(embeddingModel, this.orgId, maxDocs) as { documentId: string; filename: string; content: string }[];
  }

  stats(): { total: number; ready: number; failed: number; chunks: number; bytes: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(status = 'ready'), 0) AS ready,
                COALESCE(SUM(status = 'failed'), 0) AS failed,
                COALESCE(SUM(chunk_count), 0) AS chunks,
                COALESCE(SUM(size_bytes), 0) AS bytes
         FROM documents WHERE org_id = ?`,
      )
      .get(this.orgId) as { total: number; ready: number; failed: number; chunks: number; bytes: number };
  }

  // ── Documents imported by integrations ──

  findBySource(type: string, externalId: string): DocumentRow | undefined {
    return this.db
      .prepare(`${DocumentRepository.SELECT} WHERE d.org_id = ? AND d.source_type = ? AND d.source_external_id = ?`)
      .get(this.orgId, type, externalId) as DocumentRow | undefined;
  }

  createSourceDocument(id: string, m: SourceDocumentMeta): void {
    this.db
      .prepare(
        `INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, page_count, status, chunk_count,
                                source_type, source_url, source_external_id, integration_id, content_hash, source_modified_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, this.orgId, m.filename, m.mimeType, m.sizeBytes, m.pageCount, m.chunkCount, m.source.type, m.source.url, m.source.externalId, m.source.integrationId, m.contentHash, m.source.modifiedAt ?? null);
  }

  /** New content for an existing imported document (its chunks are replaced by the caller in the same transaction). */
  replaceSourceDocument(id: string, m: SourceDocumentMeta): void {
    this.db
      .prepare(
        `UPDATE documents SET filename = ?, mime_type = ?, size_bytes = ?, page_count = ?, status = 'ready', error = NULL,
                chunk_count = ?, source_url = ?, integration_id = ?, content_hash = ?, source_modified_at = ?
         WHERE id = ? AND org_id = ?`,
      )
      .run(m.filename, m.mimeType, m.sizeBytes, m.pageCount, m.chunkCount, m.source.url, m.source.integrationId, m.contentHash, m.source.modifiedAt ?? null, id, this.orgId);
  }

  /** Content unchanged: keep chunks, refresh the name/URL shown. */
  updateSourceMetadata(id: string, filename: string, source: DocumentSource): void {
    this.db
      .prepare(`UPDATE documents SET filename = ?, source_url = ?, integration_id = ?, source_modified_at = COALESCE(?, source_modified_at) WHERE id = ? AND org_id = ?`)
      .run(filename, source.url, source.integrationId, source.modifiedAt ?? null, id, this.orgId);
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

/** How a saved language version came to be, so it is only reused while it is still valid. */
export interface VariantMeta {
  /** original = what retrieval and the model first answered; translation = translated from the original; regeneration = re-answered from the passages; fixed = a standard "not found" text. */
  method: "original" | "translation" | "regeneration" | "fixed";
  /** Translation logic version (src/server/rag/translation.ts) the version was made with. */
  version?: number;
  /** Hash of the original text it was translated from. */
  sourceHash?: string;
  at: string;
}

/** One language version of an assistant answer. Versions saved before `meta` existed have none and stay valid. */
export interface AnswerVariant {
  content: string;
  structured: AIResponse | null;
  provider: ProviderId | null;
  model: string | null;
  meta?: VariantMeta;
}

/**
 * One person's conversations inside one organization. Chats are private to their author: another member
 * of the same organization, and anyone in another organization, can't list, read, change or delete them,
 * and can't reach their messages by message ID either.
 */
export class ConversationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
    private readonly userId: string,
  ) {
    if (!orgId || !userId) throw new Error("ConversationRepository needs an organization and a user.");
  }

  private static readonly SELECT = `
    SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
    FROM conversations c`;

  /** `AND` condition + parameters that restrict a query to this user's conversations (alias `c`). */
  private get own(): { sql: string; params: [string, string] } {
    return { sql: "c.org_id = ? AND c.user_id = ?", params: [this.orgId, this.userId] };
  }

  list(search?: string): ConversationRow[] {
    const { sql, params } = this.own;
    if (search?.trim()) {
      // Escape LIKE wildcards so the search is literal.
      const like = `%${search.trim().replace(/[!%_]/g, (m) => "!" + m)}%`;
      return this.db
        .prepare(
          `${ConversationRepository.SELECT}
           WHERE ${sql}
             AND (c.title LIKE ? ESCAPE '!'
                  OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '!'))
           ORDER BY c.updated_at DESC LIMIT 200`,
        )
        .all(...params, like, like) as ConversationRow[];
    }
    return this.db
      .prepare(`${ConversationRepository.SELECT} WHERE ${sql} ORDER BY c.updated_at DESC LIMIT 200`)
      .all(...params) as ConversationRow[];
  }

  get(id: string): ConversationRow | undefined {
    const { sql, params } = this.own;
    return this.db.prepare(`${ConversationRepository.SELECT} WHERE ${sql} AND c.id = ?`).get(...params, id) as ConversationRow | undefined;
  }

  messages(conversationId: string): MessageRow[] {
    const { sql, params } = this.own;
    return this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE ${sql} AND m.conversation_id = ? ORDER BY m.created_at, m.rowid`,
      )
      .all(...params, conversationId) as MessageRow[];
  }

  create(title: string, knowledgeScope?: KnowledgeScope | null): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO conversations (id, org_id, user_id, title, knowledge_scope_json) VALUES (?, ?, ?, ?, ?)`)
      .run(id, this.orgId, this.userId, title, knowledgeScope ? JSON.stringify(knowledgeScope) : null);
    return id;
  }

  /** Changes which data this conversation searches (an explicit user choice). */
  setKnowledgeScope(id: string, knowledgeScope: KnowledgeScope): boolean {
    return (
      this.db
        .prepare(`UPDATE conversations SET knowledge_scope_json = ? WHERE id = ? AND org_id = ? AND user_id = ?`)
        .run(JSON.stringify(knowledgeScope), id, this.orgId, this.userId).changes > 0
    );
  }

  /** Appends messages in order and bumps the conversation's updated_at, atomically. Throws if it isn't this user's conversation. */
  addMessages(conversationId: string, messages: NewMessage[]): MessageRow[] {
    const insert = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, citations_json, attachments_json, structured_json, provider, model, no_context,
                             language, variants_json, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    this.db.transaction(() => {
      if (!this.get(conversationId)) throw new Error("Conversation not found.");
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
            ? JSON.stringify({ [m.language]: { content: m.content, structured: m.structured ?? null, provider: m.provider ?? null, model: m.model ?? null, meta: { method: "original", at: new Date().toISOString() } } })
            : null,
          m.context === undefined ? null : JSON.stringify(m.context),
        );
      }
      this.db
        .prepare(`UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND org_id = ? AND user_id = ?`)
        .run(conversationId, this.orgId, this.userId);
    })();
    return ids.map((id) => this.getMessage(id)!);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM conversations WHERE id = ? AND org_id = ? AND user_id = ?`).run(id, this.orgId, this.userId).changes > 0;
  }

  /** A message of one of this user's conversations; any other message ID (including another customer's) is simply absent. */
  getMessage(id: string): MessageRow | undefined {
    const { sql, params } = this.own;
    return this.db
      .prepare(`SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${sql} AND m.id = ?`)
      .get(...params, id) as MessageRow | undefined;
  }

  /** The user message that an assistant message answers (the latest user message before it). */
  questionFor(message: MessageRow): MessageRow | undefined {
    const { sql, params } = this.own;
    return this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE ${sql} AND m.conversation_id = ? AND m.role = 'user'
           AND m.rowid < (SELECT rowid FROM messages WHERE id = ?)
         ORDER BY m.rowid DESC LIMIT 1`,
      )
      .get(...params, message.conversation_id, message.id) as MessageRow | undefined;
  }

  /**
   * Saves language versions of an assistant message WITHOUT changing which one is shown, so a finished translation is kept
   * even if the person has already moved on to another language. Existing versions are kept unless `replace` is set, and
   * the message's first saved version stays first (it is the original). Read and written in one transaction, so two
   * translations finishing together can't overwrite each other.
   */
  saveVariants(id: string, entries: Record<string, AnswerVariant>, mode: "add-missing" | "replace" = "replace"): void {
    this.db.transaction(() => {
      const row = this.getMessage(id);
      if (!row) throw new Error("Message not found.");
      const saved = row.variants_json ? (JSON.parse(row.variants_json) as Record<string, AnswerVariant>) : {};
      const merged = { ...saved };
      for (const [language, variant] of Object.entries(entries)) if (mode === "replace" || !(language in merged)) merged[language] = variant;
      this.db
        .prepare(`UPDATE messages SET variants_json = ? WHERE id = ? AND conversation_id IN (SELECT id FROM conversations WHERE org_id = ? AND user_id = ?)`)
        .run(JSON.stringify(merged), id, this.orgId, this.userId);
    })();
  }

  /** Shows a saved language version in place (same message, same citations). Throws if that version isn't saved. */
  selectVariant(id: string, language: string): MessageRow {
    return this.db.transaction(() => {
      const row = this.getMessage(id);
      const variant = row?.variants_json ? (JSON.parse(row.variants_json) as Record<string, AnswerVariant>)[language] : undefined;
      if (!row || !variant) throw new Error("Message not found.");
      this.db
        .prepare(
          `UPDATE messages SET language = ?, content = ?, structured_json = ?, provider = ?, model = ?
           WHERE id = ? AND conversation_id IN (SELECT id FROM conversations WHERE org_id = ? AND user_id = ?)`,
        )
        .run(language, variant.content, variant.structured ? JSON.stringify(variant.structured) : null, variant.provider, variant.model, id, this.orgId, this.userId);
      return this.getMessage(id)!;
    })();
  }

  /** Totals for the whole organization (numbers only, no content), shown on the dashboard. */
  counts(): { conversations: number; questions: number } {
    return this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM conversations WHERE org_id = @org) AS conversations,
                (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.org_id = @org AND m.role = 'user') AS questions`,
      )
      .get({ org: this.orgId }) as { conversations: number; questions: number };
  }
}

// ── Per-organization settings ────────────────────────────────────────────────

/** Key/value settings that belong to one organization (for example its cached suggested questions). */
export class OrgSettingsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
  ) {
    if (!orgId) throw new Error("OrgSettingsRepository needs an organization.");
  }

  get(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM org_settings WHERE org_id = ? AND key = ?`).get(this.orgId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO org_settings (org_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .run(this.orgId, key, value);
  }
}
