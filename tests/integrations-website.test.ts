import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "@/server/db/repositories";
import { upsertSourceDocument, type SourceFile } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { FetchError, IntegrationError } from "@/server/integrations/errors";
import { IntegrationService } from "@/server/integrations/service";
import { crawl, isCrawlableLink, isSameSite, normalizeUrl, type CrawlResult } from "@/server/integrations/website/crawler";
import { parseHtmlPage } from "@/server/integrations/website/html";
import { isPublicAddress, validatePublicUrl, type FetchedResource } from "@/server/integrations/website/safe-fetch";
import type { Embedder } from "@/server/knowledge/embedder";
import { FakeEmbedder, memoryDb, TEST_ORG, testConfig } from "./helpers";

const VOCAB = ["refund", "policy", "shipping", "warranty", "battery", "pricing", "support"];

function setup(fetchPage?: (url: string) => Promise<FetchedResource>) {
  const db = memoryDb();
  const embedder = new FakeEmbedder(VOCAB);
  const vectorStore = new SqliteVectorStore(db, TEST_ORG);
  const deps = { db, embedder, vectorStore, documents: new DocumentRepository(db, TEST_ORG), chunkOptions: { chunkSize: 200, overlap: 0 } };
  const service = new IntegrationService({ ...deps, orgId: TEST_ORG, config: testConfig(), fetchPage, isFeatureEnabled: () => true });
  const chunkCount = (docId: string) => (db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?").get(docId) as { n: number }).n;
  return { db, deps, service, docs: new DocumentRepository(db, TEST_ORG), chunkCount };
}

const html = (title: string, body: string, links: string[] = []) =>
  `<html><head><title>${title}</title><script>var secret = 1;</script></head><body><nav>Menu Home About</nav><main><h1>${title}</h1><p>${body}</p>${links
    .map((l) => `<a href="${l}">link</a>`)
    .join(" ")}</main><footer>Footer text</footer></body></html>`;

/** Fake site: URL → HTML (or a thrown error / redirect). */
function fakeSite(pages: Record<string, string | Error | { redirect: string }>) {
  const fetched: string[] = [];
  const fetch = vi.fn(async (url: string): Promise<FetchedResource> => {
    fetched.push(url);
    const page = pages[url];
    if (page === undefined) throw new IntegrationError("The page could not be found (HTTP 404).");
    if (page instanceof Error) throw page;
    if (typeof page === "object") {
      const target = pages[page.redirect] as string;
      return { url: page.redirect, status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(target) };
    }
    return { url, status: 200, contentType: "text/html; charset=utf-8", body: Buffer.from(page) };
  });
  return { fetch, fetched };
}

describe("URL normalization", () => {
  it("normalizes and deduplicates equivalent URLs", () => {
    const a = normalizeUrl("https://Example.com:443/docs/?utm_source=x&b=2&a=1#section");
    const b = normalizeUrl("https://example.com/docs?a=1&b=2");
    expect(a).toBe("https://example.com/docs?a=1&b=2");
    expect(a).toBe(b);
    expect(normalizeUrl("/pricing", "https://example.com/docs/")).toBe("https://example.com/pricing");
    expect(normalizeUrl("https://user:pass@example.com/x")).toBe("https://example.com/x");
  });

  it("ignores mailto:, javascript:, tel: and other non-web schemes", () => {
    for (const href of ["mailto:a@b.com", "javascript:void(0)", "tel:+123", "data:text/html,hi", "ftp://example.com/f", "file:///etc/passwd"]) {
      expect(normalizeUrl(href, "https://example.com/"), href).toBeNull();
    }
  });

  it("restricts crawling to the same site and crawlable file types", () => {
    expect(isSameSite("https://www.example.com/a", "example.com")).toBe(true);
    expect(isSameSite("https://docs.other.com/a", "example.com")).toBe(false);
    expect(isSameSite("https://example.com.evil.com/", "example.com")).toBe(false);
    expect(isCrawlableLink("https://example.com/guide")).toBe(true);
    expect(isCrawlableLink("https://example.com/manual.pdf")).toBe(true);
    expect(isCrawlableLink("https://example.com/logo.png")).toBe(false);
    expect(isCrawlableLink("https://example.com/app.zip")).toBe(false);
  });
});

describe("SSRF protection", () => {
  it("classifies public and private addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicAddress(ip), ip).toBe(true);
    // NAT64 (DNS64 networks): judged by the embedded IPv4 address.
    expect(isPublicAddress("64:ff9b::23d3:7a6d")).toBe(true); // 35.211.122.109
    expect(isPublicAddress("64:ff9b::a00:1")).toBe(false); // 10.0.0.1
    expect(isPublicAddress("64:ff9b::7f00:1")).toBe(false); // 127.0.0.1
    expect(isPublicAddress("64:ff9b::192.168.1.1")).toBe(false);
  });

  it("rejects local, private, non-http and odd-port URLs", () => {
    for (const url of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.5/admin", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "ftp://example.com/", "https://example.com:22/", "http://intranet/", "not a url"]) {
      expect(() => validatePublicUrl(url), url).toThrow(IntegrationError);
    }
    expect(validatePublicUrl("https://example.com/docs").hostname).toBe("example.com");
  });
});

