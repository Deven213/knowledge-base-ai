import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/server/config";
import { DocumentRepository } from "@/server/db/repositories";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import type { CloudDrive, CloudFile } from "@/server/integrations/cloud";
import { IntegrationAuthError, IntegrationError } from "@/server/integrations/errors";
import { buildAuthorizeUrl, createPkce, oauthStatus, statesMatch, TokenStore } from "@/server/integrations/oauth";
import { IntegrationRepository } from "@/server/integrations/repository";
import { IntegrationService } from "@/server/integrations/service";
import { FakeEmbedder, memoryDb, testConfig } from "./helpers";

const KEY = Buffer.alloc(32, 7).toString("base64");
const OAUTH_CONFIG: Partial<AppConfig> = {
  INTEGRATIONS_ENCRYPTION_KEY: KEY,
  GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret-value",
  MICROSOFT_OAUTH_CLIENT_ID: "ms-client-id",
  MICROSOFT_OAUTH_CLIENT_SECRET: "ms-client-secret-value",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeDrive(files: CloudFile[], contents: Record<string, string>) {
  const downloads: string[] = [];
  const drive: CloudDrive = {
    label: "Google Drive",
    rootId: "root",
    account: async () => "user@example.com",
    listFolders: async () => [{ id: "folder1", name: "Policies" }],
    listFiles: vi.fn(async () => files),
    download: vi.fn(async (_token: string, file: CloudFile) => {
      downloads.push(file.id);
      return Buffer.from(contents[file.id] ?? "");
    }),
  };
  return { drive, downloads };
}

function setup(opts: { drive?: CloudDrive; config?: Partial<AppConfig>; flags?: Record<string, boolean>; token?: () => Promise<string> } = {}) {
  const db = memoryDb();
  const deps = { db, embedder: new FakeEmbedder(["refund", "policy", "shipping", "warranty"]), vectorStore: new SqliteVectorStore(db), chunkOptions: { chunkSize: 200, overlap: 0 } };
  const drive = opts.drive ?? fakeDrive([], {}).drive;
  const service = new IntegrationService({
    ...deps,
    config: testConfig(opts.config),
    drives: { google_drive: drive, onedrive: { ...drive, label: "OneDrive" } },
    getAccessToken: opts.token,
    isFeatureEnabled: (key) => opts.flags?.[key] ?? true,
  });
  return { db, service, docs: new DocumentRepository(db) };
}

const file = (id: string, name: string, modifiedAt = "2026-01-01T00:00:00Z", extra: Partial<CloudFile> = {}): CloudFile => ({
  id,
  name,
  size: 100,
  mimeType: null,
  modifiedAt,
  webUrl: `https://drive.google.com/file/d/${id}/view`,
  ...extra,
});

async function syncOnce(service: IntegrationService, id: string) {
  const run = service.repo.startRun(id);
  return service.runSync(service.get(id), run.id);
}

function connectedDrive(service: IntegrationService) {
  const gd = service.list().find((i) => i.type === "google_drive")!;
  service.update(gd.id, { enabled: true, configuration: { folderId: "folder1", folderName: "My Drive / Policies" } });
  return gd.id;
}

describe("cloud sync (Google Drive / OneDrive via the shared service)", () => {
  it("imports supported files, skips unsupported / too large / Google-native, and never duplicates", async () => {
    const files = [
      file("f1", "refunds.txt"),
      file("f2", "shipping.md"),
      file("f3", "budget.xlsx"),
      file("f4", "Handbook", undefined, { mimeType: "application/vnd.google-apps.document" }),
      file("f5", "huge.pdf", undefined, { size: 500 * 1024 * 1024 }),
    ];
    const { drive, downloads } = fakeDrive(files, { f1: "Refund policy: 30 days.", f2: "Shipping policy: 5 days." });
    const { service, docs } = setup({ drive, token: async () => "access-token" });
    const id = connectedDrive(service);

    const first = await syncOnce(service, id);
    expect(first).toMatchObject({ status: "success", filesFound: 5, filesAdded: 2, filesSkipped: 3, filesFailed: 0 });
    const items = service.runDetail(first.id).items;
    expect(items.find((i) => i.name === "Handbook")?.message).toMatch(/Google Docs/);
    expect(items.find((i) => i.name === "huge.pdf")?.message).toMatch(/Larger than/);
    expect(items.find((i) => i.name === "budget.xlsx")?.message).toMatch(/Unsupported/);
    const imported = docs.list().filter((d) => d.integration_id === id);
    expect(imported.map((d) => d.filename).sort()).toEqual(["refunds.txt", "shipping.md"]);
    expect(imported.every((d) => d.source_type === "google_drive")).toBe(true);

    // Unchanged (same modified time): skipped without downloading again.
    downloads.length = 0;
    const second = await syncOnce(service, id);
    expect(second).toMatchObject({ filesAdded: 0, filesUpdated: 0, filesSkipped: 5 });
    expect(downloads).toEqual([]);

    // Changed file: re-indexed in place.
    files[0] = file("f1", "refunds.txt", "2026-02-01T00:00:00Z");
    (drive.download as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, f: CloudFile) =>
      Buffer.from(f.id === "f1" ? "Refund policy: 60 days." : "Shipping policy: 5 days."),
    );
    const third = await syncOnce(service, id);
    expect(third).toMatchObject({ filesUpdated: 1, filesSkipped: 4 });
    expect(docs.list().filter((d) => d.integration_id === id)).toHaveLength(2);
  });

  it("refreshes the token once when it expires mid-sync", async () => {
    const { drive } = fakeDrive([file("f1", "refunds.txt")], {});
    let calls = 0;
    (drive.download as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (calls++ === 0) throw new IntegrationAuthError("expired");
      return Buffer.from("Refund policy text.");
    });
    const token = vi.fn(async () => "token");
    const { service } = setup({ drive, token });
    const id = connectedDrive(service);
    const run = await syncOnce(service, id);
    expect(run).toMatchObject({ status: "success", filesAdded: 1 });
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("reports a deleted folder clearly", async () => {
    const { drive } = fakeDrive([], {});
    (drive.listFiles as ReturnType<typeof vi.fn>).mockRejectedValue(new IntegrationError("not found", 404));
    const { service } = setup({ drive, token: async () => "t" });
    const id = connectedDrive(service);
    const run = await syncOnce(service, id);
    expect(run.status).toBe("error");
    expect(run.errorMessage).toMatch(/no longer exists/);
    expect(service.list().find((i) => i.id === id)).toMatchObject({ status: "error", lastError: expect.stringMatching(/no longer exists/) });
  });

  it("one failing file does not stop the rest", async () => {
    const { drive } = fakeDrive([file("f1", "bad.txt"), file("f2", "good.txt")], { f1: "   ", f2: "Warranty policy: 12 months." });
    const { service } = setup({ drive, token: async () => "t" });
    const run = await syncOnce(service, connectedDrive(service));
    expect(run).toMatchObject({ status: "partial", filesAdded: 1, filesFailed: 1 });
  });
});

describe("enable/disable and feature flags", () => {
  it("blocks syncing when the integration is off, and keeps its documents and configuration", async () => {
    const { drive } = fakeDrive([file("f1", "refunds.txt")], { f1: "Refund policy: 30 days." });
    const { service, docs } = setup({ drive, token: async () => "t" });
    const id = connectedDrive(service);
    await syncOnce(service, id);

    const off = service.update(id, { enabled: false });
    expect(off.status).toBe("disabled");
    expect(off.configuration.folderId).toBe("folder1");
    expect(() => service.startSync(id)).toThrow(/turned off/);
    expect(docs.list().filter((d) => d.integration_id === id)).toHaveLength(1);
  });

  it("returns 403 when sync_integrations or the integration's own flag is off", () => {
    for (const flags of [{ sync_integrations: false }, { google_drive: false }] as Record<string, boolean>[]) {
      const { service } = setup({ flags });
      const gd = service.list().find((i) => i.type === "google_drive")!;
      for (const fn of [() => service.update(gd.id, { enabled: true }), () => service.startSync(gd.id), () => service.beginOAuth("google_drive")]) {
        try {
          fn();
          throw new Error("expected to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(IntegrationError);
          expect((err as IntegrationError).status).toBe(403);
        }
      }
    }
  });

  it("keeps sync history per integration, and blocks it when that integration's flag is off", async () => {
    const flags: Record<string, boolean> = {};
    const { drive } = fakeDrive([file("f1", "refunds.txt")], { f1: "Refund policy: 30 days." });
    const { service } = setup({ drive, token: async () => "t", flags });
    const gd = connectedDrive(service);
    const od = service.list().find((i) => i.type === "onedrive")!.id;
    const run = await syncOnce(service, gd);

    expect(service.runsFor(gd).map((r) => r.id)).toEqual([run.id]);
    expect(service.runsFor(od)).toEqual([]);
    expect(() => service.runDetail(run.id, od)).toThrow(expect.objectContaining({ status: 404 })); // not another integration's run
    expect(service.runDetail(run.id, gd).items).toHaveLength(1);

    flags.google_drive = false;
    expect(() => service.runsFor(gd)).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => service.runDetail(run.id, gd)).toThrow(expect.objectContaining({ status: 403 }));
    await expect(service.disconnect(gd)).rejects.toMatchObject({ status: 403 });
    expect(service.runsFor(od)).toEqual([]); // OneDrive unaffected

    flags.google_drive = true;
    expect(service.runsFor(gd)).toHaveLength(1); // history kept while it was off
  });

  it("toggling one integration does not change the others", () => {
    const { service } = setup();
    const [web, gd, od] = ["website", "google_drive", "onedrive"].map((t) => service.list().find((i) => i.type === t)!);
    service.update(gd!.id, { enabled: true });
    service.update(web!.id, { enabled: true });
    service.update(web!.id, { enabled: false });
    const after = service.list();
    expect(after.find((i) => i.id === web!.id)?.enabled).toBe(false);
    expect(after.find((i) => i.id === gd!.id)?.enabled).toBe(true);
    expect(after.find((i) => i.id === od!.id)?.enabled).toBe(false);
  });

  it("requires a website URL and a cloud folder before syncing", () => {
    const { service } = setup({ token: async () => "t" });
    const website = service.list().find((i) => i.type === "website")!;
    service.update(website.id, { enabled: true });
    expect(() => service.startSync(website.id)).toThrow(/website URL/);
    const gd = service.list().find((i) => i.type === "google_drive")!;
    service.update(gd.id, { enabled: true });
    expect(() => service.startSync(gd.id)).toThrow(/Select a folder/);
  });
});

describe("OAuth", () => {
  it("reports missing configuration by variable name, and refuses to connect (503)", () => {
    const status = oauthStatus("google_drive", testConfig());
    expect(status.configured).toBe(false);
    expect(status.missingConfig).toEqual(expect.arrayContaining(["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "INTEGRATIONS_ENCRYPTION_KEY"]));
    expect(status.redirectUri).toBe("http://localhost:3000/api/integrations/google-drive/callback");
    const { service } = setup();
    expect(() => service.beginOAuth("google_drive")).toThrow(expect.objectContaining({ status: 503 }));
    const dto = service.list().find((i) => i.type === "onedrive")!;
    expect(dto.oauth?.configured).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("secret-value");
  });

  it("builds a PKCE authorize URL without the client secret", () => {
    const { state, verifier, challenge } = createPkce();
    expect(verifier).not.toBe(challenge);
    const config = testConfig(OAUTH_CONFIG);
    const google = new URL(buildAuthorizeUrl("google_drive", config, state, challenge));
    expect(google.origin).toBe("https://accounts.google.com");
    expect(Object.fromEntries(google.searchParams)).toMatchObject({
      client_id: "google-client-id",
      redirect_uri: "http://localhost:3000/api/integrations/google-drive/callback",
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    const ms = new URL(buildAuthorizeUrl("onedrive", config, state, challenge));
    expect(ms.href).toContain("login.microsoftonline.com/common/oauth2/v2.0/authorize");
    expect(ms.searchParams.get("scope")).toContain("Files.Read");
    expect(google.href + ms.href).not.toContain("secret-value");
  });

  it("validates the callback state: single use and must match the browser cookie", async () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", null)).toBe(false);

    const { service } = setup({ config: OAUTH_CONFIG });
    const gd = service.list().find((i) => i.type === "google_drive")!;
    expect(() => service.beginOAuth("google_drive")).toThrow(/Turn Google Drive on/);
    service.update(gd.id, { enabled: true });
    const { state } = service.beginOAuth("google_drive");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(service.completeOAuth("google_drive", { state, cookieState: "forged", code: "code", error: null })).rejects.toThrow(/expired or was already used/);
    // The state was consumed by the failed attempt, so replaying it fails too.
    await expect(service.completeOAuth("google_drive", { state, cookieState: state, code: "code", error: null })).rejects.toThrow(/expired or was already used/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("exchanges the code server-side and stores tokens encrypted", async () => {
    const { service, db } = setup({ config: OAUTH_CONFIG });
    const gd = service.list().find((i) => i.type === "google_drive")!;
    service.update(gd.id, { enabled: true });
    const { state } = service.beginOAuth("google_drive");
    const fetchSpy = vi.fn(async () => Response.json({ access_token: "ya29.ACCESS", refresh_token: "1//REFRESH", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchSpy);

    await service.completeOAuth("google_drive", { state, cookieState: state, code: "auth-code", error: null });
    const body = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(body.get("code_verifier")).toBeTruthy();
    expect(body.get("grant_type")).toBe("authorization_code");

    const dto = service.list().find((i) => i.id === gd.id)!;
    expect(dto).toMatchObject({ connected: true, status: "connected", accountLabel: "user@example.com" });
    expect(JSON.stringify(dto)).not.toMatch(/ACCESS|REFRESH/);
    const raw = JSON.stringify(db.prepare("SELECT * FROM integration_credentials").all());
    expect(raw).not.toMatch(/ACCESS|REFRESH/); // encrypted at rest

    const disconnected = await service.disconnect(gd.id);
    expect(disconnected).toMatchObject({ connected: false, status: "not_connected" });
    expect(disconnected.configuration).toEqual(dto.configuration);
  });

  it("maps a cancelled sign-in to a clear message", async () => {
    const { service } = setup({ config: OAUTH_CONFIG });
    await expect(service.completeOAuth("onedrive", { state: null, cookieState: null, code: null, error: "access_denied" })).rejects.toThrow(/cancelled/);
  });
});

describe("TokenStore", () => {
  function store(config: Partial<AppConfig> = OAUTH_CONFIG) {
    const db = memoryDb();
    const repo = new IntegrationRepository(db);
    const row = repo.getByType("onedrive");
    return { repo, row, tokens: new TokenStore(repo, testConfig(config)) };
  }

  it("returns a valid token without refreshing", async () => {
    const { row, tokens } = store();
    tokens.save(row.id, { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() + 3_600_000 });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(tokens.getAccessToken(row)).resolves.toBe("a1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and keeps the rotated refresh token", async () => {
    const { row, tokens } = store();
    tokens.save(row.id, { accessToken: "a1", refreshToken: "r1", expiresAt: Date.now() - 1000 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 3600 })));
    await expect(tokens.getAccessToken(row)).resolves.toBe("a2");
    expect(tokens.load(row.id)).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
  });

  it("turns a revoked refresh token into a reconnect error without logging secrets", async () => {
    const { row, tokens } = store();
    tokens.save(row.id, { accessToken: "a1", refreshToken: "r1", expiresAt: 0 });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant", error_description: "revoked" }, { status: 400 })));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(tokens.getAccessToken(row)).rejects.toBeInstanceOf(IntegrationAuthError);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ms-client-secret-value|r1/);
  });

  it("refuses to store tokens without an encryption key", () => {
    const { row, tokens } = store({ ...OAUTH_CONFIG, INTEGRATIONS_ENCRYPTION_KEY: undefined });
    expect(() => tokens.save(row.id, { accessToken: "a", refreshToken: "r", expiresAt: 0 })).toThrow(/INTEGRATIONS_ENCRYPTION_KEY/);
  });
});
