import "server-only";
import { z } from "zod";
import { isFeatureEnabled } from "@/server/features/service";
import {
  CRAWL_DEPTHS,
  INTEGRATION_META,
  MAX_PAGE_OPTIONS,
  type CloudFolderDTO,
  type IntegrationConfig,
  type IntegrationDTO,
  type IntegrationType,
  type SyncRunDetailDTO,
  type SyncRunItemDTO,
  type SyncRunStatus,
  type SyncRunSummaryDTO,
} from "@/lib/integrations";
import type { AppConfig } from "../config";
import { upsertSourceDocument, type IngestDeps, type UpsertResult } from "../knowledge/ingest";
import { DocumentRepository, type DocumentSource } from "../db/repositories";
import { googleDrive, oneDrive, type CloudDrive, type CloudFile } from "./cloud";
import { IntegrationAuthError, IntegrationError } from "./errors";
import { buildAuthorizeUrl, createPkce, exchangeCode, oauthStatus, providerLabel, revokeTokens, statesMatch, TokenStore, type OAuthType } from "./oauth";
import { IntegrationRepository, type IntegrationRow, type RunTotals, type SyncRunRow } from "./repository";
import { crawl, normalizeUrl } from "./website/crawler";
import { safeFetch, validatePublicUrl, type FetchedResource } from "./website/safe-fetch";
import { parseHtmlPage } from "./website/html";

const SUPPORTED_FILE = /\.(pdf|docx|txt|md|markdown)$/i;
const MIN_PAGE_TEXT = 40;

export interface IntegrationServiceDeps extends IngestDeps {
  config: AppConfig;
  /** Injectable for tests; production uses safeFetch / the real APIs / encrypted token storage. */
  fetchPage?: (url: string, opts: { checkRedirect: (u: URL) => string | null }) => Promise<FetchedResource>;
  drives?: Record<OAuthType, CloudDrive>;
  getAccessToken?: (row: IntegrationRow) => Promise<string>;
  isFeatureEnabled?: (key: Parameters<typeof isFeatureEnabled>[0]) => boolean;
}

const websiteConfigSchema = z
  .object({
    url: z.string().trim().max(2000).optional(),
    depth: z.number().int().refine((d) => (CRAWL_DEPTHS as readonly number[]).includes(d), "Crawl depth must be 1, 2 or 3").optional(),
    maxPages: z.number().int().refine((d) => (MAX_PAGE_OPTIONS as readonly number[]).includes(d), "Max pages must be 10, 25 or 50").optional(),
  })
  .strict();

const cloudConfigSchema = z
  .object({
    folderId: z.string().trim().regex(/^[A-Za-z0-9!_.:-]{1,200}$/, "Invalid folder ID").optional(),
    folderName: z.string().trim().max(500).optional(),
    syncMode: z.literal("manual").optional(),
  })
  .strict();

// Syncs currently running in this process (guards against double-starts between the check and the status update).
const running = new Set<string>();

