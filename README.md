# AI Knowledge Base (MVP)

Upload PDF, DOCX or TXT documents and chat with them. Answers come from **OpenAI**, **Anthropic Claude** or **Google Gemini** (you pick the active provider) and include citations back to the source document and page.

Only the chunks relevant to the question are sent to the LLM, never the whole document.

```
Document → extraction → chunking → local embeddings → SQLite vector store
Question → local embedding → top-k retrieval → active LLM → answer + citations
```

## Screens

`http://localhost:3000` opens the public **landing page**. **Try the AI Demo** leads to `/login`; after signing in you land on the admin **Dashboard** (or the page you originally asked for). The sidebar's **Open Chat** button, and the chat's **Admin** button, switch between the two areas.

| Route | Screen | Status |
|---|---|---|
| `/admin` | **Dashboard**: document, chunk, conversation and question counts; recent documents; active model | Working |
| `/admin/documents` | **Documents**: upload (drag & drop, multiple files), search, status filter, delete | Working |
| `/admin/ai-models` | **AI Model Settings**: choose the active provider, set model IDs, see API key status | Working |
| `/admin/integrations` | **Integrations** overview, opening one page per source: `/admin/integrations/website-scraper`, `/admin/integrations/google-drive`, `/admin/integrations/onedrive` (the old `/admin/sync-integrations` redirects here) | Working (Google Drive / OneDrive need OAuth setup) |
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

1. In `.env`, set the API key **and** a model ID for at least one provider (see below). Restart the server after editing `.env`.
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
| `MAX_UPLOAD_MB` | Upload size limit (default 20). |
| `DATA_DIR` | Where the SQLite database and model cache live (default `./data`). |

A provider is **ready** when it has both an API key and a model ID.

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
    │   ├── extract/          PDF (per page, unpdf) · DOCX (mammoth) · TXT
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
    └── db/                   SQLite connection, migrations, repositories