describe("HTML extraction", () => {
  it("keeps main content, drops scripts/nav/footer, and collects links", () => {
    const page = parseHtmlPage(html("Refund policy", "Refunds are accepted within 30 days.", ["/a", "mailto:x@y.z"]));
    expect(page.title).toBe("Refund policy");
    expect(page.text).toContain("Refunds are accepted within 30 days.");
    expect(page.text).not.toContain("secret");
    expect(page.text).not.toContain("Footer text");
    expect(page.links).toEqual(["/a", "mailto:x@y.z"]);
  });

  it("falls back to <body> without nav/header/footer", () => {
    const page = parseHtmlPage("<html><body><header>Top</header><div>Body content here</div><footer>Bottom</footer></body></html>");
    expect(page.text).toBe("Body content here");
  });
});

describe("crawler", () => {
  const site = () =>
    fakeSite({
      "https://example.com/": html("Home", "Welcome.", [
        "/a",
        "/a#top",
        "/a/",
        "/b",
        "/missing",
        "mailto:hi@example.com",
        "tel:123",
        "javascript:void(0)",
        "https://other.com/z",
        "/logo.png",
      ]),
      "https://example.com/a": html("A", "Page A.", ["/c", "/"]),
      "https://example.com/b": { redirect: "https://example.com/a" },
      "https://example.com/c": html("C", "Page C.", ["/d"]),
      "https://example.com/d": html("D", "Page D."),
    });

  async function run(depth: number, maxPages = 50) {
    const { fetch, fetched } = site();
    const results: CrawlResult[] = [];
    await crawl({ startUrl: "https://example.com", depth, maxPages, fetch, onResult: async (r) => void results.push(r) });
    return { fetched, results };
  }

  it("depth 1 crawls the start page and the pages it links to, deduplicated and same-site only", async () => {
    const { fetched, results } = await run(1);
    expect(fetched).toEqual(["https://example.com/", "https://example.com/a", "https://example.com/b", "https://example.com/missing"]);
    expect(results.map((r) => `${r.kind}:${r.url}`)).toEqual([
      "page:https://example.com/",
      "page:https://example.com/a",
      // /b redirected to /a, which was already seen, so it isn't reported twice
      "failed:https://example.com/missing",
    ]);
    expect(fetched.some((u) => u.includes("other.com") || u.startsWith("mailto") || u.endsWith(".png"))).toBe(false);
  });

  it("depth 2 and 3 follow links further", async () => {
    expect((await run(2)).fetched).toContain("https://example.com/c");
    expect((await run(2)).fetched).not.toContain("https://example.com/d");
    expect((await run(3)).fetched).toContain("https://example.com/d");
  });

  it("treats http:// links to the same page as the https:// page", async () => {
    const { fetch, fetched } = fakeSite({
      "https://example.com/": html("Home", "Welcome.", ["http://example.com/a", "https://example.com/a"]),
      "https://example.com/a": html("A", "Page A."),
    });
    await crawl({ startUrl: "https://example.com/", depth: 1, maxPages: 10, fetch, onResult: async () => {} });
    expect(fetched).toEqual(["https://example.com/", "https://example.com/a"]);
  });

  it("respects the page limit", async () => {
    expect((await run(3, 2)).fetched).toHaveLength(2);
  });

  it("one failing page does not stop the crawl", async () => {
    const { results } = await run(2);
    const failed = results.find((r) => r.kind === "failed");
    expect(failed).toMatchObject({ url: "https://example.com/missing", message: expect.stringContaining("404") });
    expect(results.some((r) => r.url === "https://example.com/c")).toBe(true);
  });
});

