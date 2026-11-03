import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProtectedApi } from "@/lib/auth-routes";
import { DocumentRepository } from "@/server/db/repositories";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb, TEST_ORG } from "./helpers";

// The route runs for real (real session cookie, real tenant resolution); only the database handle and the
// feature flags are swapped for test doubles.
const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, documentsAvailable: true }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/features/service", () => ({
  getFeatureFlags: () => [{ key: "documents", name: "Documents", available: h.documentsAvailable }],
  isFeatureEnabled: () => true,
  getFeatureAvailability: () => ({}),
  getFeatureFlagService: () => ({}),
  defaultFeatureFlags: () => [],
}));

import { DELETE } from "@/app/api/documents/failed/route";

const MODEL = "test-embedder";
let db: Database.Database;
let docs: DocumentRepository;
let store: SqliteVectorStore;
let owner: Seeded;

type Status = "processing" | "ready" | "failed";

/** Inserts a document in the given state; ready documents get one indexed chunk. */
function addDoc(filename: string, status: Status, orgId = TEST_ORG): string {
  const d = new DocumentRepository(db, orgId);
  const s = new SqliteVectorStore(db, orgId);
  const id = `${orgId.slice(0, 4)}-${status}-${filename}`;
  d.create({ id, filename, mimeType: "application/pdf", sizeBytes: 1000 });
  if (status === "ready") {
    s.addChunks(id, MODEL, [{ chunkIndex: 0, content: `${filename} text`, pageStart: 1, pageEnd: 1, embedding: new Float32Array([1, 0]) }]);
    d.markReady(id, "application/pdf", 1, 1);
  } else if (status === "failed") {
    d.markFailed(id, "No selectable text found in this PDF.");
  }
  return id;
}

