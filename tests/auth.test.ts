import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { isProtectedApi, isProtectedPage, loginUrlFor, safeRedirect, SESSION_COOKIE } from "@/lib/auth-routes";
import { openDatabase } from "@/server/db/client";
import { AuthService } from "@/server/auth/service";
import { hashSessionToken, isSessionTokenValid } from "@/server/auth/session-lookup";
import { memoryDb, testConfig } from "./helpers";

const auth = (db = memoryDb()) => ({ db, service: new AuthService(db, testConfig()) });

describe("route rules", () => {
  it("protects the product and its APIs, not the landing page, /login or the sign-in API", () => {
    for (const p of ["/admin", "/admin/documents", "/admin/integrations/website-scraper", "/chat", "/settings/features", "/app"]) {
      expect(isProtectedPage(p), p).toBe(true);
    }
    for (const p of ["/", "/login", "/administrator", "/chatter"]) expect(isProtectedPage(p), p).toBe(false);
    expect(isProtectedApi("/api/documents")).toBe(true);
    expect(isProtectedApi("/api/integrations/google-drive/callback")).toBe(true);
    expect(isProtectedApi("/api/auth/login")).toBe(false);
    expect(isProtectedApi("/api/auth/logout")).toBe(false);
  });

  it("only redirects back to product pages on this site (no open redirects)", () => {
    expect(safeRedirect("/admin/documents")).toBe("/admin/documents");
    expect(safeRedirect("/chat?x=1")).toBe("/chat?x=1");
    for (const bad of [null, "", "https://evil.example/admin", "//evil.example/admin", "/\\evil.example", "javascript:alert(1)", "/login", "/", "/admin\u0000x"]) {
      expect(safeRedirect(bad), String(bad)).toBe("/admin");
    }
    expect(loginUrlFor("/admin/documents")).toBe("/login?redirect=/admin/documents");
    expect(loginUrlFor("/admin")).toBe("/login?redirect=/admin");
  });
});

describe("demo credentials", () => {
  it("accepts only the configured email + password (email case-insensitive)", () => {
    const { service } = auth();
    expect(service.verifyCredentials("demo@knowledgebase.ai", "Demo@12345")).toBe("demo@knowledgebase.ai");
    expect(service.verifyCredentials("  DEMO@KnowledgeBase.ai ", "Demo@12345")).toBe("demo@knowledgebase.ai");
    expect(service.verifyCredentials("demo@knowledgebase.ai", "demo@12345")).toBeNull();
    expect(service.verifyCredentials("other@knowledgebase.ai", "Demo@12345")).toBeNull();
    expect(service.verifyCredentials(undefined, undefined)).toBeNull();
  });

  it("uses the environment values, not built-in ones", () => {
    const service = new AuthService(memoryDb(), testConfig({ DEMO_USER_EMAIL: "team@acme.test", DEMO_USER_PASSWORD: "S3cret!" }));
    expect(service.verifyCredentials("team@acme.test", "S3cret!")).toBe("team@acme.test");
    expect(service.verifyCredentials("demo@knowledgebase.ai", "Demo@12345")).toBeNull();
  });
});

describe("server-side sessions", () => {
  it("creates, reads and destroys sessions; stores only a hash of the token", () => {
    const { db, service } = auth();
    const { token, expiresAt } = service.createSession("demo@knowledgebase.ai");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(service.getSession(token)).toMatchObject({ email: "demo@knowledgebase.ai" });
    expect(isSessionTokenValid(token, db)).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM auth_sessions").all())).not.toContain(token);

    service.deleteSession(token); // logout
    expect(service.getSession(token)).toBeNull();
    expect(isSessionTokenValid(token, db)).toBe(false);
  });

  it("rejects expired, unknown and malformed tokens", () => {
    const { db, service } = auth();
    const { token } = service.createSession("demo@knowledgebase.ai");
    db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?").run(hashSessionToken(token));
    expect(service.getSession(token)).toBeNull();
    expect(isSessionTokenValid(token, db)).toBe(false);
    expect(isSessionTokenValid("x".repeat(43), db)).toBe(false);
    expect(isSessionTokenValid("not a token", db)).toBe(false);
    expect(isSessionTokenValid(undefined, db)).toBe(false);
  });
});

describe("request proxy", () => {
  let dir: string;
  let token: string;
  let proxy: (req: NextRequest) => Response;

  beforeAll(async () => {
    // The proxy reads the real database file from DATA_DIR (read-only).
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-auth-"));
    process.env.DATA_DIR = dir;
    const db = openDatabase(path.join(dir, "kb.sqlite"));
    token = new AuthService(db, testConfig()).createSession("demo@knowledgebase.ai").token;
    db.close();
    proxy = (await import("@/proxy")).proxy;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  const request = (url: string, withSession = false) =>
    new NextRequest(new URL(url, "http://localhost:3000"), withSession ? { headers: { cookie: `${SESSION_COOKIE}=${token}` } } : undefined);

  it("sends signed-out visitors of product pages to /login with the page to return to", () => {
    const res = proxy(request("/admin/documents"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/login?redirect=/admin/documents");
    expect(proxy(request("/chat")).headers.get("location")).toContain("/login?redirect=/chat");
  });

  it("answers signed-out API calls with 401 (no data)", async () => {
    const res = proxy(request("/api/documents"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("lets a valid session through, and leaves public routes alone", () => {
    expect(proxy(request("/admin/documents", true)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/documents", true)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/api/auth/login")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(request("/login")).headers.get("x-middleware-next")).toBe("1");
  });

  it("a forged cookie does not get in", () => {
    const forged = new NextRequest(new URL("/admin", "http://localhost:3000"), { headers: { cookie: `${SESSION_COOKIE}=${"A".repeat(43)}` } });
    expect(proxy(forged).status).toBe(307);
  });
});