describe("upsertSourceDocument (existing pipeline, no duplicates)", () => {
  const file = (text: string): SourceFile => ({
    filename: "page.txt",
    displayName: "Refund policy — example.com/refunds",
    buffer: Buffer.from(text),
    source: { type: "website", externalId: "https://example.com/refunds", url: "https://example.com/refunds", integrationId: "int-1" },
  });

  it("adds, skips unchanged, updates changed, and keeps the old version when extraction fails", async () => {
    const { db, deps, docs, chunkCount } = setup();
    db.prepare("INSERT INTO integration_connections (id, org_id, type, name, status) VALUES ('int-1', ?, 'website', 'Website', 'connected')").run(TEST_ORG);

    const first = await upsertSourceDocument(deps, file("Refund policy: refunds within 30 days."));
    expect(first.outcome).toBe("added");
    const id = first.documentId!;
    const firstChunks = chunkCount(id);
    expect(firstChunks).toBeGreaterThan(0);

    const again = await upsertSourceDocument(deps, file("Refund policy: refunds within 30 days."));
    expect(again).toMatchObject({ outcome: "skipped", documentId: id });
    expect(chunkCount(id)).toBe(firstChunks);

    const changed = await upsertSourceDocument(deps, file("Refund policy: refunds within 60 days. Shipping is free."));
    expect(changed).toMatchObject({ outcome: "updated", documentId: id });
    const text = (db.prepare("SELECT group_concat(content, ' ') AS t FROM chunks WHERE document_id = ?").get(id) as { t: string }).t;
    expect(text).toContain("60 days");
    expect(text).not.toContain("30 days"); // old chunks replaced, not duplicated

    const broken = await upsertSourceDocument(deps, file("   "));
    expect(broken.outcome).toBe("failed");
    expect(chunkCount(id)).toBeGreaterThan(0); // previous version still searchable
    expect(docs.list().filter((d) => d.source_external_id === "https://example.com/refunds")).toHaveLength(1);
  });
});

