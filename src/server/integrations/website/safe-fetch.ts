import "server-only";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { safeErrorMessage } from "../../security/redact";
import { FetchError, IntegrationError } from "../errors";

// SSRF-safe HTTP(S) fetching for the website scraper.
// - Only http/https to public hosts on standard web ports; no credentials in URLs.
// - Every DNS answer is checked AT CONNECT TIME (custom `lookup`), so DNS rebinding can't reach
//   private/internal addresses; redirects are re-validated hop by hop.
// - Timeouts and a response size cap on every request.

// Separate lists per family: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets
// too, so ::ffff:0:0/96 in a shared list would block every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) BLOCKED_V4.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["100::", 64], ["2001:db8::", 32],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) BLOCKED_V6.addSubnet(addr, prefix, "ipv6");

const NAT64 = new net.BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");

/** The IPv4 address in the last 32 bits of an IPv6 address (e.g. 64:ff9b::23d3:7a6d → 35.211.122.109). */
function embeddedIPv4(ip: string): string | null {
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (dotted) return dotted[1]!;
  const [head = [], tail = []] = ip.split("::").map((s) => s.split(":").filter(Boolean));
  const groups = ip.includes("::") ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  const [hi, lo] = [parseInt(groups[6]!, 16), parseInt(groups[7]!, 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

/** True for addresses on the public internet (not private, loopback, link-local, multicast, reserved…). */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 0) return false;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1): judge the embedded IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return !BLOCKED_V4.check(mapped[1]!, "ipv4");
  // NAT64 well-known prefix (64:ff9b::/96, returned by DNS64 resolvers): judge the embedded IPv4 address.
  if (family === 6 && NAT64.check(ip, "ipv6")) {
    const v4 = embeddedIPv4(ip);
    return v4 !== null && !BLOCKED_V4.check(v4, "ipv4");
  }
  return family === 4 ? !BLOCKED_V4.check(ip, "ipv4") : !BLOCKED_V6.check(ip, "ipv6");
}

const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".intranet"];

/** Parses and checks a URL before any network access. Throws a user-facing IntegrationError. */
export function validatePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new IntegrationError("Enter a valid website URL, starting with https:// or http://.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new IntegrationError("Only http:// and https:// websites can be crawled.");
  if (url.username || url.password) throw new IntegrationError("URLs with a username or password are not allowed.");
  if (!ALLOWED_PORTS.has(url.port)) throw new IntegrationError("Only standard web ports (80, 443, 8080, 8443) are allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s)) || !host.includes(".") && net.isIP(host) === 0) {
    throw new IntegrationError("Private, local and internal addresses can't be crawled.");
  }
  if (net.isIP(host) && !isPublicAddress(host)) throw new IntegrationError("Private, local and internal addresses can't be crawled.");
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** DNS lookup that refuses non-public answers; used by the socket itself, so it covers every connection. */
function safeLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "");
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicAddress(a.address))) {
      const blocked = Object.assign(new Error(`Blocked non-public address for ${hostname}`), { code: "EBLOCKEDADDRESS" });
      return callback(blocked, "");
    }
    if (options.all) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface FetchedResource {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Extra check on each redirect target (e.g. same-site). Return a message to refuse it. */
  checkRedirect?: (url: URL) => string | null;
}

const USER_AGENT = "KnowledgeBaseSyncBot/1.0 (+website scraper)";

function requestOnce(url: URL, timeoutMs: number, maxBytes: number): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        lookup: safeLookup as unknown as net.LookupFunction,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown,*/*;q=0.5" },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) {
          res.destroy();
          return reject(new FetchError(`The response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, "too_large", status, `Content-Length ${declared} exceeds the ${maxBytes}-byte limit.`));
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new FetchError(`The response is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`, "too_large", status, `The body passed the ${maxBytes}-byte limit.`));
          } else parts.push(chunk);
        });
        res.on("end", () => resolve({ status, headers: res.headers, body: Buffer.concat(parts) }));
        res.on("error", reject);
      },
    );
    const deadline = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("close", () => clearTimeout(deadline));
    req.on("error", reject);
    req.end();
  });
}

/** Turns low-level network failures into messages a user can act on. */
function friendlyNetworkError(err: unknown, url: URL): IntegrationError {
  if (err instanceof IntegrationError) return err;
  const code = (err as { code?: string }).code;
  // The original error, for the run details (anything key-like is removed).
  const detail = `${code ?? "ERROR"}: ${safeErrorMessage(err)}`;
  if (code === "EBLOCKEDADDRESS") return new FetchError(`${url.hostname} resolves to a private or internal address, which can't be crawled.`, "network", undefined, detail);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new FetchError(`The website ${url.hostname} could not be found.`, "network", undefined, detail);
  if (code === "ETIMEDOUT") return new FetchError(`${url.hostname} did not respond in time.`, "timeout", undefined, detail);
  if (code === "ECONNREFUSED") return new FetchError(`${url.hostname} refused the connection.`, "network", undefined, detail);
  if (code?.startsWith("ERR_TLS") || code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return new FetchError(`${url.hostname} has an invalid security certificate.`, "network", undefined, detail);
  }
  return new FetchError(`Could not load ${url.href}.`, "network", undefined, detail);
}

/** GET a public URL safely, following up to `maxRedirects` validated redirects. */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<FetchedResource> {
  const { timeoutMs = 10_000, maxBytes = 5 * 1024 * 1024, maxRedirects = 5 } = opts;
  let url = validatePublicUrl(rawUrl);
  for (let hop = 0; ; hop++) {
    let res;
    try {
      res = await requestOnce(url, timeoutMs, maxBytes);
    } catch (err) {
      throw friendlyNetworkError(err, url);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw new FetchError(`Too many redirects from ${url.href}.`, "redirect", res.status, `More than ${maxRedirects} redirects.`);
      const next = validatePublicUrl(new URL(res.headers.location, url).href);
      const refused = opts.checkRedirect?.(next);
      if (refused) throw new FetchError(refused, "redirect", res.status, `HTTP ${res.status} redirect to ${next.hostname}.`);
      url = next;
      continue;
    }
    if (res.status >= 400) {
      throw new FetchError(
        `The website returned HTTP ${res.status}${res.status === 403 ? " (access forbidden)" : res.status === 404 ? " (page not found)" : ""}.`,
        "http_error",
        res.status,
        `HTTP ${res.status} ${res.status === 404 ? "Not Found" : res.status === 403 ? "Forbidden" : "response"}`,
      );
    }
    return { url: url.href, status: res.status, contentType: String(res.headers["content-type"] ?? "").toLowerCase(), body: res.body };
  }
}