export class IntegrationService {
  readonly repo: IntegrationRepository;
  private readonly tokens: TokenStore;
  private readonly drives: Record<OAuthType, CloudDrive>;
  private readonly featureOn: (key: Parameters<typeof isFeatureEnabled>[0]) => boolean;

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.repo = new IntegrationRepository(deps.db);
    this.tokens = new TokenStore(this.repo, deps.config);
    this.drives = deps.drives ?? { google_drive: googleDrive, onedrive: oneDrive };
    this.featureOn = deps.isFeatureEnabled ?? isFeatureEnabled;
  }

  // ── Read ──

  private runSummary(r: SyncRunRow): SyncRunSummaryDTO {
    return {
      id: r.id,
      integrationId: r.integration_id,
      integrationType: r.integration_type,
      integrationName: r.integration_name,
      status: r.status,
      startedAt: r.started_at,
      completedAt: r.completed_at,
      filesFound: r.files_found,
      filesAdded: r.files_added,
      filesUpdated: r.files_updated,
      filesSkipped: r.files_skipped,
      filesFailed: r.files_failed,
      errorMessage: r.error_message,
    };
  }

  toDTO(row: IntegrationRow): IntegrationDTO {
    const oauth = row.type === "website" ? null : oauthStatus(row.type, this.deps.config);
    const latest = this.repo.latestRun(row.id);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled === 1,
      status: row.enabled === 1 ? row.status : "disabled",
      configuration: this.repo.config(row),
      accountLabel: row.account_label,
      lastError: row.last_error,
      lastSyncAt: row.last_sync_at,
      lastRun: latest ? this.runSummary(latest) : null,
      oauth,
      connected: row.type === "website" ? true : this.repo.getCredentials(row.id) !== null,
    };
  }

  list(): IntegrationDTO[] {
    return this.repo.list().map((r) => this.toDTO(r));
  }

  get(id: string): IntegrationRow {
    const row = this.repo.get(id);
    if (!row) throw new IntegrationError("Integration not found.", 404);
    return row;
  }

  /** One integration's sync history; blocked when that integration's feature is off. */
  runsFor(id: string): SyncRunSummaryDTO[] {
    this.assertAvailable(this.get(id).type);
    return this.listRuns(id);
  }

  listRuns(integrationId?: string): SyncRunSummaryDTO[] {
    return this.repo.listRuns(integrationId, 30).map((r) => this.runSummary(r));
  }

  runDetail(runId: string, integrationId?: string): SyncRunDetailDTO {
    const run = this.repo.getRun(runId);
    if (!run || (integrationId && run.integration_id !== integrationId)) throw new IntegrationError("Sync run not found.", 404);
    this.assertAvailable(run.integration_type);
    let items: SyncRunItemDTO[] = [];
    try {
      items = run.details_json ? (JSON.parse(run.details_json) as SyncRunItemDTO[]) : [];
    } catch {
      items = [];
    }
    return { ...this.runSummary(run), items };
  }

  /** Features gate each integration: the parent (sync_integrations) and the integration's own flag. */
  assertAvailable(type: IntegrationType): void {
    const meta = INTEGRATION_META[type];
    if (!this.featureOn("sync_integrations") || !this.featureOn(meta.feature)) {
      throw new IntegrationError(`${meta.name} is disabled by the administrator.`, 403);
    }
  }

  // ── Configure ──

  update(id: string, patch: { enabled?: boolean; configuration?: unknown }): IntegrationDTO {
    const row = this.get(id);
    this.assertAvailable(row.type);
    let configuration: IntegrationConfig | undefined;
    if (patch.configuration !== undefined) {
      const schema = row.type === "website" ? websiteConfigSchema : cloudConfigSchema;
      const parsed = schema.safeParse(patch.configuration);
      if (!parsed.success) throw new IntegrationError(parsed.error.issues.map((i) => i.message).join("; "));
      configuration = { ...this.repo.config(row), ...parsed.data };
      const url = (parsed.data as z.infer<typeof websiteConfigSchema>).url;
      if (row.type === "website" && url !== undefined) {
        configuration.url = url === "" ? undefined : (normalizeUrl(validatePublicUrl(url).href) ?? undefined);
      }
    }
    // Website: configured URL = ready ("connected"); disabling never deletes config, connection or documents.
    const status =
      row.type === "website" && configuration && row.status !== "syncing"
        ? configuration.url ? (row.status === "not_connected" ? "connected" : row.status) : "not_connected"
        : undefined;
    return this.toDTO(this.repo.update(id, { enabled: patch.enabled, configuration, status }));
  }

  /** Checks a URL without importing anything (for the "Test" button). */
  async testWebsite(url: string): Promise<{ finalUrl: string; title: string; textLength: number; linkCount: number }> {
    this.assertAvailable("website");
    const start = validatePublicUrl(url);
    const fetchPage = this.deps.fetchPage ?? ((u: string) => safeFetch(u, { maxBytes: this.deps.config.MAX_UPLOAD_MB * 1024 * 1024 }));
    const res = await fetchPage(start.href, { checkRedirect: () => null });
    if (!res.contentType.includes("html")) return { finalUrl: res.url, title: "", textLength: res.body.length, linkCount: 0 };
    const page = parseHtmlPage(res.body.toString("utf8"));
    if (page.text.length < MIN_PAGE_TEXT) throw new IntegrationError("No readable content was found on this page.");
    return { finalUrl: res.url, title: page.title, textLength: page.text.length, linkCount: page.links.length };
  }

  // ── Sync ──

  /** Starts a sync in the background and returns the new run immediately (the UI polls for progress). */
  startSync(id: string): SyncRunSummaryDTO {
    const row = this.get(id);
    const meta = INTEGRATION_META[row.type];
    this.assertAvailable(row.type);
    if (row.enabled !== 1) throw new IntegrationError(`${meta.name} is turned off. Turn it on to sync.`, 409);
    if (running.has(id) || row.status === "syncing") throw new IntegrationError(`${meta.name} is already syncing.`, 409);
    const config = this.repo.config(row);
    if (row.type === "website" && !config.url) throw new IntegrationError("Enter a website URL first.");
    if (row.type !== "website") {
      if (!this.repo.getCredentials(id) && !this.deps.getAccessToken) throw new IntegrationError(`Connect ${meta.name} first.`);
      if (!config.folderId) throw new IntegrationError("Select a folder to sync first.");
    }

    running.add(id);
    const run = this.repo.startRun(id);
    this.repo.update(id, { status: "syncing", lastError: null });
    void this.runSync(row, run.id)
      .catch((err) => console.error(`[integrations] sync ${run.id} crashed`, err))
      .finally(() => running.delete(id));
    return this.runSummary(run);
  }

  /** Runs a sync to completion (awaitable; used directly by tests). */
  async runSync(row: IntegrationRow, runId: string): Promise<SyncRunSummaryDTO> {
    const totals: RunTotals = { found: 0, added: 0, updated: 0, skipped: 0, failed: 0 };
    const items: SyncRunItemDTO[] = [];
    const record = (item: SyncRunItemDTO) => {
      items.push(item);
      totals[item.outcome === "added" ? "added" : item.outcome === "updated" ? "updated" : item.outcome === "skipped" ? "skipped" : "failed"]++;
      this.repo.updateRunProgress(runId, totals);
    };

    let fatal: string | null = null;
    try {
      if (row.type === "website") await this.syncWebsite(row, totals, record);
      else await this.syncCloud(row, totals, record);
    } catch (err) {
      fatal = err instanceof IntegrationError ? err.message : row.type === "website" ? "Unable to crawl this website." : `${INTEGRATION_META[row.type].name} sync failed.`;
      if (!(err instanceof IntegrationError)) console.error(`[integrations] ${row.type} sync failed`, err);
    }

    const ok = totals.added + totals.updated + totals.skipped;
    const status: SyncRunStatus = fatal ? "error" : totals.failed > 0 ? (ok > 0 ? "partial" : "error") : "success";
    const errorMessage =
      fatal ??
      (status === "error"
        ? totals.found === 0
          ? "Nothing to import was found."
          : `All ${totals.failed} item(s) failed. See the run details.`
        : status === "partial"
          ? `${totals.failed} item(s) failed. See the run details.`
          : null);
    const finished = this.repo.finishRun(runId, status, totals, items, errorMessage);
    this.repo.update(row.id, {
      status: status === "error" ? "error" : "success",
      lastError: errorMessage,
      lastSyncAt: finished.completed_at ?? undefined,
    });
    return this.runSummary(finished);
  }

  private ingest(source: DocumentSource, filename: string, displayName: string, buffer: Buffer): Promise<UpsertResult> {
    return upsertSourceDocument(this.deps, { filename, displayName, buffer, source });
  }

  private async syncWebsite(row: IntegrationRow, totals: RunTotals, record: (i: SyncRunItemDTO) => void): Promise<void> {
    const config = this.repo.config(row);
    const maxBytes = this.deps.config.MAX_UPLOAD_MB * 1024 * 1024;
    const fetchPage = this.deps.fetchPage ?? ((u: string, o: { checkRedirect: (u: URL) => string | null }) => safeFetch(u, { maxBytes, checkRedirect: o.checkRedirect }));

    await crawl({
      startUrl: validatePublicUrl(config.url ?? "").href,
      depth: config.depth ?? 1,
      maxPages: config.maxPages ?? 25,
      fetch: fetchPage,
      onResult: async (r) => {
        totals.found++;
        const source: DocumentSource = { type: "website", externalId: r.url, url: r.url, integrationId: row.id };
        const u = new URL(r.url);
        const where = `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`;
        if (r.kind === "failed") return record({ name: where, url: r.url, outcome: "failed", message: r.message });

        let res: UpsertResult;
        if (r.kind === "page") {
          if (r.text.length < MIN_PAGE_TEXT) return record({ name: r.title || where, url: r.url, outcome: "failed", message: "No readable content was found on this page." });
          const name = (r.title ? `${r.title} — ${where}` : where).slice(0, 200);
          // Plain text through the existing TXT ingestion: title and URL first, then the page content.
          res = await this.ingest(source, "page.txt", name, Buffer.from(`${r.title}\nSource: ${r.url}\n\n${r.text}`, "utf8"));
          return record({ name, url: r.url, outcome: res.outcome, message: res.message });
        }
        if (r.buffer.length > maxBytes) return record({ name: r.filename, url: r.url, outcome: "skipped", message: `Larger than ${this.deps.config.MAX_UPLOAD_MB} MB.` });
        res = await this.ingest(source, r.filename, r.filename, r.buffer);
        record({ name: r.filename, url: r.url, outcome: res.outcome, message: res.message });
      },
    });
    if (totals.found === 0) throw new IntegrationError("No pages could be crawled from this website.");
  }

  private async syncCloud(row: IntegrationRow, totals: RunTotals, record: (i: SyncRunItemDTO) => void): Promise<void> {
    const type = row.type as OAuthType;
    const drive = this.drives[type];
    const config = this.repo.config(row);
    const maxBytes = this.deps.config.MAX_UPLOAD_MB * 1024 * 1024;
    const docs = new DocumentRepository(this.deps.db);

    let token = await this.accessToken(row);
    let files: CloudFile[];
    try {
      files = await drive.listFiles(token, config.folderId!);
    } catch (err) {
      if (err instanceof IntegrationError && err.status === 404) throw new IntegrationError(`The selected folder no longer exists in ${drive.label}. Select another folder.`);
      if (err instanceof IntegrationError && err.status === 403) throw new IntegrationError(`Unable to access the selected folder in ${drive.label}.`);
      throw err;
    }

    for (const file of files) {
      totals.found++;
      const source: DocumentSource = { type, externalId: file.id, url: file.webUrl, integrationId: row.id, modifiedAt: file.modifiedAt };
      if (!SUPPORTED_FILE.test(file.name)) {
        const googleNative = file.mimeType?.startsWith("application/vnd.google-apps.");
        record({ name: file.name, url: file.webUrl, outcome: "skipped", message: googleNative ? "Google Docs, Sheets and Slides aren't supported yet." : "Unsupported file type (PDF, DOCX, TXT and MD are supported)." });
        continue;
      }
      if (file.size !== null && file.size > maxBytes) {
        record({ name: file.name, url: file.webUrl, outcome: "skipped", message: `Larger than ${this.deps.config.MAX_UPLOAD_MB} MB.` });
        continue;
      }
      // Unchanged since the last sync (same modified time, indexed with the current model): no download needed.
      const existing = docs.findBySource(type, file.id);
      if (existing && file.modifiedAt && existing.source_modified_at === file.modifiedAt && existing.status === "ready" && existing.embedding_models === this.deps.embedder.modelId) {
        docs.updateSourceMetadata(existing.id, file.name, source);
        record({ name: file.name, url: file.webUrl, outcome: "skipped", message: "Unchanged" });
        continue;
      }
      try {
        let buffer: Buffer;
        try {
          buffer = await drive.download(token, file, maxBytes);
        } catch (err) {
          if (!(err instanceof IntegrationAuthError)) throw err;
          token = await this.accessToken(row, true); // token expired mid-sync: refresh once and retry
          buffer = await drive.download(token, file, maxBytes);
        }
        const res = await this.ingest(source, file.name, file.name, buffer);
        record({ name: file.name, url: file.webUrl, outcome: res.outcome, message: res.message });
      } catch (err) {
        if (err instanceof IntegrationAuthError) throw err;
        record({ name: file.name, url: file.webUrl, outcome: "failed", message: err instanceof IntegrationError ? err.message : "Could not import this file." });
      }
    }
  }

  private async accessToken(row: IntegrationRow, forceRefresh = false): Promise<string> {
    return this.deps.getAccessToken ? this.deps.getAccessToken(row) : this.tokens.getAccessToken(row, forceRefresh);
  }

  // ── Cloud folders & OAuth ──

  async listFolders(id: string, parentId?: string): Promise<{ parentId: string; folders: CloudFolderDTO[] }> {
    const row = this.get(id);
    if (row.type === "website") throw new IntegrationError("Websites have no folders.");
    this.assertAvailable(row.type);
    const drive = this.drives[row.type];
    const parent = parentId || drive.rootId;
    const folders = await drive.listFolders(await this.accessToken(row), parent);
    return { parentId: parent, folders };
  }

  /** Step 1: returns the provider's sign-in URL and the state to bind to the browser (cookie). */
  beginOAuth(type: OAuthType): { url: string; state: string } {
    this.assertAvailable(type);
    const status = oauthStatus(type, this.deps.config);
    if (!status.configured) {
      throw new IntegrationError(`${providerLabel(type)} isn't configured on the server. Missing: ${status.missingConfig.join(", ")}.`, 503);
    }
    const row = this.repo.getByType(type);
    if (row.enabled !== 1) throw new IntegrationError(`Turn ${providerLabel(type)} on before connecting.`, 409);
    const { state, verifier, challenge } = createPkce();
    this.repo.createOAuthState(state, row.id, verifier);
    return { url: buildAuthorizeUrl(type, this.deps.config, state, challenge), state };
  }

  /** Step 2 (callback): validates the state, exchanges the code, stores the tokens encrypted. */
  async completeOAuth(type: OAuthType, params: { state: string | null; cookieState: string | null; code: string | null; error: string | null }): Promise<void> {
    const label = providerLabel(type);
    const pending = params.state ? this.repo.consumeOAuthState(params.state) : null;
    if (params.error) throw new IntegrationError(params.error === "access_denied" ? `${label} authorization was cancelled.` : `${label} authentication failed.`);
    const row = this.repo.getByType(type);
    if (!pending || !statesMatch(params.state, params.cookieState) || pending.integrationId !== row.id || !params.code) {
      throw new IntegrationError(`${label} authentication failed: the sign-in link expired or was already used. Try connecting again.`);
    }
    this.assertAvailable(type);
    const tokens = await exchangeCode(type, this.deps.config, params.code, pending.codeVerifier);
    const account = await this.drives[type].account(tokens.accessToken).catch(() => null);
    this.tokens.save(row.id, tokens);
    this.repo.update(row.id, { status: "connected", accountLabel: account, lastError: null });
  }

  /** Removes the stored tokens. Configuration, imported documents and sync history are kept. */
  async disconnect(id: string): Promise<IntegrationDTO> {
    const row = this.get(id);
    if (row.type === "website") throw new IntegrationError("Websites don't have a connection to remove.");
    this.assertAvailable(row.type);
    let tokens = null;
    try {
      tokens = this.tokens.load(row.id);
    } catch {
      tokens = null;
    }
    await revokeTokens(row.type, tokens);
    this.repo.deleteCredentials(row.id);
    return this.toDTO(this.repo.update(row.id, { status: "not_connected", accountLabel: null, lastError: null }));
  }
}