```

Because embeddings are computed locally and don't depend on the chat provider, a document is indexed once and works with all three providers.

The `Embedder` and `VectorStore` interfaces are the extension points for hosted embeddings or pgvector.

## Landing page, sign-in and demo account

- `/` is a public landing page and `/login` the sign-in page. Everything else is the product and requires a session: `/admin/*`, `/chat`, `/settings/*`, `/app`, and every API except `/api/auth/*`.
- **Demo account:** `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` in `.env` (defaults `demo@knowledgebase.ai` / `Demo@12345`). This is only the app login; it has nothing to do with the AI provider keys. The login page shows these credentials and a **Use Demo Account** button. Set `DEMO_SHOW_CREDENTIALS=false` to hide both for a shared deployment.
- **Sessions:**
  - Signing in creates a server-side session (table `auth_sessions`). The browser gets only a random 256-bit token in an httpOnly, SameSite=Lax cookie (`Secure` when `APP_BASE_URL` is https), and the database stores only its SHA-256 hash.
  - Sessions last `AUTH_SESSION_HOURS` (default 24) and survive page refreshes and server restarts.
  - **Logout** deletes the session on the server, so the old cookie stops working immediately, and returns you to `/`.
- **Where sessions are checked:**
  - `src/proxy.ts` checks the session in the database for every product page and API. Pages redirect to `/login?redirect=<page>`; APIs answer 401.
  - The product layouts check the session again on the server.
  - After sign-in you return to the requested page. Only this site's product pages are allowed as return targets, so there are no open redirects.
- **Sign-in errors:** a wrong email or password gets the same generic message. There are at most 10 failed attempts per client per 15 minutes.
- **Branding:** the product name and taglines live in one place, `src/lib/brand.ts`.

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

Each answer is **one** response container (`StructuredAIResponse`). It holds a title with a language menu top-right, a summary, numbered sections (content, bullets, and optional **Info / Warning / Important / Quote** callouts), readable source chips such as "Metformin.pdf — Pages 6–7", source cards and the retrieved passages. Clicking a source opens the matching passage.

- **How the answer is produced:** `answerQuestion()` asks the active provider for JSON matching one shared schema (`RESPONSE_JSON_SCHEMA` in `src/server/rag/structured.ts`). Each provider uses its native structured output:
  - OpenAI: `json_schema` in strict mode.
  - Gemini: `responseJsonSchema`.
  - Claude: `output_config.format`, or a forced tool call on older models.
- **Validation:** the server validates and normalizes the JSON with Zod (`src/lib/ai-response.ts`). If it can't be used, the answer is shown as plain text instead.
- **Where source details come from:** document names, pages and excerpts always come from retrieval (the citation system), never from the model. The number of sections varies with the question.
- **Not found:** when the documents don't answer the question, the answer says so (`found: false`) and has no sections.
- **History:** answers are stored in `messages.structured_json` and re-rendered from history without calling the AI again.
- **Language (per response):** each response has its own menu (English / हिन्दी / ગુજરાતી; add more in `src/lib/languages.ts`). Changing it updates that same message in place through `POST /api/messages/[id]/language`.
  - The answer is regenerated from the exact passages it was grounded in, which are saved with the message, so no new search is run. The current answer is used as the reference, and the sources never change.
  - Every language version is saved, so switching back is instant.
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
| `documents` | metadata, processing status |
| `chunks` | text, page range, Float32 embedding BLOB, embedding model |
| `conversations` / `messages` | chat history; assistant messages keep their citations, provider and model; user messages keep attachment metadata (`attachments_json`, never file contents) |
| `provider_settings` | per-provider model override (no keys) |
| `app_settings` | active provider, cached suggested questions |

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

## Security notes

- API keys live only in `.env` on the server. They are never written to the database, never returned by the API and never logged. Provider errors pass through a redaction step before they are logged or shown.
- Retrieved document text goes into the prompt as untrusted data, and the model is told to ignore any instructions it contains.
- `POST /api/ask` and `POST /api/documents` reject cross-site requests (requests whose `Origin` doesn't match the host).
- Sign-in is a single demo account (see *Landing page, sign-in and demo account*), meant for demos, not multi-user production. Change the demo password and hide it (`DEMO_SHOW_CREDENTIALS=false`) before exposing the app publicly.

## Deployment

**Serverless hosting such as Vercel is not supported as-is.** The app keeps all state on the local disk:
- `DATA_DIR/kb.sqlite` holds sessions, documents, chunks and embeddings, chats, feature flags, integration settings, encrypted OAuth tokens and sync history.
- `DATA_DIR/models` holds the embedding model.

It also runs integration syncs in the background after the HTTP response is sent. On serverless functions the disk is temporary and separate per instance, and work stops when the response ends.

**Run it on a persistent Node.js host.** That can be a VM, a container with a persistent volume, or a platform like Fly.io, Render or Railway with a disk:
1. `npm ci`, then `npm run build`, then `npm run start`. Put HTTPS in front of it.
2. Put `DATA_DIR` on a persistent volume.
3. Set `APP_BASE_URL=https://<domain>`. This also makes the session cookie `Secure` and builds the OAuth redirect URIs.
4. Set the AI keys and models, a non-default `DEMO_USER_PASSWORD`, and `INTEGRATIONS_ENCRYPTION_KEY`. Keep the same encryption key across deployments, or stored OAuth tokens can't be decrypted.
5. Register `https://<domain>/api/integrations/google-drive/callback` in Google Cloud and `https://<domain>/api/integrations/onedrive/callback` in Microsoft Entra.

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

## Known limitations (by design for the MVP)

- Each question is answered on its own; follow-ups don't use earlier turns as context.
- No OCR, so scanned PDFs are rejected with a clear message.
- DOCX, TXT, MD, CSV and XLSX have no page numbers, so their citations name the file only. PPTX citations use the slide number.
- Image thumbnails are shown only in the current browser session (images aren't stored), and the image capability check is based on model-name patterns.
- Uploads are processed within the request. Very large files take a while.
- No streaming responses, no multi-user support.
