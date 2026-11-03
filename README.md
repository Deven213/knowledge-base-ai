# AI Knowledge Base (MVP)

Upload PDF, DOCX or TXT documents and chat with them. Answers come from **OpenAI**, **Anthropic Claude** or **Google Gemini** (you pick the active provider) and include citations back to the source document and page.

Only the chunks relevant to the question are sent to the LLM, never the whole document.

It is **multi-tenant**: every customer works in their own workspace (organization), and one workspace can never see another's documents, chunks, embeddings, conversations or integrations. See *Multi-tenancy, users and roles*.

```
Document → extraction → chunking → local embeddings → SQLite vector store
Question → local embedding → top-k retrieval → active LLM → answer + citations
```

## Screens

`http://localhost:3000` opens the public **landing page**. **Try the AI Demo** leads to `/login`; after signing in you land on the admin **Dashboard** (or the page you originally asked for). The sidebar's **Open Chat** button, and the chat's **Admin** button, switch between the two areas.

| Route | Screen | Status |
|---|---|---|
| `/admin` | **Dashboard**: document, chunk, conversation and question counts; recent documents; active model | Working |
| `/admin/documents` | **Documents**: upload (drag & drop, multiple files), search, status filter, delete, and **Clear N failed** (see below) | Working |
| `/admin/ai-models` | **AI Model Settings**: choose the active provider, set model IDs, see API key status | Working |
| `/admin/integrations` | **Integrations** overview, opening one page per source: `/admin/integrations/website-scraper`, `/admin/integrations/google-drive`, `/admin/integrations/onedrive` (the old `/admin/sync-integrations` redirects here) | Working (Google Drive / OneDrive need OAuth setup) |
| `/platform` | **Customers** (Super Admin only): every customer workspace, create a customer with its first Customer Admin, suspend, reactivate or delete a workspace, manage people, and the audit log. Hidden from everyone else (they get a 404) | Working |
| `/change-password` | **Choose a new password**: where a customer with a temporary password is sent at their first sign-in (and the only page they can open until they have); anyone signed in can also change their password here | Working |
| `/settings/team` | **Team** (owners and admins): people in your own workspace, roles and invitation links | Working |
| `/chat` | **Chat**: history sidebar grouped by date, search, suggested questions, answers with citation badges and source excerpts, document scope picker, and a composer with file/image attachments | Working |
| `/admin/ai-agents`, `widgets`, `email-addons`, `whatsapp`, `channels`, `categories`, `users`, `system-monitoring`, `feedback`, `audit-logs` | Shown in the sidebar so navigation matches the full product; each opens a **Coming soon** page listing what it will do | Placeholder |

The sidebar is defined in one place, `src/components/admin/nav.ts`. To build a placeholder section, give it its own folder under `src/app/admin/` and set its `status` to `"live"`.

## Quick start

Requires Node.js 22+.

```bash
npm install
cp .env.example .env       # then paste your API keys and model IDs into .env
npm run dev                # http://localhost:3000
```

1. In `.env`, set the API key **and** a model ID for at least one provider (see below), and `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD` (the first owner: at least 4 characters). Restart the server after editing `.env`, then sign in at `/login` with that email and password.
2. Open **Admin → Documents** and upload a file. The first upload downloads the local embedding model (~35 MB) into `data/models/`.
3. Open **Admin → AI Model Settings**, select the provider, and click **Update AI Model**.
4. Go to **Chat** and ask a question.

> **Windows note:** the scripts use `next dev --webpack` / `next build --webpack`. On this machine a Windows Application Control policy blocks Next.js's native compiler binary, so the Turbopack bundler can't start. Webpack runs with Next's WebAssembly compiler instead.

## Configuration (`.env`)

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Provider API keys. **Read only from `.env`**: never stored in the database and never sent to the browser. The UI shows only whether a key is set and its last 4 characters. |
| `OPENAI_MODEL`, `ANTHROPIC_MODEL`, `GEMINI_MODEL` | Model IDs. No defaults are built in. You can override them per provider in AI Model Settings; the UI value wins over `.env`. |
| `DEFAULT_AI_PROVIDER` | Provider used until one is chosen in AI Model Settings (`openai`, `anthropic` or `gemini`). |
| `EMBEDDING_MODEL`, `EMBEDDING_POOLING`, `EMBEDDING_QUERY_PREFIX` | Local Hugging Face embedding model (default `Xenova/bge-small-en-v1.5`, CLS pooling). |
| `RETRIEVAL_TOP_K` | Number of chunks sent to the LLM (default 6). |
| `RETRIEVAL_MIN_SCORE` | Minimum cosine similarity for a chunk to count as relevant (default 0.5, calibrated for bge-small). If nothing clears it, the app says so without calling the LLM. |
| `MAX_UPLOAD_MB` | Upload size limit (default 20, max 200). `next.config.ts` raises Next.js's own 10 MB request-body cap to match, so larger values work without further changes. |
| `OCR_ENABLED`, `OCR_LANGUAGES`, `OCR_MAX_PAGES`, `OCR_WORKERS` | Local OCR for scanned PDFs: on/off (default on), Tesseract language codes (default `eng`, e.g. `eng+hin`), page cap per document (default 300) and parallel workers (default scales with the CPU, max 4). See *Scanned PDFs (OCR)*. |
| `DATA_DIR` | Where the SQLite database and model cache live (default `./data`). |
| `BOOTSTRAP_OWNER_EMAIL`, `BOOTSTRAP_OWNER_PASSWORD`, `BOOTSTRAP_OWNER_NAME` | The first owner. Created at startup if the address has no account, and made owner of the *Default workspace* (which holds everything that existed before organizations) while that workspace has no owner. Also becomes platform administrator if there is none. `.env` is only read **at startup** (restart after editing it; `next dev` reloads the file but not this). It only ever *creates* the owner: it never renames or re-passwords an existing account, and an address that is new to the database becomes a separate account that no workspace contains. If you can't sign in with these values, see *Can't sign in as the owner*. |
| `INVITE_TTL_HOURS` | How long an ordinary invitation link (Settings → Team) is valid (default 168 = 7 days). |
| `TEMPORARY_PASSWORD_HOURS` | How long a temporary password handed to a new Customer Admin works before it expires (default 72). |
| `TRUSTED_PROXY_HOPS` | Reverse proxies in front of the app (default 0). Per-IP login throttling reads `X-Forwarded-For` only when this is above 0, so a client can't spoof its address. |

A provider is **ready** when it has both an API key and a model ID.

### Clearing failed documents

A failed upload leaves a "Failed" row (it has no index, so it never affects answers). **Clear N failed** on the Documents page removes them all after a confirmation dialog.

- **API:** `DELETE /api/documents/failed` takes no body and returns `{ deleted, deletedIds, message }`. It requires a signed-in session (checked on the server, not trusted from the browser), rejects cross-site requests and honors the Documents feature flag.
- **What it deletes:** only rows whose status is `failed`, in one atomic statement that checks the status at the moment of deletion. A document that is `processing`, or that became `ready` after the page loaded, is never touched. A row stuck in `processing` is only treated as failed by the app's own start-up recovery (*Processing was interrupted*), never by this button.
- **Related data:** a document's chunks go with it (`ON DELETE CASCADE`). Nothing else references a document, and original files are not stored, so there are no files to clean up and chunks of other documents are never touched.
- **Scope:** the app has a single workspace, so "failed documents" means every failed document. Documents have no tenant or knowledge-base column to filter on.

### Scanned PDFs (OCR)

A PDF whose pages are pictures of text (a scan, a printout saved as images) has no text layer to read. For every page without one, the app renders the page to an image and reads it with **Tesseract OCR running locally**, so document text never leaves the machine. The recognized text then goes through the normal pipeline (chunking, local embeddings, citations with page numbers).

- **Which pages:** only pages with no text layer are OCR'd, so a normal text PDF never touches OCR, and a PDF with a few image-only pages keeps its text and gains theirs. If OCR can't run for such a mostly-text document, it is still indexed from its text.
- **Speed:** roughly 2-4 seconds per page per worker, so a 50-page scan takes about a minute. Uploads are processed within the request, so large scans take a while; the worker pool starts on the first scan and shuts down after a minute idle to free memory.
- **First use:** the language data (about 5 MB for English) downloads once into `DATA_DIR/models/tessdata`, so the first scan needs an internet connection.
- **Limits:** `OCR_MAX_PAGES` (default 300) refuses longer scans with a message asking to split the file. Quality depends on the scan; very low-resolution or handwritten pages may read poorly.
- **Off switch:** `OCR_ENABLED=false` restores the old behavior of rejecting scans.
- Chat attachments use the same extractor, so a scanned PDF attached to a message is OCR'd too.

