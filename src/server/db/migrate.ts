import "server-only";
import type Database from "better-sqlite3";
import { LEGACY_ORG_ID, LEGACY_ORG_NAME, LEGACY_ORG_SLUG } from "./constants";

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

  /* 10: multi-tenancy. Users, organizations (workspaces), memberships with roles and invitations; every
     piece of customer data gets an owning organization. All existing data is adopted by one "Default
     workspace" (no rows are deleted). Existing sessions are removed, so everyone signs in again.
     Isolation is enforced three ways: the application scopes every query by organization, these triggers
     make a missing or mismatched organization impossible to store, and the tests prove it. */ `
  CREATE TABLE users (
    id                TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash     TEXT NOT NULL,             -- "scrypt$N$r$p$salt$hash"; never the password
    display_name      TEXT,
    is_platform_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_platform_admin IN (0, 1)),
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_login_at     TEXT
  );

  CREATE TABLE organizations (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE memberships (
    org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (org_id, user_id)
  );
  CREATE INDEX idx_memberships_user ON memberships(user_id);

  -- Single-use invitation links. Only a hash of the token is stored; an invitation can never grant 'owner'.
  CREATE TABLE invitations (
    id          TEXT PRIMARY KEY,
    org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email       TEXT NOT NULL COLLATE NOCASE,
    role        TEXT NOT NULL CHECK (role IN ('admin','member','viewer')),
    token_hash  TEXT NOT NULL UNIQUE,
    invited_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,
    accepted_at TEXT,
    revoked_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_invitations_org ON invitations(org_id);

  -- Per-organization key/value settings (app_settings stays for platform-wide values).
  CREATE TABLE org_settings (
    org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (org_id, key)
  );

  INSERT INTO organizations (id, name, slug) VALUES ('${LEGACY_ORG_ID}', '${LEGACY_ORG_NAME}', '${LEGACY_ORG_SLUG}');

  -- Owning organization for every tenant table. (SQLite can only add a REFERENCES column as nullable;
  -- the triggers below make NULL impossible for new rows.)
  ALTER TABLE documents ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
  ALTER TABLE chunks ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
  ALTER TABLE conversations ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
  ALTER TABLE conversations ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;  -- author; chats are private to them
  ALTER TABLE integration_connections ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;

  UPDATE documents SET org_id = '${LEGACY_ORG_ID}';
  UPDATE chunks SET org_id = (SELECT d.org_id FROM documents d WHERE d.id = chunks.document_id);
  UPDATE conversations SET org_id = '${LEGACY_ORG_ID}';   -- user_id stays NULL until the owner is created (see bootstrap)
  UPDATE integration_connections SET org_id = '${LEGACY_ORG_ID}';

  -- A page or file is unique per organization, not across all customers.
  DROP INDEX idx_documents_source;
  CREATE UNIQUE INDEX idx_documents_source ON documents(org_id, source_type, source_external_id) WHERE source_external_id IS NOT NULL;
  CREATE INDEX idx_documents_org ON documents(org_id, created_at DESC);
  CREATE INDEX idx_chunks_org_model ON chunks(org_id, embedding_model);
  CREATE INDEX idx_conversations_org_user ON conversations(org_id, user_id, updated_at DESC);
  CREATE UNIQUE INDEX idx_integrations_org_type ON integration_connections(org_id, type);

  -- Database-level guarantees (defence in depth: they hold even if application code is wrong).
  CREATE TRIGGER trg_documents_org_required BEFORE INSERT ON documents WHEN NEW.org_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'documents.org_id is required'); END;
  CREATE TRIGGER trg_documents_org_immutable BEFORE UPDATE OF org_id ON documents
    WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
    BEGIN SELECT RAISE(ABORT, 'documents.org_id cannot be changed'); END;

  CREATE TRIGGER trg_chunks_org_matches BEFORE INSERT ON chunks
    WHEN NEW.org_id IS NULL OR NEW.org_id IS NOT (SELECT org_id FROM documents WHERE id = NEW.document_id)
    BEGIN SELECT RAISE(ABORT, 'a chunk must belong to the same organization as its document'); END;
  CREATE TRIGGER trg_chunks_org_immutable BEFORE UPDATE OF org_id, document_id ON chunks
    WHEN NEW.org_id IS NOT OLD.org_id OR NEW.document_id IS NOT OLD.document_id
    BEGIN SELECT RAISE(ABORT, 'a chunk cannot move to another document or organization'); END;

  CREATE TRIGGER trg_conversations_org_required BEFORE INSERT ON conversations WHEN NEW.org_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'conversations.org_id is required'); END;
  CREATE TRIGGER trg_conversations_org_immutable BEFORE UPDATE OF org_id ON conversations
    WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
    BEGIN SELECT RAISE(ABORT, 'conversations.org_id cannot be changed'); END;
  CREATE TRIGGER trg_conversations_user_immutable BEFORE UPDATE OF user_id ON conversations
    WHEN OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id
    BEGIN SELECT RAISE(ABORT, 'a conversation cannot change author'); END;

  CREATE TRIGGER trg_integrations_org_required BEFORE INSERT ON integration_connections WHEN NEW.org_id IS NULL
    BEGIN SELECT RAISE(ABORT, 'integration_connections.org_id is required'); END;
  CREATE TRIGGER trg_integrations_org_immutable BEFORE UPDATE OF org_id ON integration_connections
    WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
    BEGIN SELECT RAISE(ABORT, 'integration_connections.org_id cannot be changed'); END;

  -- Sessions now belong to a user and an active organization. Old demo sessions are removed.
  ALTER TABLE auth_sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
  ALTER TABLE auth_sessions ADD COLUMN org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE;
  DELETE FROM auth_sessions;

  -- The suggested-questions cache held excerpts of everyone's documents; it is per organization now.
  DELETE FROM app_settings WHERE key = 'suggested_questions';
  `,

  /* 11: Super Admin customer management. Purely additive (no table is rebuilt, no row is changed or deleted):
       - organizations.status: a suspended workspace can't be signed in to (enforced in the session lookup);
       - invitations.grants_owner: the link that makes someone a workspace's first Customer Admin (owner). SQLite
         can't change the existing CHECK on invitations.role, so this flag carries it; a trigger lets only a
         platform administrator issue one, and it can never be changed afterwards;
       - audit_log: an append-only record of sensitive access and administrative changes. */ `
  ALTER TABLE organizations ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended'));

  ALTER TABLE invitations ADD COLUMN grants_owner INTEGER NOT NULL DEFAULT 0 CHECK (grants_owner IN (0, 1));
  CREATE TRIGGER trg_invitations_owner_by_platform BEFORE INSERT ON invitations
    WHEN NEW.grants_owner = 1 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.invited_by AND is_platform_admin = 1)
    BEGIN SELECT RAISE(ABORT, 'only a platform administrator can issue a Customer Admin invitation'); END;
  CREATE TRIGGER trg_invitations_owner_immutable BEFORE UPDATE OF grants_owner ON invitations
    WHEN NEW.grants_owner IS NOT OLD.grants_owner
    BEGIN SELECT RAISE(ABORT, 'invitations.grants_owner cannot be changed'); END;

  -- No foreign keys on purpose: the record must outlive the users and organizations it describes, and the
  -- actor's email is copied in for the same reason. 'details' holds small JSON metadata, never secrets.
  CREATE TABLE audit_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actor_user_id  TEXT,
    actor_email    TEXT,
    actor_org_id   TEXT,
    action         TEXT NOT NULL,
    target_org_id  TEXT,
    target_user_id TEXT,
    target_label   TEXT,
    outcome        TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','denied','failed')),
    ip             TEXT,
    details        TEXT
  );
  CREATE INDEX idx_audit_log_at ON audit_log(at DESC);
  CREATE INDEX idx_audit_log_target_org ON audit_log(target_org_id, at DESC);
  CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id, at DESC);
  CREATE TRIGGER trg_audit_log_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER trg_audit_log_no_delete BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  `,

  /* 12: first-time activation of a Customer Admin by emailed verification code. Purely additive.
       - activation_codes: one row per code sent. Only an HMAC of the code is stored (never the code), plus an
         attempt counter and expiry; once the code is verified the row also holds the hash of a one-time ticket
         that lets the person choose a password. Triggers keep every code bound to a Customer Admin invitation
         (grants_owner) and to that invitation's own email address, so a code can never activate anyone else
         and can never lead to a role other than the one the Super Admin created.
       - organizations.customer_reference: optional label the Super Admin gives a customer. Metadata only; it is
         never used to sign in. */ `
  CREATE TABLE activation_codes (
    id                TEXT PRIMARY KEY,
    invitation_id     TEXT NOT NULL REFERENCES invitations(id) ON DELETE CASCADE,
    email             TEXT NOT NULL COLLATE NOCASE,
    code_hash         TEXT NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at        TEXT NOT NULL,
    consumed_at       TEXT,   -- the code can't be used any more (verified, replaced by a newer one, or too many wrong tries)
    verified_at       TEXT,
    ticket_hash       TEXT UNIQUE,
    ticket_expires_at TEXT,
    ticket_used_at    TEXT
  );
  CREATE INDEX idx_activation_codes_invitation ON activation_codes(invitation_id, created_at DESC);

  CREATE TRIGGER trg_activation_codes_binding BEFORE INSERT ON activation_codes
    WHEN NOT EXISTS (SELECT 1 FROM invitations i WHERE i.id = NEW.invitation_id AND i.grants_owner = 1 AND i.email = NEW.email)
    BEGIN SELECT RAISE(ABORT, 'an activation code belongs to a Customer Admin invitation and its own email address'); END;
  CREATE TRIGGER trg_activation_codes_immutable BEFORE UPDATE OF invitation_id, email, code_hash, expires_at ON activation_codes
    WHEN NEW.invitation_id IS NOT OLD.invitation_id OR NEW.email IS NOT OLD.email OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN SELECT RAISE(ABORT, 'an activation code cannot be re-targeted or extended'); END;

  ALTER TABLE organizations ADD COLUMN customer_reference TEXT CHECK (customer_reference IS NULL OR length(customer_reference) BETWEEN 1 AND 40);
  CREATE UNIQUE INDEX idx_organizations_reference ON organizations(lower(customer_reference)) WHERE customer_reference IS NOT NULL;
  `,

  /* 13: customers are onboarded with a TEMPORARY PASSWORD the Super Admin hands over, which must be replaced at the
     first sign-in. Purely additive: nothing existing changes (every existing user has must_change_password = 0).
       - users.must_change_password: while 1, the account may only use the "choose a new password" endpoints (enforced
         on the server for every page and API, not just by a redirect);
       - users.temp_password_expires_at: a temporary password stops working at that moment (a trigger makes an
         expiry mandatory whenever the flag is set; revoking a temporary password simply sets this to now);
       - users.password_changed_at: when the person last chose their own password;
       - organizations.creation_request_id: makes "create customer" safe to retry (a repeated request returns the
         customer that already exists and can never reveal its password: only a hash of it is ever stored).
     The empty activation_codes table from migration 12 is no longer used and is left alone (dropping it would be a
     destructive change for no benefit). */ `
  ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1));
  ALTER TABLE users ADD COLUMN temp_password_expires_at TEXT;
  ALTER TABLE users ADD COLUMN password_changed_at TEXT;

  CREATE TRIGGER trg_users_temp_password_needs_expiry_insert BEFORE INSERT ON users
    WHEN NEW.must_change_password = 1 AND NEW.temp_password_expires_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'a temporary password needs an expiry'); END;
  CREATE TRIGGER trg_users_temp_password_needs_expiry_update BEFORE UPDATE OF must_change_password, temp_password_expires_at ON users
    WHEN NEW.must_change_password = 1 AND NEW.temp_password_expires_at IS NULL
    BEGIN SELECT RAISE(ABORT, 'a temporary password needs an expiry'); END;

  ALTER TABLE organizations ADD COLUMN creation_request_id TEXT;
  CREATE UNIQUE INDEX idx_organizations_creation_request ON organizations(creation_request_id) WHERE creation_request_id IS NOT NULL;
  `,

  /* 14: the Doctor role. This is the ONE migration in the consultation work that is not purely additive, and it is kept on
     its own so it can be checked on its own: SQLite can't change a CHECK constraint, so the two tables that list the roles
     are rebuilt with 'doctor' added (memberships.role and invitations.role). Every row is copied unchanged and nothing else
     is touched. The standard rebuild is used (create the new table, copy, drop the old one, rename, recreate what hung off
     the old table). Two things need care:
       - nothing references memberships, but activation_codes references invitations with ON DELETE CASCADE and has two
         triggers that read invitations. Dropping invitations would cascade-delete those rows (the table is unused and empty,
         but a migration must not rely on that), so the rows are set aside and put back, and the triggers are recreated;
       - the invitations triggers belong to the old table and are recreated exactly as migrations 11 and 12 defined them.
     tests/migration-doctor-role.test.ts proves every row, index and trigger survives, and the app also writes a full backup
     of the database before it runs (client.ts: backupBeforeMigration). */ `
  CREATE TABLE memberships_new (
    org_id     TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner','admin','member','doctor','viewer')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (org_id, user_id)
  );
  INSERT INTO memberships_new (org_id, user_id, role, created_at) SELECT org_id, user_id, role, created_at FROM memberships;
  DROP TABLE memberships;
  ALTER TABLE memberships_new RENAME TO memberships;
  CREATE INDEX idx_memberships_user ON memberships(user_id);

  DROP TRIGGER trg_activation_codes_binding;
  DROP TRIGGER trg_activation_codes_immutable;
  CREATE TEMP TABLE activation_codes_keep AS SELECT * FROM activation_codes;

  CREATE TABLE invitations_new (
    id           TEXT PRIMARY KEY,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email        TEXT NOT NULL COLLATE NOCASE,
    role         TEXT NOT NULL CHECK (role IN ('admin','member','doctor','viewer')),
    token_hash   TEXT NOT NULL UNIQUE,
    invited_by   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at   TEXT NOT NULL,
    accepted_at  TEXT,
    revoked_at   TEXT,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    grants_owner INTEGER NOT NULL DEFAULT 0 CHECK (grants_owner IN (0, 1))
  );
  INSERT INTO invitations_new (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at, grants_owner)
    SELECT id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at, revoked_at, created_at, grants_owner FROM invitations;
  DROP TABLE invitations;
  ALTER TABLE invitations_new RENAME TO invitations;
  CREATE INDEX idx_invitations_org ON invitations(org_id);
  CREATE TRIGGER trg_invitations_owner_by_platform BEFORE INSERT ON invitations
    WHEN NEW.grants_owner = 1 AND NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.invited_by AND is_platform_admin = 1)
    BEGIN SELECT RAISE(ABORT, 'only a platform administrator can issue a Customer Admin invitation'); END;
  CREATE TRIGGER trg_invitations_owner_immutable BEFORE UPDATE OF grants_owner ON invitations
    WHEN NEW.grants_owner IS NOT OLD.grants_owner
    BEGIN SELECT RAISE(ABORT, 'invitations.grants_owner cannot be changed'); END;

  INSERT INTO activation_codes SELECT * FROM activation_codes_keep;
  DROP TABLE activation_codes_keep;
  CREATE TRIGGER trg_activation_codes_binding BEFORE INSERT ON activation_codes
    WHEN NOT EXISTS (SELECT 1 FROM invitations i WHERE i.id = NEW.invitation_id AND i.grants_owner = 1 AND i.email = NEW.email)
    BEGIN SELECT RAISE(ABORT, 'an activation code belongs to a Customer Admin invitation and its own email address'); END;
  CREATE TRIGGER trg_activation_codes_immutable BEFORE UPDATE OF invitation_id, email, code_hash, expires_at ON activation_codes
    WHEN NEW.invitation_id IS NOT OLD.invitation_id OR NEW.email IS NOT OLD.email OR NEW.code_hash IS NOT OLD.code_hash OR NEW.expires_at IS NOT OLD.expires_at
    BEGIN SELECT RAISE(ABORT, 'an activation code cannot be re-targeted or extended'); END;
  `,

  /* 15: doctor consultations (recording -> transcript -> clinical note). Purely additive: new tables only.
     Health information, so:
       - every table has an owning organization that cascades from organizations, like the other customer tables, and
         triggers make a child row's organization match its consultation's (a row can't be filed under another customer);
       - what identifies a patient or describes their care (patient label, transcript, note) is stored as an opaque BLOB
         sealed by the application (AES-256-GCM, bound to the organization and consultation: server/security/vault.ts), so
         a copy of this file or of a backup reveals none of it. The audio itself is never in this file (see the audio store);
       - the doctor, the consent and the people who edited or approved a note are plain foreign keys to users with NO cascade:
         deleting an account can never silently delete health records (it fails instead);
       - history is append-only: a consent record and a transcript are never changed, a note is a new version for every edit,
         and an approval can be set once and never altered;
       - deleting a consultation (an explicit, audited action) or its workspace removes everything through the cascades. */ `
  CREATE TABLE consultations (
    id               TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    doctor_user_id   TEXT NOT NULL REFERENCES users(id),
    patient_label    BLOB NOT NULL,   -- sealed; the doctor's own words for who the patient is (a name or a record number)
    language_hint    TEXT NOT NULL DEFAULT 'auto' CHECK (language_hint IN ('auto','en','hi','gu','mixed')),
    status           TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','uploading','processing','needs_review','approved','failed')),
    failure_code     TEXT,            -- stable code of what went wrong; never content
    failure_message  TEXT,            -- a sentence that is safe to show the doctor
    approved_note_id TEXT,            -- the latest approved version (no foreign key: notes reference consultations)
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX idx_consultations_doctor ON consultations(org_id, doctor_user_id, created_at DESC);
  CREATE TRIGGER trg_consultations_org_immutable BEFORE UPDATE OF org_id ON consultations
    WHEN NEW.org_id IS NOT OLD.org_id BEGIN SELECT RAISE(ABORT, 'consultations.org_id cannot be changed'); END;
  CREATE TRIGGER trg_consultations_doctor_immutable BEFORE UPDATE OF doctor_user_id ON consultations
    WHEN NEW.doctor_user_id IS NOT OLD.doctor_user_id BEGIN SELECT RAISE(ABORT, 'a consultation cannot change doctor'); END;

  -- Consent is recorded BEFORE anything can be recorded: the recording endpoints refuse a consultation without one.
  CREATE TABLE consultation_consents (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consultation_id     TEXT NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
    text_version        TEXT NOT NULL,   -- which wording the patient was given (lib/consultation-consent.ts)
    text_sha256         TEXT NOT NULL,   -- a fingerprint of that exact wording, so it can be proven later
    language            TEXT NOT NULL CHECK (language IN ('en','hi','gu')),
    given_by            TEXT NOT NULL CHECK (given_by IN ('patient','guardian','representative')),
    method              TEXT NOT NULL CHECK (method IN ('verbal','written')),
    recorded_by_user_id TEXT NOT NULL REFERENCES users(id),
    recorded_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TRIGGER trg_consents_org_matches BEFORE INSERT ON consultation_consents
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultations WHERE id = NEW.consultation_id)
    BEGIN SELECT RAISE(ABORT, 'a consent must belong to the same organization as its consultation'); END;
  CREATE TRIGGER trg_consents_never_change BEFORE UPDATE ON consultation_consents
    BEGIN SELECT RAISE(ABORT, 'a consent record is never changed'); END;

  -- One recording per consultation. The audio lives in the audio store under storage_key (opaque, random, no patient data in
  -- it); in the store it is sealed part by part, so the storage provider only ever holds ciphertext.
  CREATE TABLE consultation_recordings (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consultation_id TEXT NOT NULL UNIQUE REFERENCES consultations(id) ON DELETE CASCADE,
    status          TEXT NOT NULL CHECK (status IN ('uploading','stored','deleted')),
    mime_type       TEXT NOT NULL,
    storage_key     TEXT NOT NULL UNIQUE,
    part_size       INTEGER NOT NULL CHECK (part_size > 0),
    size_bytes      INTEGER,
    part_count      INTEGER,
    duration_ms     INTEGER,
    sha256          TEXT,            -- of the whole recording, as the browser computed it and the server re-checked
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    stored_at       TEXT,
    deleted_at      TEXT
  );
  CREATE TRIGGER trg_recordings_org_matches BEFORE INSERT ON consultation_recordings
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultations WHERE id = NEW.consultation_id)
    BEGIN SELECT RAISE(ABORT, 'a recording must belong to the same organization as its consultation'); END;
  CREATE TRIGGER trg_recordings_identity_immutable BEFORE UPDATE OF org_id, consultation_id, storage_key ON consultation_recordings
    WHEN NEW.org_id IS NOT OLD.org_id OR NEW.consultation_id IS NOT OLD.consultation_id OR NEW.storage_key IS NOT OLD.storage_key
    BEGIN SELECT RAISE(ABORT, 'a recording cannot move to another consultation, organization or storage location'); END;

  CREATE TABLE consultation_upload_parts (
    recording_id TEXT NOT NULL REFERENCES consultation_recordings(id) ON DELETE CASCADE,
    org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    part_number  INTEGER NOT NULL CHECK (part_number >= 1),
    size_bytes   INTEGER NOT NULL CHECK (size_bytes > 0),
    sha256       TEXT NOT NULL,
    PRIMARY KEY (recording_id, part_number)
  );
  CREATE TRIGGER trg_parts_org_matches BEFORE INSERT ON consultation_upload_parts
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultation_recordings WHERE id = NEW.recording_id)
    BEGIN SELECT RAISE(ABORT, 'an upload part must belong to the same organization as its recording'); END;

  -- The durable queue. (consultation, kind, generation) is the idempotency key: enqueueing the same work twice is a no-op, and an
  -- explicit retry is a new generation. A worker holds a job by a lease that expires, so a crash never strands work.
  CREATE TABLE consultation_jobs (
    id               TEXT PRIMARY KEY,
    org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consultation_id  TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    kind             TEXT NOT NULL CHECK (kind IN ('transcribe','draft_note')),
    generation       INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
    status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 4,
    run_after        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    lease_owner      TEXT,
    lease_expires_at TEXT,
    error_code       TEXT,
    error_message    TEXT,           -- redacted and safe to show; never transcript or patient content
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at      TEXT,
    UNIQUE (consultation_id, kind, generation)
  );
  CREATE INDEX idx_consultation_jobs_due ON consultation_jobs(status, run_after);
  CREATE TRIGGER trg_jobs_org_matches BEFORE INSERT ON consultation_jobs
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultations WHERE id = NEW.consultation_id)
    BEGIN SELECT RAISE(ABORT, 'a job must belong to the same organization as its consultation'); END;
  CREATE TRIGGER trg_jobs_identity_immutable BEFORE UPDATE OF org_id, consultation_id, kind, generation ON consultation_jobs
    WHEN NEW.org_id IS NOT OLD.org_id OR NEW.consultation_id IS NOT OLD.consultation_id OR NEW.kind IS NOT OLD.kind OR NEW.generation IS NOT OLD.generation
    BEGIN SELECT RAISE(ABORT, 'a job cannot be pointed at other work'); END;

  -- The original transcript, kept exactly as the speech service returned it. It is never edited: corrections go in the note.
  CREATE TABLE consultation_transcripts (
    id              TEXT PRIMARY KEY,
    org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consultation_id TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL CHECK (version >= 1),
    provider        TEXT NOT NULL,
    model           TEXT NOT NULL,
    content         BLOB NOT NULL,   -- sealed JSON: the segments (speaker, text, language, uncertainty) and the service's remarks
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (consultation_id, version)
  );
  CREATE TRIGGER trg_transcripts_org_matches BEFORE INSERT ON consultation_transcripts
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultations WHERE id = NEW.consultation_id)
    BEGIN SELECT RAISE(ABORT, 'a transcript must belong to the same organization as its consultation'); END;
  CREATE TRIGGER trg_transcripts_never_change BEFORE UPDATE ON consultation_transcripts
    BEGIN SELECT RAISE(ABORT, 'a transcript is never changed'); END;

  -- Every edit is a new version (the AI draft is version 1). A version can be approved once; an approved version is final.
  CREATE TABLE consultation_notes (
    id                  TEXT PRIMARY KEY,
    org_id              TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consultation_id     TEXT NOT NULL REFERENCES consultations(id) ON DELETE CASCADE,
    version             INTEGER NOT NULL CHECK (version >= 1),
    transcript_id       TEXT NOT NULL REFERENCES consultation_transcripts(id) ON DELETE CASCADE,
    source              TEXT NOT NULL CHECK (source IN ('ai','doctor')),
    content             BLOB NOT NULL,   -- sealed JSON note
    provider            TEXT,
    model               TEXT,
    created_by_user_id  TEXT REFERENCES users(id),   -- NULL for the AI draft
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    approved_by_user_id TEXT REFERENCES users(id),
    approved_at         TEXT,
    UNIQUE (consultation_id, version),
    CHECK ((approved_at IS NULL) = (approved_by_user_id IS NULL)),
    CHECK ((source = 'ai') = (created_by_user_id IS NULL))
  );
  CREATE TRIGGER trg_notes_org_matches BEFORE INSERT ON consultation_notes
    WHEN NEW.org_id IS NOT (SELECT org_id FROM consultations WHERE id = NEW.consultation_id)
      OR NEW.consultation_id IS NOT (SELECT consultation_id FROM consultation_transcripts WHERE id = NEW.transcript_id)
    BEGIN SELECT RAISE(ABORT, 'a note must belong to the same organization and consultation as its transcript'); END;
  CREATE TRIGGER trg_notes_content_never_change BEFORE UPDATE OF org_id, consultation_id, version, transcript_id, source, content, provider, model, created_by_user_id, created_at ON consultation_notes
    BEGIN SELECT RAISE(ABORT, 'a note version is never edited: save a new version'); END;
  CREATE TRIGGER trg_notes_approval_is_final BEFORE UPDATE OF approved_at, approved_by_user_id ON consultation_notes
    WHEN OLD.approved_at IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'an approved note version is final'); END;
  `,
];

export const MIGRATION_COUNT = MIGRATIONS.length;

/** The database's current schema version (0 for a new, empty database). */
export function schemaVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

/** Applies pending migrations, each in its own transaction. `upTo` stops early (used by tests to build old databases). */
export function migrate(db: Database.Database, upTo: number = MIGRATIONS.length): void {
  const current = schemaVersion(db);
  for (let v = current; v < Math.min(upTo, MIGRATIONS.length); v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
