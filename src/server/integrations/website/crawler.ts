import "server-only";
import type { SyncItemCategory, SyncItemStage } from "@/lib/integrations";
import { safeErrorMessage } from "../../security/redact";
import { FetchError, IntegrationError } from "../errors";
import { parseHtmlPage } from "./html";
import type { FetchedResource } from "./safe-fetch";

// Breadth-first, same-site crawler with a depth and page limit. Fetching is injected so the crawl
// logic can be tested without the network (production uses safeFetch).

const DOCUMENT_EXTENSIONS: Record<string, string> = { ".pdf": ".pdf", ".docx": ".docx", ".txt": ".txt", ".md": ".md", ".markdown": ".md" };
const PAGE_EXTENSIONS = new Set(["", ".html", ".htm", ".xhtml", ".php", ".asp", ".aspx", ".jsp", ".cfm", ".shtml"]);
const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|_ga)$/i;

/** Canonical form used for de-duplication and as the document's external ID. Null if not crawlable. */
export function normalizeUrl(raw: string, base?: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /^(mailto|javascript|tel|data|sms|ftp|file):/i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) url.port = "";
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  url.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

/** Same site = same host, ignoring a leading "www.". */
export function isSameSite(url: string, rootHost: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/^www\./, "");
  try {
    return strip(new URL(url).hostname) === strip(rootHost);
  } catch {
    return false;
  }
}

function extensionOf(url: string): string {
  const path = new URL(url).pathname;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot).toLowerCase() : "";
}

/** Only web pages and the document types the ingestion pipeline supports are followed. */
export function isCrawlableLink(url: string): boolean {
  const ext = extensionOf(url);
  return PAGE_EXTENSIONS.has(ext) || ext in DOCUMENT_EXTENSIONS;
}

export type CrawlResult =
  | { kind: "page"; url: string; title: string; text: string }
  | { kind: "file"; url: string; filename: string; buffer: Buffer }
  /** Reached fine, but it isn't something that can be imported (not an error). */
  | { kind: "skipped"; url: string; message: string; stage: SyncItemStage; category: SyncItemCategory }
  /** Could not be loaded; `detail` is the original technical error, free of secrets. */
  | { kind: "failed"; url: string; message: string; stage: SyncItemStage; category: SyncItemCategory; httpStatus?: number; detail?: string };

export interface CrawlOptions {
  startUrl: string;
  /** 1 = the start page and the pages it links to (max 3). */
  depth: number;
  maxPages: number;
  fetch: (url: string, opts: { checkRedirect: (u: URL) => string | null }) => Promise<FetchedResource>;
  /** Called for every page/file/failure as the crawl proceeds. */
  onResult: (result: CrawlResult) => Promise<void>;
  signal?: AbortSignal;
}

function fileNameFor(url: string, ext: string): string {
  const path = decodeURIComponent(new URL(url).pathname);
  const base = path.slice(path.lastIndexOf("/") + 1) || "document";
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

/** Crawls the site and reports each result. Returns the number of URLs attempted. */
export async function crawl(opts: CrawlOptions): Promise<number> {
  const start = normalizeUrl(opts.startUrl);
  if (!start) throw new IntegrationError("Enter a valid website URL, starting with https:// or http://.");
  const rootHost = new URL(start).hostname;
  const secure = start.startsWith("https://");
  const maxDepth = Math.min(Math.max(1, Math.floor(opts.depth)), 3);
  const seen = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  const checkRedirect = (u: URL) => (isSameSite(u.href, rootHost) ? null : `Redirected to another website (${u.hostname}); skipped.`);
  let attempted = 0;

  while (queue.length > 0 && attempted < opts.maxPages) {
    if (opts.signal?.aborted) break;
    const { url, depth } = queue.shift()!;
    attempted++;

    let res: FetchedResource;
    try {
      res = await opts.fetch(url, { checkRedirect });
    } catch (err) {
      await opts.onResult(
        err instanceof FetchError
          ? { kind: "failed", url, message: err.message, stage: "fetch", category: err.category, httpStatus: err.httpStatus, detail: err.detail }
          : err instanceof IntegrationError
            ? { kind: "failed", url, message: err.message, stage: "fetch", category: "other" }
            // Anything unexpected: keep the original error (redacted) instead of discarding it.
            : { kind: "failed", url, message: "Could not load this page.", stage: "fetch", category: "other", detail: safeErrorMessage(err) },
      );
      continue;
    }

    // After a redirect, the final URL is the identity (and may already have been seen).
    const finalUrl = normalizeUrl(res.url) ?? url;
    if (finalUrl !== url) {
      if (seen.has(finalUrl)) continue;
      seen.add(finalUrl);
    }

    const ext = extensionOf(finalUrl);
    const type = res.contentType.split(";")[0]!.trim();
    const docExt =
      type === "application/pdf" ? ".pdf"
      : type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? ".docx"
      : type === "text/markdown" ? ".md"
      : type === "text/plain" ? DOCUMENT_EXTENSIONS[ext] ?? ".txt"
      : DOCUMENT_EXTENSIONS[ext] && !type.includes("html") ? DOCUMENT_EXTENSIONS[ext] : null;

    if (docExt) {
      await opts.onResult({ kind: "file", url: finalUrl, filename: fileNameFor(finalUrl, docExt), buffer: res.body });
      continue;
    }
    if (!type.includes("html") && type !== "") {
      // The server answered correctly with something we don't import (an image, JSON, …): skipped, like unsupported files in Drive.
      await opts.onResult({ kind: "skipped", url: finalUrl, message: `Unsupported content type (${type}).`, stage: "fetch", category: "unsupported_content" });
      continue;
    }

    const page = parseHtmlPage(res.body.toString("utf8"));
    await opts.onResult({ kind: "page", url: finalUrl, title: page.title, text: page.text });

    if (depth < maxDepth) {
      for (const href of page.links) {
        let next = normalizeUrl(href, finalUrl);
        // Sites crawled over https often still link to themselves with http://; keep one identity per page.
        if (next && secure && next.startsWith("http://")) next = `https://${next.slice("http://".length)}`;
        if (!next || seen.has(next) || !isSameSite(next, rootHost) || !isCrawlableLink(next)) continue;
        seen.add(next);
        queue.push({ url: next, depth: depth + 1 });
      }
    }
  }
  return attempted;
}