### Changing the embedding model

Vectors from different models can't be compared. Each chunk records the model that produced it, and documents indexed with a different model are marked **Re-index needed** and left out of search. Delete them and upload them again.

## Architecture

```
src/
├── app/
│   ├── page.tsx              Chat
│   ├── admin/                Dashboard · Documents · AI Model Settings (shared sidebar layout)
│   └── api/                  documents · ask · conversations · settings/ai · suggestions · stats
├── components/               ui primitives, admin/, chat/
├── lib/                      Browser-safe types + API client
└── server/
    ├── knowledge/            RAG layer: no LLM imports
    │   ├── extract/          PDF (per page, unpdf; scans via ocr.ts + Tesseract) · DOCX (mammoth) · TXT
    │   ├── chunker.ts        paragraph → line → sentence → word splitting, overlap, page ranges
    │   ├── embedder.ts       Embedder interface + local ONNX implementation
    │   ├── vector-store.ts   VectorStore interface + SQLite brute-force cosine implementation
    │   └── ingest.ts · retrieve.ts
    ├── llm/                  Provider layer: no document imports
    │   ├── openai.ts · anthropic.ts · gemini.ts   (one LLMProvider interface)
    │   ├── resolve.ts        env keys, model resolution (UI → env → none), active provider
    │   └── errors.ts         maps SDK errors to user-safe messages, redacted
    ├── rag/                  Where the two layers meet
    │   ├── answer.ts         retrieve → prompt → generate → citations
    │   ├── chat.ts           answers inside a conversation and persists the exchange
    │   ├── suggest.ts        starter questions from recent documents (cached)
    │   └── prompt.ts · citations.ts
    ├── security/redact.ts    strips key-like strings from logs and errors
    ├── auth/                 passwords (scrypt), sessions, invitations, login throttling, first-owner bootstrap, temporary passwords
    ├── authz/permissions.ts  roles → actions: the single source of truth for who may do what
    ├── tenant.ts             withTenant(): resolves session → user + organization + role for every API route
    ├── services.ts           per-organization services (vector store, repositories) built from a TenantContext
    └── db/                   SQLite connection, migrations (with automatic backup), org-scoped repositories, system.ts
```

Because embeddings are computed locally and don't depend on the chat provider, a document is indexed once and works with all three providers.

The `Embedder` and `VectorStore` interfaces are the extension points for hosted embeddings or pgvector.

## Landing page, sign-in and demo account

- `/` is a public landing page, `/login` the sign-in page and `/invite?token=…` the page for invitation links. Everything else is the product and requires a session: `/admin/*`, `/chat`, `/settings/*`, `/app`, and every API except `/api/auth/login`, `/api/auth/demo`, `/api/auth/logout` and `/api/auth/accept-invite` (these four are the only public routes; a test enforces it).
- **Accounts:** there is no public sign-up. The first owner comes from `BOOTSTRAP_OWNER_*` in `.env`; everyone else joins through an invitation (see *Multi-tenancy, users and roles*).
- **Demo account (optional):** exists only when `DEMO_USER_PASSWORD` is set in `.env` (there is no built-in password). It signs in to its own **Demo workspace**, never to a customer's, and the login page shows the credentials and a **Use Demo Account** button only when `DEMO_SHOW_CREDENTIALS=true`. Leave the demo unconfigured on production deployments.
- **Sessions:**
  - Signing in creates a server-side session (table `auth_sessions`) bound to one user and one workspace. The browser gets only a random 256-bit token in an httpOnly, SameSite=Lax cookie (`Secure` when `APP_BASE_URL` is https), and the database stores only its SHA-256 hash.
  - Sessions last `AUTH_SESSION_HOURS` (default 24) and survive page refreshes and server restarts.
  - **Logout** deletes the session on the server, so the old cookie stops working immediately, and returns you to `/`.
  - The user's membership is re-read on **every request**: removing someone from a workspace, or disabling their account, cuts their access at once, even with a valid cookie.
- **Where sessions are checked:**
  - `src/proxy.ts` rejects requests with no valid session token for every product page and API. Pages redirect to `/login?redirect=<page>`; APIs answer 401.
  - Every API route then resolves the full tenant context itself (`withTenant`), and the product layouts check the session again on the server.
  - After sign-in you return to the requested page. Only this site's product pages are allowed as return targets, so there are no open redirects.
- **Can't sign in as the owner (`BOOTSTRAP_OWNER_*`)?** The values in `.env` are only used to *create* the first owner, so editing them later does not change an account that already exists. The usual causes, all visible in the server log at startup (addresses are masked, passwords never printed):
  - **The email was changed to a new address** after the first owner existed. The new address becomes a separate account that no workspace contains and that isn't a Super Admin (one already exists), so it can't sign in. The sign-in page says *"Your account doesn't belong to any workspace yet"* once the password is right (a wrong password or unknown address still gets the generic *"Invalid email or password."*).
  - **The password was changed in `.env`** (or the owner changed it in the app) so it no longer matches the stored one. The log says so; the account is not changed.
  - The account is disabled, or every workspace it belongs to is suspended.

  Either use the address and password the account really has, or repair it explicitly with `npm run owner:recover`: a **dry run** by default (reports what is wrong and what would change, writes nothing). `npm run owner:recover -- --apply` then makes the account named in `.env` a Super Admin and an owner of the Default workspace (creating it if the address has none), after writing a backup copy of the database; add `--reset-password` to also replace the stored password with the one in `.env`. It touches only that one account (no other user, customer workspace, document or chat), never demotes anyone, runs in one transaction, is safe to repeat, and writes one audit record without any secret. No restart is needed afterwards.
- **Passwords and sign-in errors:** passwords are hashed with scrypt (parameters stored with each hash); at least 4 characters (one constant, `src/lib/password-policy.ts`, read by the server and every form). A wrong email or password gets the same generic message and takes the same time (an unknown address is checked against a dummy hash). Failed attempts are throttled per account, and per client IP when `TRUSTED_PROXY_HOPS` is set.
- **Branding:** the product name and taglines live in one place, `src/lib/brand.ts`.

## Multi-tenancy, users and roles

**Model.** A *user* belongs to one or more *organizations* (workspaces) through a *membership* that carries a role. Documents, chunks (with their embeddings), conversations, integrations, sync history and per-workspace settings each belong to exactly one organization (`org_id`).

**Roles** (per workspace):

| Role | Chat | Read documents | Upload | Delete documents | Integrations | Team |
|---|---|---|---|---|---|---|
| viewer | yes | yes | – | – | – | – |
| member | yes | yes | yes | – | – | – |
| doctor | yes | yes | – | – | – | – |
| admin | yes | yes | yes | yes | yes | invite, change roles up to admin, remove |
| owner | yes | yes | yes | yes | yes | everything, including other owners |

The **doctor** role exists for *Doctor consultations* (below). It is the ONLY role that can record, read, edit or approve a consultation; owners and administrators can run the workspace without being able to open a patient's recording, transcript or note. A person holds one role per workspace, so a clinic owner who is also a doctor needs a second account (invite another email as Doctor).

- Conversations are **private to their author**, even from admins and owners. Documents are shared inside a workspace.
- Nobody can grant a role above their own; only an owner can create, change or remove an owner; the **last owner can't be removed or demoted**.
- **Platform administrator** (`users.is_platform_admin`) is separate from workspace roles. It is required for the *Customers* console (see *Super Admin console*), *Feature Management* and *AI Model Settings*, which are global and affect every customer (the AI provider keys and costs are shared).

**Where isolation is enforced (defence in depth):**
1. **Tenant resolution:** every API route runs through `withTenant(action)`, which derives the user, workspace and role from the session cookie, never from the request body, query or URL. A client can't name another workspace.
2. **Scoped data access:** repositories and the vector store are constructed with an organization id and throw without one; every query filters on it, including vector search (`chunks.org_id` and `documents.org_id`), the suggested-question cache, integration credentials and OAuth state. Direct lookups by id are scoped too, so another tenant's id answers 404.
3. **Database triggers:** `org_id` is required and immutable on tenant tables, and a chunk's organization must equal its document's. A coding mistake that tries to write across tenants fails in SQLite itself.
4. **Tests:** `tests/tenant-isolation.test.ts` seeds two organizations with the same documents, chats and integrations and checks every read, write and search path from both sides; `tests/tenant-guards.test.ts` statically fails the test run if a route skips `withTenant` or a repository is built without an organization.

