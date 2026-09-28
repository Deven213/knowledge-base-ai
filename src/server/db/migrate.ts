import "server-only";
import type Database from "better-sqlite3";

// Ordered, append-only list of migrations. Never edit a shipped migration; add a new one.
const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE documents (
    id          TEXT PRIMARY KEY,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    page_count  INTEGER,
    status      TEXT NOT NULL CHECK (status IN ('processing','ready','failed')),
    error       TEXT,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE chunks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    page_start      INTEGER,
    page_end        INTEGER,
    embedding       BLOB NOT NULL,
    embedding_model TEXT NOT NULL,
    UNIQUE (document_id, chunk_index)
  );
  CREATE INDEX idx_chunks_document ON chunks(document_id);

  CREATE TABLE provider_settings (
    provider       TEXT PRIMARY KEY CHECK (provider IN ('openai','anthropic','gemini')),
    key_ciphertext BLOB,
    key_iv         BLOB,
    key_auth_tag   BLOB,
    key_last4      TEXT,
    model          TEXT,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK ((key_ciphertext IS NULL) = (key_iv IS NULL)
       AND (key_iv IS NULL) = (key_auth_tag IS NULL))
  );
  `,

  /* 2: API keys move to .env only; add app settings and chat history */ `
  CREATE TABLE provider_settings_new (
    provider   TEXT PRIMARY KEY CHECK (provider IN ('openai','anthropic','gemini')),
    model      TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  INSERT INTO provider_settings_new (provider, model, updated_at)
    SELECT provider, model, updated_at FROM provider_settings;
  DROP TABLE provider_settings;  -- removes any previously stored (encrypted) keys
  ALTER TABLE provider_settings_new RENAME TO provider_settings;

  CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

  CREATE TABLE messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content         TEXT NOT NULL,
    citations_json  TEXT,            -- CitationDTO[] for assistant messages
    provider        TEXT,
    model           TEXT,
    no_context      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
  `,

  /* 3: metadata of files attached to chat messages (names, types, sizes; never file contents) */ `
  ALTER TABLE messages ADD COLUMN attachments_json TEXT;
  `,

  /* 4: feature flags (availability of modules; rows are seeded/synced by the feature service) */ `
  CREATE TABLE feature_flags (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    category    TEXT NOT NULL,
    enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    depends_on  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `,

  /* 5: structured (sectioned) assistant answers, rendered from history without regenerating */ `
  ALTER TABLE messages ADD COLUMN structured_json TEXT;
  `,

  /* 6: per-message answer language, saved language versions, and the grounding snapshot */ `
  ALTER TABLE messages ADD COLUMN language TEXT;
  ALTER TABLE messages ADD COLUMN variants_json TEXT;  -- { [language]: { content, structured, provider, model } }
  ALTER TABLE messages ADD COLUMN context_json TEXT;   -- { question, sources, imageNames }: what the answer was grounded in
  `,

  /* 7: Sync Integrations (connections, encrypted credentials, OAuth state, sync runs, document sources) */ `
  CREATE TABLE integration_connections (
    id                 TEXT PRIMARY KEY,
    type               TEXT NOT NULL CHECK (type IN ('website','google_drive','onedrive')),
    name               TEXT NOT NULL,
    enabled            INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    status             TEXT NOT NULL CHECK (status IN ('not_connected','connected','syncing','success','error','disabled')),
    configuration_json TEXT NOT NULL DEFAULT '{}',
    account_label      TEXT,             -- e.g. the connected Google/Microsoft account email (not a secret)
    last_error         TEXT,             -- user-facing message
    last_sync_at       TEXT,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- OAuth tokens, AES-256-GCM encrypted (INTEGRATIONS_ENCRYPTION_KEY). Never returned by any API.
  CREATE TABLE integration_credentials (
    integration_id TEXT PRIMARY KEY REFERENCES integration_connections(id) ON DELETE CASCADE,
    ciphertext     BLOB NOT NULL,
    iv             BLOB NOT NULL,
    auth_tag       BLOB NOT NULL,
    updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  -- Pending OAuth authorizations (state + PKCE verifier), valid for a few minutes.
  CREATE TABLE oauth_states (
    state          TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    code_verifier  TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE integration_sync_runs (
    id             TEXT PRIMARY KEY,
    integration_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('running','success','partial','error')),
    started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at   TEXT,
    files_found    INTEGER NOT NULL DEFAULT 0,
    files_added    INTEGER NOT NULL DEFAULT 0,
    files_updated  INTEGER NOT NULL DEFAULT 0,
    files_skipped  INTEGER NOT NULL DEFAULT 0,
    files_failed   INTEGER NOT NULL DEFAULT 0,
    error_message  TEXT,
    details_json   TEXT                -- per-item results: [{ name, url, outcome, message }]
  );
  CREATE INDEX idx_sync_runs_integration ON integration_sync_runs(integration_id, started_at DESC);

  -- Where a document came from, for re-sync, update detection and duplicate prevention.
  ALTER TABLE documents ADD COLUMN source_type TEXT;          -- NULL/'upload' | 'website' | 'google_drive' | 'onedrive'
  ALTER TABLE documents ADD COLUMN source_url TEXT;
  ALTER TABLE documents ADD COLUMN source_external_id TEXT;   -- normalized URL / Drive file ID / OneDrive item ID
  ALTER TABLE documents ADD COLUMN integration_id TEXT;       -- no FK: documents outlive integrations
  ALTER TABLE documents ADD COLUMN content_hash TEXT;         -- sha256 of the fetched bytes
  ALTER TABLE documents ADD COLUMN source_modified_at TEXT;
  CREATE UNIQUE INDEX idx_documents_source ON documents(source_type, source_external_id) WHERE source_external_id IS NOT NULL;
  `,

  /* 8: "Chat with" knowledge scope per conversation (NULL = older chats = All Knowledge Base) */ `
  ALTER TABLE conversations ADD COLUMN knowledge_scope_json TEXT;
  `,

  /* 9: Sign-in sessions. Only a SHA-256 hash of each session token is stored; the token itself
     lives in the browser's httpOnly cookie. Deleting a row ends that session immediately. */ `
  CREATE TABLE auth_sessions (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
  `,
];

export function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