const ids = (orgId = TEST_ORG) => new DocumentRepository(db, orgId).list().map((d) => d.id).sort();
const chunkCount = (documentId: string) => (db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?").get(documentId) as { n: number }).n;
/** Calls the endpoint as the owner by default; pass null to send no cookie at all. */
const clear = (cookie: string | null = owner.cookie, extra: Parameters<typeof call>[2] = {}) =>
  call(DELETE, "/api/documents/failed", { method: "DELETE", cookie: cookie ?? undefined, ...extra });

beforeEach(() => {
  db = memoryDb();
  h.db = db;
  h.documentsAvailable = true;
  docs = new DocumentRepository(db, TEST_ORG);
  store = new SqliteVectorStore(db, TEST_ORG);
  owner = seedMember(db, TEST_ORG, "owner@acme.test", "owner");
});
afterEach(() => vi.restoreAllMocks());

describe("DocumentRepository.deleteFailed", () => {
  it("does nothing when there are no failed documents", () => {
    const ready = addDoc("a.pdf", "ready");
    expect(docs.deleteFailed()).toEqual([]);
    expect(ids()).toEqual([ready]);
  });

  it("deletes a single failed document and returns its id", () => {
    const failed = addDoc("bad.pdf", "failed");
    const ready = addDoc("good.pdf", "ready");
    expect(docs.deleteFailed()).toEqual([failed]);
    expect(ids()).toEqual([ready]);
  });

  it("deletes every failed document", () => {
    const failed = [addDoc("1.pdf", "failed"), addDoc("2.pdf", "failed"), addDoc("3.pdf", "failed")];
    addDoc("good.pdf", "ready");
    expect(docs.deleteFailed().sort()).toEqual(failed.sort());
    expect(docs.list().map((d) => d.status)).toEqual(["ready"]);
  });

  it("leaves indexed documents and their chunks untouched", () => {
    const ready = addDoc("good.pdf", "ready");
    addDoc("bad.pdf", "failed");
    docs.deleteFailed();
    expect(docs.get(ready)).toMatchObject({ status: "ready", chunk_count: 1 });
    expect(chunkCount(ready)).toBe(1);
  });

  it("leaves processing documents untouched, however old they are", () => {
    const processing = addDoc("busy.pdf", "processing");
    db.prepare("UPDATE documents SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(processing);
    addDoc("bad.pdf", "failed");
    docs.deleteFailed();
    expect(docs.get(processing)?.status).toBe("processing");
  });

  it("has no 'pending' or other status that could be mistaken for failed: the schema only allows three", () => {
    const insert = (status: string) =>
      db.prepare("INSERT INTO documents (id, org_id, filename, mime_type, size_bytes, status) VALUES ('x', ?, 'x.pdf', 'application/pdf', 1, ?)").run(TEST_ORG, status);
    expect(() => insert("pending")).toThrow(/CHECK constraint/);
    expect(() => insert("interrupted")).toThrow(/CHECK constraint/);
  });

  it("never deletes a document that became healthy after the caller last looked (status is checked at delete time)", () => {
    const flaky = addDoc("flaky.pdf", "failed");
    const staleListing = docs.list().filter((d) => d.status === "failed").map((d) => d.id);
    expect(staleListing).toContain(flaky);
    // Between that listing and the delete, an integration re-sync repairs the document in place.
    db.prepare("UPDATE documents SET status = 'ready', error = NULL WHERE id = ?").run(flaky);
    expect(docs.deleteFailed()).toEqual([]);
    expect(docs.get(flaky)?.status).toBe("ready");
  });

  it("removes a failed document's own chunks but never the chunks of a healthy document", () => {
    const failed = addDoc("bad.pdf", "failed");
    store.addChunks(failed, MODEL, [{ chunkIndex: 0, content: "partial", pageStart: 1, pageEnd: 1, embedding: new Float32Array([0, 1]) }]);
    const healthy = addDoc("good.pdf", "ready");

    docs.deleteFailed();

    expect(chunkCount(failed)).toBe(0);
    expect(chunkCount(healthy)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 1 });
  });

  it("is reflected in the dashboard statistics", () => {
    addDoc("good.pdf", "ready");
    addDoc("1.pdf", "failed");
    addDoc("2.pdf", "failed");
    expect(docs.stats()).toMatchObject({ total: 3, ready: 1, failed: 2 });
    docs.deleteFailed();
    expect(docs.stats()).toMatchObject({ total: 1, ready: 1, failed: 0 });
  });

  it("only ever deletes the failed documents of its own organization", () => {
    const other = seedOrganization(db, "Other");
    const theirs = addDoc("theirs.pdf", "failed", other);
    const theirsReady = addDoc("theirs-good.pdf", "ready", other);
    const mine = addDoc("mine.pdf", "failed");

    expect(docs.deleteFailed()).toEqual([mine]);

    expect(ids(other)).toEqual([theirs, theirsReady].sort());
    expect(chunkCount(theirsReady)).toBe(1);
  });
});

describe("DELETE /api/documents/failed", () => {
  it("returns the actual number deleted and their ids", async () => {
    const failed = [addDoc("1.pdf", "failed"), addDoc("2.pdf", "failed")];
    addDoc("good.pdf", "ready");

    const res = await clear();

    expect(res.status).toBe(200);
    const data = await body<{ deleted: number; deletedIds: string[]; message: string }>(res);
    expect(data.deleted).toBe(2);
    expect(data.deletedIds.sort()).toEqual(failed.sort());
    expect(data.message).toBe("2 failed documents cleared successfully.");
  });

  it("uses the singular for one document", async () => {
    addDoc("1.pdf", "failed");
    expect((await body<{ message: string }>(await clear())).message).toBe("1 failed document cleared successfully.");
  });

  it("says so, safely, when there is nothing to clear", async () => {
    addDoc("good.pdf", "ready");
    const res = await clear();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 0, deletedIds: [], message: "No failed documents to clear." });
  });

  it("only ever removes failed documents", async () => {
    const ready = addDoc("good.pdf", "ready");
    const processing = addDoc("busy.pdf", "processing");
    addDoc("bad.pdf", "failed");
    await clear();
    expect(ids()).toEqual([processing, ready].sort());
  });

  it("ignores anything the browser sends about tenants, users or documents", async () => {
    const ready = addDoc("good.pdf", "ready");
    const failed = addDoc("bad.pdf", "failed");
    const other = seedOrganization(db, "Other");
    const theirs = addDoc("theirs.pdf", "failed", other);

    const res = await call(DELETE, `/api/documents/failed?tenantId=${other}&orgId=${other}&status=ready&id=${ready}`, {
      method: "DELETE",
      cookie: owner.cookie,
      headers: { "x-tenant-id": other, "x-org-id": other, "x-user-id": "someone-else" },
      json: { tenantId: other, orgId: other, status: "ready", ids: [ready, theirs] },
    });

    expect((await body<{ deletedIds: string[] }>(res)).deletedIds).toEqual([failed]);
    expect(ids()).toEqual([ready]);
    expect(ids(other)).toEqual([theirs]); // the other organization's failed document is untouched too
  });

  it("does not touch another organization's failed documents when a member of that other organization clears theirs", async () => {
    const other = seedOrganization(db, "Other");
    const theirOwner = seedMember(db, other, "owner@other.test", "owner");
    const mine = addDoc("mine.pdf", "failed");
    const theirs = addDoc("theirs.pdf", "failed", other);

    const res = await clear(theirOwner.cookie);

    expect((await body<{ deletedIds: string[] }>(res)).deletedIds).toEqual([theirs]);
    expect(ids()).toEqual([mine]);
  });

  it("rejects an unauthenticated caller and deletes nothing", async () => {
    const failed = addDoc("bad.pdf", "failed");

    const res = await clear(null);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue.", code: "unauthenticated" });
    expect(ids()).toEqual([failed]);
  });

  it("rejects a forged or expired session cookie", async () => {
    const failed = addDoc("bad.pdf", "failed");
    expect((await clear(`kb_session=${"A".repeat(43)}`)).status).toBe(401);
    db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await clear()).status).toBe(401);
    expect(ids()).toEqual([failed]);
  });

  it("is behind the session gate (proxy) as well", () => {
    expect(isProtectedApi("/api/documents/failed")).toBe(true);
  });

  it("needs permission to delete documents: viewers and members are refused, administrators are not", async () => {
    const failed = addDoc("bad.pdf", "failed");
    for (const role of ["viewer", "member"] as const) {
      const person = seedMember(db, TEST_ORG, `${role}@acme.test`, role);
      const res = await clear(person.cookie);
      expect(res.status, role).toBe(403);
      expect(await res.json()).toMatchObject({ code: "forbidden" });
    }
    expect(ids()).toEqual([failed]);

    const admin = seedMember(db, TEST_ORG, "admin@acme.test", "admin");
    expect((await clear(admin.cookie)).status).toBe(200);
    expect(ids()).toEqual([]);
  });

  it("rejects cross-site requests", async () => {
    const failed = addDoc("bad.pdf", "failed");
    const res = await clear(owner.cookie, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(ids()).toEqual([failed]);
  });

  it("is blocked when the Documents feature is switched off", async () => {
    h.documentsAvailable = false;
    const failed = addDoc("bad.pdf", "failed");
    const res = await clear();
    expect(res.status).toBe(403);
    expect((await body<{ code: string }>(res)).code).toBe("feature_disabled");
    expect(ids()).toEqual([failed]);
  });

  it("turns a database error into a generic 500 without leaking details, and keeps the records", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = addDoc("bad.pdf", "failed");
    vi.spyOn(DocumentRepository.prototype, "deleteFailed").mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked at C:\\secret\\kb.sqlite");
    });

    const res = await clear();

    expect(res.status).toBe(500);
    const data = await body<{ error: string }>(res);
    expect(data.error).toBe("Something went wrong on the server. Check the server logs.");
    expect(JSON.stringify(data)).not.toMatch(/SQLITE|secret/);
    expect(consoleError).toHaveBeenCalled(); // the detail goes to the server log only
    expect(ids()).toEqual([failed]);
  });

  it("is all-or-nothing: a failure partway through rolls the whole delete back", () => {
    const a = addDoc("1.pdf", "failed");
    const b = addDoc("2.pdf", "failed");
    // A trigger that refuses to delete the second document simulates an error mid-statement.
    db.exec(`CREATE TRIGGER block BEFORE DELETE ON documents WHEN old.id = '${b}' BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    expect(() => docs.deleteFailed()).toThrow(/blocked/);
    expect(ids()).toEqual([a, b].sort());
  });

  // The app still has a single knowledge base per organization: there is no knowledge-base column to filter on.
  it.todo("documents in another knowledge base of the same organization remain untouched (not applicable yet: one knowledge base per organization)");
});