**Invitations.** Owners and admins create a single-use link in **Settings → Team** for one email address and a role (never owner). Only a SHA-256 hash of the token is stored; the link is shown once and expires after `INVITE_TTL_HOURS`. Sending it is up to you (no email is sent). The invited person opens it, chooses a password and joins; an existing account signs in first. Links can be revoked.

### Super Admin console (customer management)

The Super Admin is a **platform administrator** (`users.is_platform_admin`; the `BOOTSTRAP_OWNER_*` account gets it automatically while nobody has it). They see a **Customers** link in the sidebar (`/platform`). Like everyone, they sign in to a workspace (a Super Admin must belong to at least one), and the console works across workspaces without ever opening one.

**Workflow**
1. **Create a customer.** *Customers → New customer*: the company / workspace name, the first Customer Admin's email (their **login ID**) and, optionally, a **customer reference ID** for your own records (letters, numbers, `. _ -`, unique; metadata only, never a way to sign in). One transaction creates an isolated workspace, the Customer Admin's account (role **owner**, so a workspace always has someone who can manage it) and a random **temporary password**. The screen shows the workspace, the login page, the login ID and the temporary password once, with a **Copy credentials** button. Only a hash of the password is stored. Nothing is emailed: you send the credentials to the customer yourself.
2. **The customer signs in with the temporary password** on the normal login page and is taken straight to *Choose your new password*. Until they have, **every other page and API answers "password change required"** (enforced on the server, see below). Choosing a new password overwrites the stored hash, so the temporary one stops working at that instant, and ends all their other sign-ins. A temporary password also **expires** (`TEMPORARY_PASSWORD_HOURS`, default 72).
3. **The Customer Admin manages their own people** on *Settings → Team*: invitations, roles, removal. That only ever reaches their own workspace.
4. **The Super Admin manages the customer:**
   - **Suspend / reactivate a workspace.** Both ask for confirmation in a dialog inside the page (not the browser's native pop-up, which some embedded browsers never show) and the new status appears at once; a failure is shown in the dialog. Suspending signs everyone in it out immediately and blocks sign-in, switching to it, invitations to it and every API call, with a clear message at sign-in. Nothing is deleted. Reactivating allows sign-in again; earlier sign-ins stay ended, and a temporary password that had expired or been revoked stays expired (reissue one if needed). You can't suspend the workspace you are signed in to.
   - **Delete a customer** (*Delete this customer* at the bottom of the workspace page). A dialog names the customer, says the deletion is permanent, lists what goes with it (people, documents and their search index, chats, connected integrations with their stored credentials, invitations, settings) and only enables *Delete permanently* once you type the workspace's name (the server checks the name too, so no request can delete by accident). It is **all or nothing**: one database transaction removes the workspace (every customer table cascades from it: `tests/tenant-erasure.test.ts` checks the real schema) and writes the audit record, and rolls back entirely if anything fails. Protected cases are refused with a reason: the workspace you are signed in to, a workspace that contains a Super Admin account, and a workspace with a document still being processed or an integration sync running. People who belong **only** to the deleted workspace lose their accounts (so the email addresses can be used again); an account that is also a member of another customer, or has chats or issued invitations in another customer's workspace, is **kept**, because deleting it would delete that other customer's rows through the foreign keys. Other customers, Super Admin accounts, platform settings and the audit history are never touched; the audit log keeps a record that the deletion happened (who, which customer, how many of each thing, never any content). Consider suspending instead if the data might be needed again: a deletion cannot be undone (restore from a backup of `data/`).
   - **Disable / enable an account.** A disabled person is signed out everywhere at once and can't sign in to any workspace. Super Admin accounts can't be disabled from here (and never yourself).
   - **Add a Customer Admin** to an existing workspace: another owner account with its own temporary password. The email must not already have an account (an existing account is never attached to another customer's workspace and its password is never touched).
   - **Reissue or revoke a temporary password** for someone who hasn't replaced it yet (a lost message, an expired password, a change of mind): *reissue* gives a new one (the old one stops working, their sessions end); *revoke* stops it immediately. This is deliberately impossible for an account that has chosen its own password: that would let a Super Admin sign in as a customer's user and read their private chats.
   - **Withdraw** an invitation link issued by the earlier onboarding (they still work until used, withdrawn or expired).
5. **Audit log** (*Customers → Audit log*, newest first).

**Boundaries**
- The console shows **metadata and counts only** (names, status, people, roles, sign-in times). It never shows documents, chats, embeddings or integrations: the platform code does not touch those tables (enforced by a test), and a Super Admin's own session still only opens their own workspace's content.
- Every `/api/platform/*` route requires the `platform:admin` permission on the server. The page is hidden from others, but that is only a convenience.

**Audit log.** The table `audit_log` is **append-only** (database triggers refuse update and delete) and survives deletion of the users and workspaces it describes. Each record has who (user, email, the workspace they were in), what, the target workspace or person, the outcome, the client IP (only when `TRUSTED_PROXY_HOPS` makes it trustworthy) and a few small details. It never holds a password (temporary or not), a token, a hash or customer content (details are filtered on the way in).
- Recorded: every Super Admin read of customer records, creating/suspending/reactivating/deleting customers, adding Customer Admins, issuing/revoking temporary passwords, disabling/enabling accounts, Super Admin sign-ins, **refused** attempts at platform actions, invitation acceptance, every password change (whether forced by a temporary password or not), and Customer Admin changes inside their workspace (invitations, role changes, removals).
- A change and its record are written in one transaction: if the record can't be written, the change doesn't happen (and a Super Admin read fails rather than go unrecorded).
- It is designed to be extended: records carry the target workspace, so a customer-facing view of their own workspace's trail is a small addition. Retention and export are not decided yet (see *Security notes*).

### Temporary passwords and the forced first password change

No email, code or link is involved. How it is kept safe:

- **Generation and storage:** 16 random characters from the system's secure random generator (about 93 bits, no look-alike characters, shown as `Abcd-Efgh-Jkmn-Pqrs`). Only a scrypt hash is stored. The password exists in the single response that creates it (`Cache-Control: no-store`) and in the Super Admin's page while it is open: never in the database, the audit log, the server log, the URL or browser storage. If it is lost, reissue a new one.
- **Server-side enforcement:** an account with a temporary password has `users.must_change_password = 1`. `withTenant` (every API route) refuses it with 403 `password_change_required` unless the route opts in (only `/api/auth/me` and `/api/auth/change-password` do; a test enumerates every route file and checks all the others), the request gate answers 403 for product APIs and redirects product pages to `/change-password`, and every server layout goes through `requireSession`, which redirects too. Typing another address into the browser changes nothing.
- **Changing it:** `POST /api/auth/change-password` needs the current (temporary) password again, the 10-character policy, and a password different from the current one. It overwrites the hash in one transaction, ends **all** the account's sessions, starts a fresh one, is rate-limited per account and per client, and is audited without any password. The old temporary password is rejected from then on.
- **Expiry and revocation:** an expired or revoked temporary password can't sign in (the person is told so only after typing it correctly: a wrong guess learns nothing), and a session made with it stops working at the moment it expires. A database trigger refuses a temporary password without an expiry.
- **Sign-in is unchanged for everyone else:** the same generic error for a wrong password, an unknown email or a disabled account, and the same per-account and per-client throttle. A suspended workspace or a disabled account blocks a temporary password like any other.
- **Retry-safe creation:** the form sends one `requestId` per customer. A repeated request (a double click, a lost response) returns the customer that already exists **without any password** and creates nothing; without the id, the name / email / reference checks still make a duplicate impossible. An email that already has an account is refused: it is never attached to a new workspace.
- **Old invitation links keep working** until they are used, withdrawn or expire. Nothing issues new ones.

**Upgrading an existing database.** Migration 10 runs automatically at startup. Before it changes anything the app writes a full copy next to the database (`kb.sqlite.pre-migration-v<N>-<timestamp>.bak`). Everything that existed before is adopted by a private **Default workspace**; set `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD` so someone can sign in to it. Existing sessions are signed out once, and the cached suggested questions are rebuilt. Migration 13 (temporary passwords) is purely additive too: three columns on `users` (every existing account is on its own password), one on `organizations`, and two triggers; the empty `activation_codes` table from migration 12 is no longer used and is left alone. Migration 11 (Super Admin) is purely additive (a workspace status, a Customer Admin flag on invitations and the audit table; nothing is rebuilt or deleted) and is also backed up first. Migration 12 added the optional customer reference (and a table that is now unused).

## Feature Management

**Settings → Feature Management** (`/settings/features`) turns modules on or off. Settings itself is always available.

- **Defaults:** Chat, Dashboard, Documents, Knowledge Base and AI Model Settings are ON. The 11 roadmap modules are OFF.
- **Dependencies:**
  - Documents, AI Agents, Integrations and Category Management need the **Knowledge Base**.
  - AI Model Settings, Widget Management, Email Add-ons, WhatsApp Connections, Channels and Feedback Report need **Chat**.
  - A feature whose dependency is off becomes *Unavailable*. Its toggle is locked, and its saved setting comes back when the dependency is turned on again. Nothing is deleted.
- **What a flag controls:**
  - Sidebar items.
  - Pages: checked on the server, so a disabled page shows *Feature unavailable* even when you type its URL.
  - API routes: they return `403 {"code":"feature_disabled"}`.
  - Feature-specific UI: with the Knowledge Base off, chat skips document search, and the document picker, suggested questions and "Add to Knowledge Base" are hidden.
- **Where flags live:** stored in the `feature_flags` table; features are defined in `src/lib/features.ts`. The server uses `isFeatureEnabled(key)` / `getFeatureFlags()` from `src/server/features/service.ts`. If flags can't be loaded, safe defaults apply (existing features on, roadmap off).
- **Not for secrets:** flags only control availability. API keys stay in `.env`.

## Structured answers and languages

Each answer is **one** response container (`StructuredAIResponse`), laid out as a short **clinical note** that a clinician can scan in 10–15 seconds:

1. **Header:** a small icon, the answer's title and the language menu.
2. **Clinical summary:** one short sentence, in italics, with values, drug names and warnings in upright bold.
3. **Key points:** the first 3–5 bullets (a procedure's ordered steps are never shortened).
4. **Important / Caution:** warnings, contraindications and red flags the sources state, strongest first (*Red flag*, *Warning*, *Important*, each with its own icon and word, so severity never depends on colour). It is **always visible**, never behind "More details".
5. **Reference:** one clickable chip per source, such as "Metformin.pdf — Page 6". A chip (or an inline "p. 6" marker) opens the matching passage.
6. **More details:** collapsed by default (`aria-expanded`). It holds every further section, tables, note and quote callouts, any key points beyond the fifth, and the retrieved passages with their pages and similarity. Nothing the model wrote is dropped: `src/lib/clinical-note.ts` only *arranges* the answer.
7. **Footer:** Listen, Copy (copies the whole note as plain text, cautions and details included, with the references spelled out), provider and time, and a one-line reminder to check the reference and use clinical judgment.

Sections only appear when they are useful: no caution box without a stated caution, no "More details" when there is nothing more, no summary when the model gave none. When the documents don't answer, the card says **"Not established by your documents"** in a neutral box (no sections, no references), and an answer that cites nothing says so instead of looking source-backed. Older stored answers and plain-text answers use the same card. There is a single light theme; text contrast is 5.7:1 or better. Hindi and Gujarati labels are translated, and those two scripts stay upright (browsers only slant them) and keep normal letter-spacing. The card is at most `max-w-3xl` and reflows to phone width without horizontal scrolling.

- **What the model is asked for:** the output rules in `src/server/rag/prompt.ts` (the JSON schema is unchanged): no greetings, introductions or closing remarks; the most useful answer first, about 40–70 words for a routine answer; a one-sentence summary; 3–5 short key points in the first section; cautions as warning/critical sections or callouts; extra material only in further sections (shown under "More details"), none for a simple question; never trim a warning, dose, unit or condition to save words; say what the documents do not establish. Retrieval and the provider calls are unchanged. Answers are not streamed (the whole answer arrives at once).

- **How the answer is produced:** `answerQuestion()` asks the active provider for JSON matching one shared schema (`RESPONSE_JSON_SCHEMA` in `src/server/rag/structured.ts`). Each provider uses its native structured output:
  - OpenAI: `json_schema` in strict mode.
  - Gemini: `responseJsonSchema`.
  - Claude: `output_config.format`, or a forced tool call on older models.
- **Validation:** the server validates and normalizes the JSON with Zod (`src/lib/ai-response.ts`). If it can't be used, the answer is shown as plain text instead.
- **Where source details come from:** document names, pages and excerpts always come from retrieval (the citation system), never from the model. The number of sections varies with the question; the model's per-section topic tab is stored but no longer shown.
- **Not found:** when the documents don't answer the question, the answer says so (`found: false`) and has no sections.
- **History:** answers are stored in `messages.structured_json` and re-rendered from history without calling the AI again.
- **Language (per response):** each response has its own menu (English / हिन्दी / ગુજરાતી; add more in `src/lib/languages.ts`). Changing it updates that same message in place through `POST /api/messages/[id]/language`.
  - **It translates the answer; it does not answer again.** Nothing is retrieved, embedded or searched, and the question is not re-answered. Only the text of the answer (title, summary, headings, bullets, table cells, callout text) goes to the active AI, as a flat list of strings with a short instruction (about 1,000 characters, no passages, no answering rules), and the same number of strings comes back. Sections, kinds, numbered steps, callout types, source numbers and the sources never leave the server, so they cannot change. Code: `src/server/rag/translation.ts` and `src/server/rag/answer-language.ts`.
  - **Every translation is checked before it is used:** each string must keep its `[n]` source markers, its `**bold**` markers and exactly its numbers (Devanagari and Gujarati digits are written as 0–9 first), so a dose, a threshold or a citation cannot be altered unnoticed. The letters are checked too (`scriptProblem` in `translation.ts`): a Gujarati translation must be written in Gujarati script, a Hindi one in Devanagari, and an answer that comes back as Hindi, as untranslated English or as Latin transliteration is refused (drug names, units and abbreviations may stay in Latin letters). A saved version is reused only if it passes the same check, so a "Gujarati" version that is really Hindi is translated again. A failed check is retried once with the reason; if that fails too, the answer is re-made the older, slower way (from its saved passages, with the original as the reference).
  - **No reasoning for a mechanical task.** Translation requests ask the provider for *minimal thinking* (`reasoning: "minimal"` in `LLMRequest`). Gemini's hidden "thinking" was most of the waiting time: on a short translation, 4,409 and 9,396 thinking tokens took 19 s and 40 s, and none took 4.1 s and 4.8 s. It is applied only to Gemini models whose setting is known (`minimalThinking` in `src/server/llm/gemini.ts`), and a model that refuses it is retried without it, so it can't make a request fail. The OpenAI and Anthropic adapters ignore the hint.
  - **Caching:** every version is saved in the message (`messages.variants_json`), together with what it was made from (translation version and a hash of the original text). Switching to a language already done, in any order, costs no model call (measured 2.8-3.8 ms). A version is redone only if the original text or the translation logic changed (`TRANSLATION_VERSION` in `translation.ts`); versions saved before this existed are kept. Translations are always made from the **original** answer, never from another translation, so errors can't compound. The cache lives inside the person's own message, so it is private to that person and workspace by construction; there is no shared or in-memory translation cache.
  - **Quick, repeated choices:** the menu stays usable while a language is being prepared. The page shows a small progress bar and "Translating to …" while the current answer stays readable, then fades the new one in. Choosing another language (or the one already shown) abandons the older request, and the server stops translating it. Only the language chosen last is ever shown, in the page and in the saved message: an older translation that finishes late is saved, not shown. Clicking the language that is already being prepared again does nothing (repeated clicks send one request), and two identical requests at once make one translation.
  - **When it fails** the current answer stays and the button of the language shown stays selected. The message says what happened: for example Google's free daily limit ("daily request limit (20 requests per day) for the model … is used up, and resets in about 20 hours", from `geminiQuotaMessage` in `llm/errors.ts`, instead of a misleading "no credits left"), or that the AI did not return a reliable translation in the language asked for. **Try again** repeats the request.
  - There is no streaming: the provider adapters return whole answers, and a translation is a structured list that can't be shown half-finished.
  - To measure it with the configured provider (a few calls; fictional text only, none of your documents): `LIVE_LANGUAGE_BENCH=1 LANGUAGE_BENCH_OUT=result.json npx vitest run tests/language-switch.live.test.ts` (also `LANGUAGE_BENCH_MODEL`, `LANGUAGE_BENCH_PROVIDER`, `LANGUAGE_BENCH_SAMPLES`, `LANGUAGE_BENCH_FIXTURE`). Free-tier Gemini keys allow only about 20 requests a day per model, so keep `LANGUAGE_BENCH_SAMPLES` small.
  - New answers start in the language you last chose.
  - Retrieval is unchanged. Because the embedding model is English-only, a new question typed in Hindi or Gujarati is first turned into an English search query by the active AI. The answer still uses the original question and the chosen language, while document names, pages and citations stay unchanged.

## Chat attachments

The **+** button in the chat composer (or drag & drop, or pasting an image) attaches files to a single message.

| Type | Formats | Limit | How it's used |
|---|---|---|---|
| Documents | PDF, DOCX, TXT, MD, CSV, XLSX, PPTX | 20 MB each | Text is extracted on the server. Small files (≤ 24,000 characters) are sent in full; larger ones are chunked and embedded **in memory** and the 8 most relevant chunks are sent. They are cited as numbered sources marked *Attachment*. |
| Images | PNG, JPG/JPEG, WEBP | 5 MB each | Sent to the model as real image input (OpenAI `input_image`, Anthropic `image` block, Gemini `inlineData`). |

Up to 5 files and 25 MB per message.

- **Attachments are temporary.** File contents are never stored; only their names, types and sizes are saved with the message. A document goes into the Knowledge Base only if you tick **Add to Knowledge Base** on its chip, and only after the answer succeeds.
- **Validation is on the server.** Types are decided by the file's bytes (magic numbers, and for Office files the archive's contents), never by the browser's MIME type.
- **Image support** is checked per provider and model (`src/lib/capabilities.ts`, best effort). If the model can't take images, the composer shows *"This model does not support image input. Please select a multimodal model."* and the server refuses too.
- **Stop** cancels the request, including the provider call. Nothing is saved, and your text and files go back into the composer.
- Questions still run the normal Knowledge Base retrieval, so an image can be combined with your documents.

### Database

SQLite at `data/kb.sqlite`. Migrations run automatically on startup.

| Table | Contents |
|---|---|
| `users` / `organizations` / `memberships` / `invitations` | accounts, workspaces, who belongs where with which role, hashed single-use invitation tokens |
| `org_settings` | per-workspace settings, including the cached suggested questions |
| `audit_log` | append-only record of sensitive access and administrative changes (no foreign keys, so it outlives what it describes) |
| `consultations`, `consultation_consents`, `consultation_recordings`, `consultation_upload_parts`, `consultation_jobs`, `consultation_transcripts`, `consultation_notes` | doctor consultations (migration 15). Each has `org_id` (cascading from the workspace) and database triggers that keep it equal to its consultation's. Patient label, transcript and note are sealed BLOBs; consents and transcripts can never change, a note is a new version per edit, an approval is final. The doctor, consent recorder and note authors are plain foreign keys with no cascade, so deleting an account can never silently delete health records. |
| `documents` | metadata, processing status (`org_id` on every row) |
| `chunks` | text, page range, Float32 embedding BLOB, embedding model (`org_id`, always equal to its document's) |
| `conversations` / `messages` | chat history; assistant messages keep their citations, provider and model; user messages keep attachment metadata (`attachments_json`, never file contents) |
| `provider_settings` | per-provider model override (no keys); platform-wide |
| `app_settings` | active provider (platform-wide) |

## Chat with (knowledge source)

The **Chat with** selector at the top of Chat decides WHAT DATA a conversation searches. It is separate from the AI model (which model writes the answer) and from each response's language.

- **Options** are built from the indexed documents:
  - **All Knowledge Base**, the default for a new chat.
  - Each website crawled by the Website Scraper, grouped by domain.
  - **Google Drive** and **OneDrive**, each shown only when it has indexed files.
  - Each uploaded document.
- **Filtering is real:** the server resolves the selected source to its documents at question time and passes them to the normal vector search. A source with no indexed content searches nothing; it never falls back to everything.
- **The source is stored with the conversation** (`conversations.knowledge_scope_json`) and restored when the chat is reopened. Changing it in a chat that already has messages asks for confirmation first.
- **Opening a chat on a source:**
  - The sidebar's **Open Chat** on an integration page opens with that integration selected.
  - **Documents → ⋮ → Chat with…** opens with that document, website or drive selected.
  - Both use `/chat?source=website|website:<domain>|google_drive|onedrive|document:<id>`.
- **Sources in answers** show the website domain and page path, the drive name and file, or the document name and page.

## Integrations

**Admin → Integrations** imports content from a website, Google Drive or OneDrive. Each source has its own page (sidebar: Integrations → Website Scraper / Google Drive / OneDrive) with its own on/off switch, settings, last sync and sync history; Back returns to the Integrations overview.

Feature flags (Settings → Feature Management): `sync_integrations` (shown as **Integrations**, off by default) controls the whole area; `website_scraper`, `google_drive` and `onedrive` each control one page and its APIs. Turning any of them off hides the page and blocks its APIs (403) but never deletes connections, credentials, configuration, documents or history.

Imported items go through the **same pipeline as uploads** (extract → chunk → local embeddings → SQLite vectors). They appear in Documents with a source badge, and chat searches them like any other document.

- **Duplicates and updates:** each item is keyed by source and external ID (normalized URL or file ID) and stored with a content hash. When you sync again, unchanged items are skipped, changed items are re-indexed in place (old chunks replaced), and new items are added. Nothing is ever duplicated.
- **Manual only:** sync runs when you click **Sync Now**. It runs in the background on the server, and the page shows live progress. Sync History keeps every run with per-item results.
- **Turning a source off** blocks syncing. It never deletes its configuration, connection, documents or history. **Disconnect** removes the stored OAuth tokens only.

### Website scraper

Enter a start URL, a crawl depth (1 = the page plus the pages it links to, up to 3) and a page limit (10/25/50).

- Only same-site links are followed (`www.` is ignored). URLs are normalized: the fragment, tracking parameters and trailing slashes are removed. `mailto:`, `tel:` and `javascript:` links are ignored.
- Linked PDF, DOCX, TXT and MD files are imported too.
- SSRF protection:
  - Only `http`/`https` on ports 80, 443, 8080 or 8443.
  - Every DNS answer is checked. Private, loopback, link-local, CGNAT and reserved addresses are refused, including after redirects (at most 5).
- Each request has a 10 s timeout and a size cap of `MAX_UPLOAD_MB`. A page that fails is recorded and the crawl continues.
- **Outcomes:**
  - *Added / Updated:* the page's text was indexed.
  - *Skipped:* the page was reached but there is nothing to import. This is not an error. `unchanged` means it is already indexed with identical content. `no_content` means too little text remains after removing navigation, forms and scripts (login pages, search forms, empty pages). `unsupported_content` means a response that isn't a page or document.
  - *Failed:* it could not be loaded or processed (HTTP error, DNS/connection/TLS problem, timeout, too many redirects, a document that can't be read, or an embedding/indexing error).
  - If a crawl finds pages but **none** has any readable content (for example a site that builds its pages with JavaScript, which the scraper doesn't run), the run is reported as failed with that explanation instead of success.
- **Run details:** every item records its outcome, reason, stage (`fetch`, `parse`, `extract`, `index`), category, HTTP status when there was one, the time, and the original technical error (with keys and tokens removed). The Last Sync card lists failed items directly; Sync History shows every item. Each failure is also logged on the server as `[integrations] … item failed`. A URL is tried once; there is no retry.
- The scraper does not read `robots.txt`.

### Google Drive and OneDrive (OAuth — requires your own app registration)

These **do not work until you configure OAuth** in `.env` and restart the server. Until then, their cards list exactly which variables are missing.

| Variable | Needed for |
|---|---|
| `INTEGRATIONS_ENCRYPTION_KEY` | both (encrypts tokens at rest; 32 random bytes, base64) |
| `APP_BASE_URL` | both (builds redirect URIs; default `http://localhost:3000`) |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Google Drive |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` (default `common`) | OneDrive |

Redirect URIs to register:
- Google (Cloud Console, OAuth client type *Web application*, Drive API enabled): `{APP_BASE_URL}/api/integrations/google-drive/callback`
  - Scope: `drive.readonly`
- Microsoft (Entra app registration, platform *Web*): `{APP_BASE_URL}/api/integrations/onedrive/callback`
  - Delegated permissions: `offline_access Files.Read User.Read`

How the connection works:
- Authorization uses the authorization-code flow with PKCE. The `state` value is single-use, expires after 10 minutes and must match an httpOnly cookie.
- Tokens are exchanged server-side and stored AES-256-GCM-encrypted. The client secret and tokens never reach the browser or the logs.
- After connecting, pick a folder and click **Sync Now**. PDF, DOCX, TXT and MD files directly in that folder are imported. Files are skipped if they are too large, unsupported, or unchanged since the last sync (checked by modified time).

## Doctor consultations (recording → transcript → clinical note)

A doctor opens a consultation, confirms the patient's consent, records the visit in the browser (Gujarati, Hindi, English, or all three mixed), and stops. The recording is uploaded, transcribed and turned into a **draft** clinical note in the background; the doctor reviews it, edits it and approves it. Nothing is ever approved, prescribed or sent anywhere by the system on its own.

**Status: built and tested; not yet verified on real recordings.** Everything below is covered by automated tests and by a run in a real browser against a stand-in speech service. What has **not** been done, and cannot be done without you: transcribing real consented Gujarati/Hindi/English recordings with the real provider and measuring how good the result is. Use the evaluation in *Before real patients* first. Do not describe the multilingual transcription as working until you have.

### The workflow

1. **New consultation** (`/admin/consultations`): the doctor enters who the patient is (name or record number: stored encrypted, visible only to them) and the language. They show the patient the consent text in English, हिन्दी or ગુજરાતી, say who agreed (patient, guardian, representative) and how (verbal or written), and tick that the patient agreed. **There is no consultation without this**: the server creates the consultation and the consent record in one step and refuses a recording for a consultation without one. It stores the wording's version and a fingerprint of the exact words in the patient's language.
2. **Record**: Start, Pause, Resume, Stop, with the elapsed time (pauses are not counted), a level meter and a warning if the microphone picks up nothing. If the microphone is unplugged or the browser interrupts, what was recorded is kept. It stops by itself at `CONSULTATIONS_MAX_MINUTES`. Leaving the page (closing the tab, or clicking a link to another page) while recording or sending asks first. **Stopping is not instant, and "saved" means complete:** the browser hands over the last of the audio in a final `dataavailable` event just before it reports `stop` (the recorder asks for it explicitly and waits for it), and the recording is then given its length before it is checksummed and uploaded. A browser writes its WebM *live*, with no duration and no seek index, so a player could not know how long it was: the timeline showed nothing sensible until playback was nearly over (about eight seconds into a ten-second recording), then jumped. `src/lib/webm.ts` adds the one missing element to the file's header and leaves every byte of the audio as recorded; anything it cannot read with certainty is left alone.
3. **Upload**: on Stop the recording is sent to this server, in parts, over the app's own authenticated API (no signed URL, no third-party address, nothing public; the page's Content-Security-Policy still allows connections only to this server). Each part is retried on its own; an interrupted upload resumes; the browser computes a SHA-256 of the whole recording and the server recomputes it and refuses a mismatch. The recording stays in browser memory until the server confirms it; nothing is written to the computer.
4. **Process (background)**: a durable queue in SQLite and a worker inside the server process. The request that finishes the upload returns immediately; transcription never runs inside a web request. Jobs are idempotent, leased (a crashed worker's job is picked up again), retried with backoff when the AI service is busy, and stop with a clear message after four attempts. The doctor sees the stage (waiting / turning the recording into text / drafting the note) and can retry a failure.
5. **Review**: a workspace with the clinical note on the left and the transcript and the recording on the right (stacked on a small screen), each scrolling by itself, with the patient and the status above them and **Save draft** and **Approve note** always in reach. The note is four headings (chief complaint and symptoms, relevant history, assessment, plan and follow-up) over the nine sections the system stores; storage, the server's rules and the audit trail are unchanged. Every line says who it came from (patient reported, doctor observed, doctor's assessment, doctor decided, advice given) and links, with a small `[n]` link, to the transcript line it was taken from; changing who a line came from or removing it is under that line's **Details**. A heading with nothing under it says **Not discussed**. Safety flags sit at the top, compact, and must each be marked reviewed. The doctor edits freely; every save is a new version. The transcript is loaded (and its reading recorded, see below) when the note is opened, because it is on screen beside the note.
6. **Approve**: an explicit confirmation, for the newest version only, and only when every flag has been reviewed. If there are unsaved edits they are saved first and that version is the one approved. An approved version can never be changed; "Reopen" makes a new editable copy and leaves the approved one exactly as it was.

### The recording player and transcript times

The recording is played by its own player (`components/consultations/RecordingPlayer.tsx`), not the browser's bare audio controls. It shows what is actually known: the length stored with the recording until the browser has learned the real one, and the position the audio is really at. It never plays by itself (only a click on Play or Play again does), it loads nothing until then (so a server record of someone listening means they listened), it exists only for a recording that is stored (while one is being saved, or after it was deleted, it says so and there is no audio at all), and re-renders, status polling and transcript refreshes never touch it. If the player is removed and comes back it is paused where it was left. A recording it cannot load shows why, with **Try again**, rather than a finished-looking player. It makes no object URLs: the source is the server's own address for the stored recording.

A transcript line can take the doctor to the point in the recording where it starts **only if the speech service measured a real start time** for it (`startMs`); picking it moves the player and does not start or stop it. The Gemini transcription used here does not return times, so today no line has one: none is shown, none is estimated, and the transcript says "these lines have no times".

### What the note is made from, and how it is checked

The note is drafted from the **transcript text only** (the audio is not given to the note step). The model must cite the transcript segments each statement comes from. The server then checks the draft against the transcript, in code, before the doctor sees it:

- a statement that cites nothing real is **removed**, and the doctor is told how many were;
- every number in the sections where a wrong number is dangerous (medications, findings, investigations, medication decisions) must appear in the cited words, in any of the three scripts or spelled as a small number word ("twice", "દો"), otherwise the line is **flagged**;
- a medication instruction needs the doctor's exact words, copied from the transcript, otherwise it is **flagged**;
- a line attributed to the doctor that cites only words labelled as the patient's (or the reverse) is **flagged**: the speaker labels are inferred;
- every transcript segment the speech service marked as not clearly heard, and relied on by the note, is **flagged**.

Nothing flagged is hidden or silently dropped without a count, and flags can only be marked reviewed, never deleted or reworded (the server enforces it). The doctor's edits are checked too: the browser cannot claim a line is untouched AI text or remove a flag.

### Privacy, access and audit

- **Who**: only the Doctor role, and only for consultations that doctor recorded. Another doctor, an owner, an administrator and the Super Admin all get "not found" or "forbidden", for every route, including by guessing ids. Each refused attempt is written to the audit log.
- **At rest**: patient label, transcript, note and every audio part are sealed with AES-256-GCM (`CONSULTATIONS_ENCRYPTION_KEY`), each value bound to its workspace and record so a sealed value copied elsewhere will not open. A copy of the database or of a backup shows none of it. Audio sits under random folder names that say nothing about who it belongs to.
- **Audit** (`audit_log`, append-only): create, consent, recording start/stored, every view of the transcript or note, every listen, edit, approve, reopen, retry, delete, and the worker's completion or failure. Events never contain the patient's name, a transcript, a note or audio. **Reading a transcript, a note or the audio fails if the event cannot be written** (nothing is served unlogged); other events are best-effort. Only a refused access to a consultation that is not yours (or does not exist) counts as an "access denied" event, not an ordinary "no note yet"; one person's denied events are capped (20 per 10 minutes) so the log, which can never be pruned, cannot be flooded. The list and the open-consultation screen show the doctor their own patient labels without an event (the audited acts are opening or playing a recording, transcript or note). (The Super Admin console reads the audit log; a customer-facing view is not built.)
- **Logs**: the server never logs audio, transcripts, notes or patient details. Unexpected errors are logged by type only, because an error message can quote what it was handling; the shared AI layer is told the note request is sensitive (`LLMRequest.sensitive`) and then withholds the provider's own wording from the log and from errors, except for rejected keys, unknown models and quotas, which never quote a request.
- **Deletion**: the doctor can delete a recording (the transcript and note stay) or a whole consultation (everything), with a typed confirmation; both are audited. **Audio is kept until deleted manually**: there is no automatic expiry. Deleting a workspace in the Super Admin console deletes its recordings from storage too; if a file can't be removed it is reported and the worker's sweep removes storage that nothing refers to any more (once it is more than a day old). **The audio folder must belong to exactly one database**: that sweep is irreversible, so restoring an old database backup, or pointing a second copy of the app with a different database at the same folder, would make it delete recordings that database does not know about (after a day). If you restore a backup, restore the audio folder from the same moment, or move the newer folders aside first. The sweep runs inside the worker, so with `CONSULTATIONS_WORKER=false` it never runs.
- **Retention of transcripts and approved notes** is a policy decision for your organisation and the law where you practise (medical-record retention and the right to erasure can conflict). The system currently lets the doctor delete an approved note. Decide before real use.

### The privacy gate (nothing is sent until you have reviewed the provider)

A recording, and its transcript, can only be sent to an AI service when ALL of these are set: `CONSULTATIONS_ENCRYPTION_KEY`, `CONSULTATIONS_TRANSCRIPTION_PROVIDER` and model, a note model, the provider's API key, `CONSULTATIONS_PROVIDER_REVIEW` (who reviewed its data handling, when, and what they decided) and `CONSULTATIONS_PROVIDER_REGION` (where it is processed). Until then recordings are accepted and kept, sealed, and the doctor sees "stored safely, processing hasn't been approved"; the queue simply waits. The server log (never the doctor) says what is missing. Also off by default: a platform administrator must switch **Doctor Consultations** on in Feature Management.

**The privacy gate is a procedural control, not a technical one**: it cannot tell a free-tier Gemini key from a paid one, or check any terms. It makes sure someone wrote down, by name and date, that they reviewed the provider; it cannot make that review correct. Note too that the consent text tells the patient the recording goes to "the AI service that turns the speech into text", which is only honest if that is what you have set up.

Things to settle before you set `CONSULTATIONS_PROVIDER_REVIEW` (these are your decisions, not code): whether the Gemini key is on a paid tier whose terms say your content is not used to improve Google's products (the free tier may use it); whether health data may be processed in that region under the law that applies to you (for example India's DPDP Act) and your own policies; whether you need a data-processing agreement or a provider with a healthcare agreement; and whether to move to another speech provider (the transcription step is a small interface, `server/consultations/transcription/types.ts`, so another is one class).

### Setup

1. Generate the key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, put it in `CONSULTATIONS_ENCRYPTION_KEY`, and **back it up**: without it stored consultations cannot be opened. Keep it the same across deployments.
2. Invite doctors as role **Doctor** (Settings → Team).
3. Set the provider, models, review and region (see the gate). For the pilot, Gemini is the one supported speech provider.
4. A platform administrator switches **Doctor Consultations** on (Settings → Feature Management).
5. Serve the app over HTTPS (browsers only allow the microphone on a secure connection; `localhost` counts).

The microphone is allowed for this app's own pages only (`Permissions-Policy: microphone=(self)`; camera, geolocation and the rest stay off).

### Testing without any real AI service (mock mode)

To try the whole workflow, with fake patients and no provider, run a **second copy** of the app against a stand-in for Gemini (`scripts/fake-gemini.mjs`). It uses the real Google client library, so what you test is the real code path. It returns the same fixed Gujarati/Hindi/English transcript and the same draft note every time (the transcript's remarks say "MOCK AI", so a result can't be mistaken for a real one). **It does not test how well Gemini hears Gujarati or Hindi**: the transcript does not depend on what you say. The consultation screen says so too: a transcript made by the mock shows a **Test data** banner over both columns and a tag on the transcript, and the transcript's details name the mock model. Only the evaluation in *Before real patients* can measure that.

```
npm run build                   once, if you have not built since the last code change (the test copy runs the production build)
npm run mock:start              starts the stand-in and the test copy, seeds it, runs the checks below, then stays running
npm run mock:check              (second terminal) records one fake consultation through it and proves what the stand-in received
npm run mock:status             is it running, and how many requests the stand-in has handled
npm run mock:stop               stops both (Ctrl+C in the window running them does the same)
npm run mock:start -- --db copy the test database starts as a read-only copy of your real one (default: empty)
npm run mock:start -- --fail-first   the first transcription fails once with "service busy", to see the retry
npm run mock:ai                 just the stand-in, on http://127.0.0.1:3299, if you want to point something else at it
```

Open **`http://127.0.0.1:3400`** (not `localhost`: browsers keep separate cookies per host name, so your real app's sign-in on `localhost:3000` is never touched). The throwaway accounts are in `data-mock/CREDENTIALS.txt`: a Doctor who can record, and an Owner/Super Admin. The consultations feature is already on, **inside the test database only**.

What is isolated, and why you can trust it (`tests/mock-consultations.test.ts`, `tests/fake-gemini.test.ts`):

- **Your `.env`, database and audio are never used or changed.** The launcher does not read `.env`. It builds the test app's environment itself from a short list of harmless variables plus explicit settings; every setting that could carry a real secret or reach a real service (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `INTEGRATIONS_ENCRYPTION_KEY`, the OAuth secrets, `DEMO_USER_PASSWORD`, the Google client's own variables) is set to empty, which stops the app's `.env` loader from filling it in. `GEMINI_API_KEY` is replaced by `fake-gemini-key-for-mock-testing`. The consultation settings (encryption key, provider, models, review, region) exist only in that process's environment. Your normal environment still has the feature off and no `CONSULTATIONS_*` settings.
- **Separate data, under `data-mock/` (ignored by git):** the database (`data-mock/db`), the sealed audio (`data-mock/audio`), temp files, logs, a throwaway encryption key and passwords. The launcher refuses to start if any of these overlap your `data/` folder. `--db copy` opens your real database **read-only** to write a separate snapshot (it works while your app is running) and never modifies, migrates or locks it; the copy then gets a throwaway owner and none of your sign-in sessions. The empty database is the safer default: it holds no real users, documents or connected-account tokens (the test app can't decrypt tokens anyway: their key is blanked).
- **The stand-in cannot forward anything.** It listens on 127.0.0.1 only (there is no option to change that) and refuses requests addressed to any other host name. It contains no network client code (a test reads its source and fails if any appears), is not a proxy, and answers anything it does not know with a 400. It accepts only API keys that start with `fake-`; any other key gets a 401 and is never recorded. Its request log (`data-mock/run/mock-requests.jsonl`) holds sizes and a fingerprint of the audio, never the audio, transcript text or a key.
- **Nothing in the test app can reach the internet either.** `scripts/loopback-only.cjs` is preloaded into the stand-in, the launcher and the test app, and refuses every outgoing connection that is not to this computer, before any name lookup. So if the Google client library ever stopped honouring `GOOGLE_GEMINI_BASE_URL`, a recording would fail with "blocked a connection to generativelanguage.googleapis.com" instead of going to Google. (It covers Node's own networking, not native add-ons or other programs.)
- **The launcher proves the stand-in is the AI in use** (`mock:start` and `mock:check`): the stand-in identifies itself and refuses a non-fake key; the test app can sign in with the throwaway accounts (so it is using the test database); its Gemini key ends with the fake key's last four characters and no other provider has a key; a fake recording is uploaded and the stand-in reports receiving exactly that audio (same SHA-256 and size) with the fake key, and drafting the note from the transcript only; the stored transcript and note carry the mock model names and the stand-in's fixed text; the audio landed in the test audio folder and nothing in yours; then the check's consultation is deleted again. If any check fails, `mock:start` stops the test app instead of leaving it running.

Limits: the test app runs the **production build**, so rebuild (`npm run build`) after changing code (the launcher warns when `src/` is newer than the build). Nothing is deleted by these commands: when you are done, stop the setup and, if you want, remove the `data-mock` folder yourself. The privacy-review and region settings in mock mode say "MOCK TEST ONLY" on purpose; they must never be copied to a real setup.

### Storage: local disk for now

Audio is stored in a **private folder on this server** (`CONSULTATIONS_AUDIO_DIR`, default `DATA_DIR/consultation-audio`), each part sealed. Nothing serves that folder; the only way audio leaves is the authenticated "listen" route for the doctor who owns it. This is the pilot setting. Before real patients, use real cloud object storage (a private bucket, encryption, access logging, backups, a lifecycle policy) behind the small `AudioStore` interface (`server/consultations/audio-store.ts`: put, get, delete, list): a cloud driver only ever receives already-sealed bytes, so the provider holds ciphertext. Back up the audio folder together with the database, or recordings and records fall out of step.

### Before real patients: verify, with real consented recordings

`tests/consultation-eval.live.test.ts` runs the real speech service on a folder of consented recordings and measures it against reference transcripts you provide. It will not run unless you confirm consent and the privacy gate is open, and it prints only numbers to the console (the transcripts go to a report file in your folder).

```
CONSULT_EVAL_DIR=D:\samples CONSULT_EVAL_CONFIRM_CONSENTED=yes npx vitest run tests/consultation-eval.live.test.ts
```

Put `visit-01.webm` (or .wav .mp3 .m4a .ogg), optionally `visit-01.reference.txt` (what was said, written by a person who speaks the languages, each in its own script) and `visit-01.terms.txt` (drug names and doses, one per line) in that folder. It reports word and character error rate, **script drift** (a language returned in the wrong script), number and drug-term recall, speaker labels, uncertain segments and latency; `CONSULT_EVAL_NOTE=1` also drafts a note and reports the safety flags. Use recordings that look like your real visits: Gujarati-Hindi-English switching inside sentences, drug names said in English, background noise, two voices. A few recordings show where the service is weak; they cannot prove it is safe.

### Manual test steps

1. As a platform administrator turn the feature on; as an owner confirm there is no *Consultations* menu item and the page says it is for doctors.
2. Sign in as a doctor: New consultation → try to continue without each consent item (the button stays disabled) → complete it → Start recording (allow the microphone) → speak for ~15 seconds in a mix of languages → Pause, wait, Resume → Stop and save.
3. Watch the stage change; open the note: check each line against what you said, click a `[n]` link to bring that transcript line into view, mark flags reviewed, edit a line, Save draft, then approve. Press play on the recording: it starts paused, shows its real length, plays, pauses, resumes, seeks with the slider and plays again from the start. Leaving the page and coming back finds it paused where you left it. (In the mock test setup the transcript and note are marked **Test data**: the mock's text is fixed and unrelated to what you said.)
4. Reopen the note and confirm version 3 appears while version 2 is unchanged; delete the recording, then the consultation.
5. Check the audit log in the Super Admin console shows the events and none of the content.
6. Try the unhappy paths: stop the server mid-upload and reload (it says the upload was interrupted); set a wrong AI key (the doctor sees a plain message, with a retry); clear `CONSULTATIONS_PROVIDER_REVIEW` (recordings wait, nothing is sent).

### Files

Server: `src/server/consultations/` (`repository.ts` the doctor- and workspace-scoped data access; `recording.ts` upload and validation; `audio-store.ts`; `jobs.ts` + `worker.ts` + `processing.ts` the queue; `transcription/` the speech step; `note-ai.ts` drafting and the checks above; `note-rules.ts` what a doctor's edit may change; `gate.ts` the privacy gate; `api.ts` what every route shares), `src/server/security/vault.ts` (sealing), `src/app/api/consultations/**` (routes), migrations 14 (Doctor role) and 15 (tables). Browser: `src/components/consultations/`, `src/lib/consultation-upload.ts`, `src/lib/consultation-consent.ts`.

## Security notes

- API keys live only in `.env` on the server. They are never written to the database, never returned by the API and never logged. Provider errors pass through a redaction step before they are logged or shown.
- Retrieved document text goes into the prompt as untrusted data, and the model is told to ignore any instructions it contains.
- `POST /api/ask` and `POST /api/documents` reject cross-site requests (requests whose `Origin` doesn't match the host).
- Workspaces are isolated by the layers described in *Multi-tenancy, users and roles*. Isolation is **logical**: all customers share one SQLite file and one process. That is strong against application bugs (it is tested), but it is not a hard boundary like separate databases; regulated customers may need dedicated deployments.
- The AI provider keys, models and cost are shared by all workspaces, and there are no per-workspace usage quotas yet.
- Not built yet: a way for a customer who has chosen their own password and then forgotten it to recover it (a Super Admin can't reissue it, on purpose; a self-service reset needs a trusted channel such as email), MFA, and rate limits on the AI endpoints. A temporary password is as safe as the way you send it: use a private channel. Don't expose the app publicly without a plan for these. The audit log only grows (it is append-only by design): decide a retention and export policy before it matters.
- Leave `DEMO_USER_PASSWORD` unset on production. If you do enable the demo, use a strong password; it only reaches the separate Demo workspace.

## Deployment

**Serverless hosting such as Vercel is not supported as-is.** The app keeps all state on the local disk:
- `DATA_DIR/kb.sqlite` holds sessions, documents, chunks and embeddings, chats, feature flags, integration settings, encrypted OAuth tokens and sync history.
- `DATA_DIR/models` holds the embedding model.

It also runs integration syncs in the background after the HTTP response is sent. On serverless functions the disk is temporary and separate per instance, and work stops when the response ends.

**Run it on a persistent Node.js host.** That can be a VM, a container with a persistent volume, or a platform like Fly.io, Render or Railway with a disk:
1. `npm ci`, then `npm run build`, then `npm run start`. Put HTTPS in front of it.
2. Put `DATA_DIR` on a persistent volume.
3. Set `APP_BASE_URL=https://<domain>`. This also makes the session cookie `Secure` and builds the OAuth redirect URIs.
4. Set the AI keys and models, `BOOTSTRAP_OWNER_EMAIL` / `BOOTSTRAP_OWNER_PASSWORD`, and `INTEGRATIONS_ENCRYPTION_KEY`. Keep the same encryption key across deployments, or stored OAuth tokens can't be decrypted. Set `TRUSTED_PROXY_HOPS` to the number of proxies in front of the app, and leave `DEMO_USER_PASSWORD` unset.
5. Register `https://<domain>/api/integrations/google-drive/callback` in Google Cloud and `https://<domain>/api/integrations/onedrive/callback` in Microsoft Entra.
6. **Doctor consultations** (only if you use them; see that section): set `CONSULTATIONS_ENCRYPTION_KEY` and back it up; keep `CONSULTATIONS_AUDIO_DIR` (default `DATA_DIR/consultation-audio`) on the same persistent volume and in the same backups as the database; the background worker runs inside the one server process (run ONE instance: a second instance on the same files would be safe for the queue, which is leased, but not designed or tested here); HTTPS is required for the microphone. Migrations 14 and 15 run on start, with an automatic full backup first (`kb.sqlite.pre-migration-v13-….bak`); migration 14 rebuilds the `memberships` and `invitations` tables to add the Doctor role, and was verified against a copy of a real database (every row identical afterwards).

To use Vercel instead, the storage layer must move to hosted services:
- A hosted database for everything in `kb.sqlite`, with vector search.
- A hosted embedding model or API, which requires re-indexing all documents.
- A durable job runner for integration syncs.

`next.config.ts` sends security headers on every response: CSP, `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`, and HSTS in production.

## Scripts

| Command | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js (Webpack) |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` / `lint` | TypeScript / ESLint |
| `CONSULT_EVAL_DIR=<folder> CONSULT_EVAL_CONFIRM_CONSENTED=yes npx vitest run tests/consultation-eval.live.test.ts` | The check to run on real consented recordings before real patients (see *Doctor consultations*). Skipped by default; sends audio to the AI provider. |
| `npm run owner:recover` | Dry run of the owner-account repair described under *Passwords and sign-in errors* (add `-- --apply`, and `--reset-password` if needed, to make the changes) |

## Known limitations (by design for the MVP)

- Each question is answered on its own; follow-ups don't use earlier turns as context.
- OCR covers scanned PDFs only (see *Scanned PDFs (OCR)*); image files can't be added to the Knowledge Base, only attached to chat messages.
- DOCX, TXT, MD, CSV and XLSX have no page numbers, so their citations name the file only. PPTX citations use the slide number.
- Image thumbnails are shown only in the current browser session (images aren't stored), and the image capability check is based on model-name patterns.
- Uploads are processed within the request. Very large files take a while.
- **Doctor consultations** (see that section for the whole picture): not yet verified on real recordings; **the browser's Back button is not intercepted** while recording (closing the tab, reloading and clicking links are), so Back discards the recording in the page; Pause stops capturing and switches the microphone track off, but the browser keeps the microphone permission, so its recording indicator may stay on until you stop; a sign-in that ends while a recording waits to be sent keeps the recording on the page and asks the doctor to sign in again in another tab (sessions last a fixed 24 hours, so a visit that spans the end of a session is the risk); the consent wording in Hindi and Gujarati is a machine-drafted translation that a native-speaking clinician must check; one workspace may hold at most `CONSULTATIONS_MAX_STORAGE_GB` of audio (25 by default; a workspace at its limit cannot record until recordings are deleted); the worker takes no work for a suspended workspace, a disabled doctor, a doctor who was removed or given another role, or while the feature is switched off (the work waits and runs when that is put right); speaker labels are inferred by the model (Gemini does no voice-based separation) and are flagged as such; recording length is capped (45 minutes by default) because one transcription call has an output limit; a recording lives in the browser tab until the server confirms it, so closing the tab mid-upload loses it (the app asks first); local-disk audio storage is a pilot setting; the transcript is produced in one call, so a failed call is retried whole; there is no automatic retention or expiry; owners and administrators cannot see or delete a departed doctor's consultations (only the Super Admin, by deleting the whole workspace); notes are written in English; the consent wording is a draft that needs your clinical and legal review.
- No streaming responses.
- Multi-tenancy and the Super Admin console cover the foundations only: no billing, quotas, email of any kind (invitations and credentials are handed over by you), SSO, or per-workspace AI keys yet. Documents are shared by everyone in a workspace (no per-document permissions).