describe("website sync (service)", () => {
  function site(refundText: string) {
    return fakeSite({
      "https://example.com/": html("Home", "Welcome to our support center for pricing and warranty questions.", ["/refunds", "/broken"]),
      "https://example.com/refunds": html("Refunds", refundText),
    }).fetch;
  }

  it("imports pages into Documents, records history, and re-syncs without duplicates", async () => {
    let fetchPage = site("Refund policy: refunds are accepted within 30 days of purchase.");
    const { service, docs } = setup((u) => fetchPage(u));
    const website = service.list().find((i) => i.type === "website")!;
    service.update(website.id, { enabled: true, configuration: { url: "https://example.com/", depth: 1, maxPages: 10 } });

    const sync = async () => {
      const run = service.repo.startRun(website.id);
      return service.runSync(service.get(website.id), run.id);
    };

    const first = await sync();
    expect(first).toMatchObject({ status: "partial", filesFound: 3, filesAdded: 2, filesFailed: 1 });
    const imported = docs.list().filter((d) => d.integration_id === website.id);
    expect(imported).toHaveLength(2);
    expect(imported.every((d) => d.source_type === "website" && d.status === "ready")).toBe(true);
    expect(service.runDetail(first.id).items.find((i) => i.outcome === "failed")?.message).toContain("404");

    const second = await sync();
    expect(second).toMatchObject({ filesAdded: 0, filesUpdated: 0, filesSkipped: 2 });

    fetchPage = site("Refund policy: refunds are now accepted within 60 days of purchase.");
    const third = await sync();
    expect(third).toMatchObject({ filesAdded: 0, filesUpdated: 1, filesSkipped: 1 });
    expect(docs.list().filter((d) => d.integration_id === website.id)).toHaveLength(2);

    const dto = service.list().find((i) => i.id === website.id)!;
    expect(dto.lastRun?.id).toBe(third.id);
    expect(dto.lastSyncAt).not.toBeNull();
    expect(service.listRuns()).toHaveLength(3);
  });

  it("validates configuration: private URLs and bad depths are rejected", () => {
    const { service } = setup();
    const website = service.list().find((i) => i.type === "website")!;
    expect(() => service.update(website.id, { configuration: { url: "http://192.168.0.1/" } })).toThrow(IntegrationError);
    expect(() => service.update(website.id, { configuration: { depth: 5 } })).toThrow(/depth/);
    expect(() => service.update(website.id, { configuration: { url: "https://example.com", extra: 1 } })).toThrow(IntegrationError);
  });

  it("a site where nothing can be crawled finishes as an error, not a crash", async () => {
    const { service } = setup(async () => {
      throw new IntegrationError("The website did not respond in time.");
    });
    const website = service.list().find((i) => i.type === "website")!;
    service.update(website.id, { enabled: true, configuration: { url: "https://example.com/" } });
    const run = service.repo.startRun(website.id);
    const result = await service.runSync(service.get(website.id), run.id);
    expect(result.status).toBe("error");
    expect(service.list().find((i) => i.id === website.id)?.status).toBe("error");
  });
});

describe("website sync outcomes and run diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  // The real page at https://quotes.toscrape.com/login: a header, a login form and a footer, nothing to index.
  const LOGIN_HTML = readFileSync(new URL("./stubs/quotes-login.html", import.meta.url), "utf8");
  const HOME = html("Quotes", "Famous quotes by well-known authors about life, thinking and change.", ["/login"]);

  function prepare(fetchPage: (url: string) => Promise<FetchedResource>, embedder: Embedder = new FakeEmbedder(VOCAB)) {
    const db = memoryDb();
    const deps = { db, embedder, vectorStore: new SqliteVectorStore(db, TEST_ORG), documents: new DocumentRepository(db, TEST_ORG), chunkOptions: { chunkSize: 200, overlap: 0 } };
    const service = new IntegrationService({ ...deps, orgId: TEST_ORG, config: testConfig(), fetchPage, isFeatureEnabled: () => true });
    const website = service.list().find((i) => i.type === "website")!;
    service.update(website.id, { enabled: true, configuration: { url: "https://example.com/", depth: 1, maxPages: 10 } });
    const sync = async () => {
      const run = service.repo.startRun(website.id);
      const result = await service.runSync(service.get(website.id), run.id);
      return { result, items: service.runDetail(result.id).items };
    };
    return { db, service, website, sync, docs: new DocumentRepository(db, TEST_ORG) };
  }

  /** The run's counters must always equal the tally of its recorded items. */
  const tally = (items: { outcome: string }[]) => ({
    added: items.filter((i) => i.outcome === "added").length,
    updated: items.filter((i) => i.outcome === "updated").length,
    skipped: items.filter((i) => i.outcome === "skipped").length,
    failed: items.filter((i) => i.outcome === "failed").length,
  });

  it("a login-form page is skipped as 'no content' (the real quotes.toscrape.com /login), not reported as a failure", async () => {
    const { sync, service, website } = prepare(fakeSite({ "https://example.com/": HOME, "https://example.com/login": LOGIN_HTML }).fetch);

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "success", filesFound: 2, filesAdded: 1, filesUpdated: 0, filesSkipped: 1, filesFailed: 0, errorMessage: null });
    const login = items.find((i) => i.url === "https://example.com/login")!;
    expect(login).toMatchObject({ outcome: "skipped", stage: "parse", category: "no_content" });
    expect(login.message).toMatch(/No readable content: only 23 characters of text remain after removing navigation, forms and scripts/);
    expect(login.at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    expect(service.list().find((i) => i.id === website.id)).toMatchObject({ status: "success", lastError: null });
    expect(tally(items)).toEqual({ added: result.filesAdded, updated: result.filesUpdated, skipped: result.filesSkipped, failed: result.filesFailed });
  });

  it("a second sync reports pages it already has as 'unchanged', keeps the form page as 'no content', and adds nothing twice", async () => {
    const { sync, docs } = prepare(fakeSite({ "https://example.com/": HOME, "https://example.com/login": LOGIN_HTML }).fetch);
    await sync();

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "success", filesFound: 2, filesAdded: 0, filesUpdated: 0, filesSkipped: 2, filesFailed: 0 });
    expect(items.map((i) => i.category).sort()).toEqual(["no_content", "unchanged"]);
    expect(items.find((i) => i.category === "unchanged")).toMatchObject({ outcome: "skipped", message: "Unchanged" });
    expect(docs.list().filter((d) => d.source_type === "website")).toHaveLength(1);
    expect(tally(items)).toEqual({ added: 0, updated: 0, skipped: 2, failed: 0 });
  });

  it("a site where no page has any content (a JavaScript-only shell) fails with an explanation instead of reporting success", async () => {
    const shell = "<html><head><title>App</title></head><body><div id='root'></div><script src='/app.js'></script></body></html>";
    const { sync, service, website } = prepare(fakeSite({ "https://example.com/": shell }).fetch);

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "error", filesFound: 1, filesAdded: 0, filesSkipped: 1, filesFailed: 0 });
    expect(result.errorMessage).toMatch(/No readable content was found on any of the 1 page that loaded.*JavaScript/);
    expect(items[0]).toMatchObject({ outcome: "skipped", category: "no_content" }); // the item is still there to inspect
    expect(service.list().find((i) => i.id === website.id)).toMatchObject({ status: "error" });
  });

  it("an HTTP error page is a real failure with its stage, category, status code, original error and time, and it is logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gone = new FetchError("The website returned HTTP 404 (page not found).", "http_error", 404, "HTTP 404 Not Found");
    const { sync } = prepare(
      fakeSite({ "https://example.com/": html("Home", "Welcome to the home page of this example site, with several links.", ["/gone"]), "https://example.com/gone": gone }).fetch,
    );

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "partial", filesFound: 2, filesAdded: 1, filesFailed: 1, errorMessage: "1 item(s) failed. See the run details." });
    const failed = items.find((i) => i.outcome === "failed")!;
    expect(failed).toMatchObject({
      url: "https://example.com/gone",
      stage: "fetch",
      category: "http_error",
      httpStatus: 404,
      message: "The website returned HTTP 404 (page not found).",
      detail: "HTTP 404 Not Found",
    });
    expect(failed.at).toBeTruthy();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("item failed"),
      expect.objectContaining({ url: "https://example.com/gone", stage: "fetch", category: "http_error", httpStatus: 404 }),
    );
  });

  it("an unreachable website fails the run, with the network error recorded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = new FetchError("The website example.com could not be found.", "network", undefined, "ENOTFOUND: getaddrinfo ENOTFOUND example.com");
    const { sync } = prepare(fakeSite({ "https://example.com/": down }).fetch);

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "error", filesFound: 1, filesFailed: 1, errorMessage: "All 1 item(s) failed. See the run details." });
    expect(items[0]).toMatchObject({ outcome: "failed", stage: "fetch", category: "network", detail: expect.stringContaining("ENOTFOUND") });
  });

  it("an unexpected exception keeps its original error in the details, with keys and tokens removed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const boom = new Error("socket hang up calling https://x.test/?api_key=SECRETVALUE12345 using sk-abcdefghijklmnopqrstuvwxyz123456");
    const { sync } = prepare(fakeSite({ "https://example.com/": HOME, "https://example.com/login": boom }).fetch);

    const { items } = await sync();

    const failed = items.find((i) => i.outcome === "failed")!;
    expect(failed).toMatchObject({ message: "Could not load this page.", stage: "fetch", category: "other" });
    expect(failed.detail).toContain("socket hang up");
    expect(failed.detail).toContain("[REDACTED]");
    expect(JSON.stringify(items)).not.toMatch(/SECRETVALUE12345|sk-abcdefghij/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/SECRETVALUE12345|sk-abcdefghij/);
  });

  it("a response that isn't a page or document is skipped as unsupported content, not failed", async () => {
    const fetchPage = vi.fn(
      async (url: string): Promise<FetchedResource> =>
        url.endsWith("/data")
          ? { url, status: 200, contentType: "application/json", body: Buffer.from("{}") }
          : { url, status: 200, contentType: "text/html", body: Buffer.from(html("Home", "A home page with enough readable text to be indexed.", ["/data"])) },
    );
    const { sync } = prepare(fetchPage);

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "success", filesAdded: 1, filesSkipped: 1, filesFailed: 0 });
    expect(items.find((i) => i.url === "https://example.com/data")).toMatchObject({
      outcome: "skipped",
      stage: "fetch",
      category: "unsupported_content",
      message: "Unsupported content type (application/json).",
    });
  });

  it("an embedding failure is a failure at the indexing stage; the pipeline error is kept (redacted) and no document is stored", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: Embedder = {
      modelId: "test-embedder",
      embedDocuments: async () => {
        throw new Error("Embedding service rejected the request: Authorization: Bearer abcdefghijklmnop1234567890");
      },
      embedQuery: async () => new Float32Array(1),
    };
    const { sync, docs } = prepare(fakeSite({ "https://example.com/": HOME, "https://example.com/login": LOGIN_HTML }).fetch, broken);

    const { result, items } = await sync();

    expect(result).toMatchObject({ status: "partial", filesFound: 2, filesAdded: 0, filesSkipped: 1, filesFailed: 1 });
    const failed = items.find((i) => i.outcome === "failed")!;
    expect(failed).toMatchObject({ stage: "index", category: "ingestion", message: "Processing failed due to an internal error." });
    expect(failed.detail).toContain("Embedding service rejected the request");
    expect(failed.detail).not.toContain("abcdefghijklmnop1234567890");
    expect(docs.list().filter((d) => d.source_type === "website")).toHaveLength(0);
  });

  it("the Test button still reports a page with no readable content as an error", async () => {
    const { service } = prepare(fakeSite({ "https://example.com/login": LOGIN_HTML }).fetch);
    await expect(service.testWebsite("https://example.com/login")).rejects.toThrow("No readable content was found on this page.");
  });

  it("history recorded before the diagnostics existed still opens", () => {
    const { db, service, website } = prepare(fakeSite({}).fetch);
    const legacy = [{ name: "quotes.toscrape.com/login", url: "https://quotes.toscrape.com/login", outcome: "failed", message: "No readable content was found on this page." }];
    db.prepare("INSERT INTO integration_sync_runs (id, integration_id, status, files_found, files_failed, details_json) VALUES ('old', ?, 'partial', 1, 1, ?)").run(website.id, JSON.stringify(legacy));

    expect(service.runDetail("old").items).toEqual(legacy);
  });
});
