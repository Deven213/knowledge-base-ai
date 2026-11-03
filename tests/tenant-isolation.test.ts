import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { IntegrationRepository } from "@/server/integrations/repository";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { FakeEmbedder, memoryDb } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Customer A must never reach Customer B's documents, chunks, embeddings, conversations, integrations
// or search results. Every route below runs for real (real session cookies, real tenant resolution, real
// SQL); only the database handle, feature flags, embedding model and AI provider are test doubles.
// ─────────────────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  db: undefined as unknown as Database.Database,
  embedder: undefined as unknown as FakeEmbedder,
  generate: vi.fn(),
}));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/knowledge/embedder", () => ({ getEmbedder: () => h.embedder }));
vi.mock("@/server/llm/registry", () => ({ getProvider: () => ({ id: "gemini", generate: h.generate }) }));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return {
    getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })),
    isFeatureEnabled: () => true,
    getFeatureAvailability: () => Object.fromEntries(FEATURES.map((f) => [f.key, true])),
    getFeatureFlagService: () => ({}),
    defaultFeatureFlags: () => [],
  };
});

import * as askRoute from "@/app/api/ask/route";
import * as conversationRoute from "@/app/api/conversations/[id]/route";
import * as conversationsRoute from "@/app/api/conversations/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as failedRoute from "@/app/api/documents/failed/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as disconnectRoute from "@/app/api/integrations/[id]/disconnect/route";
import * as foldersRoute from "@/app/api/integrations/[id]/folders/route";
import * as integrationRoute from "@/app/api/integrations/[id]/route";
import * as runRoute from "@/app/api/integrations/[id]/sync-runs/[runId]/route";
import * as runsRoute from "@/app/api/integrations/[id]/sync-runs/route";
import * as syncRoute from "@/app/api/integrations/[id]/sync/route";
import * as integrationsRoute from "@/app/api/integrations/route";
import * as sourcesRoute from "@/app/api/knowledge-sources/route";
import * as languageRoute from "@/app/api/messages/[id]/language/route";
import * as statsRoute from "@/app/api/stats/route";
import * as suggestionsRoute from "@/app/api/suggestions/route";

const VOCAB = ["zebra", "amber", "yak", "quartz", "policy", "guide"];
const UNKNOWN_ID = "00000000-0000-4000-8000-00000000dead";

let db: Database.Database;
let orgA: string;
let orgB: string;
let A: Seeded; // owner of Customer A
let A2: Seeded; // a second member of Customer A
let B: Seeded; // owner of Customer B

interface World {
  docs: { ready: string[]; failed: string };
  conversationId: string;
  assistantMessageId: string;
  userMessageId: string;
  integrationId: string;
  runId: string;
}
let wa: World;
let wb: World;

async function ingest(orgId: string, filename: string, text: string): Promise<string> {
  const result = await ingestDocument(
    { db, embedder: h.embedder, vectorStore: new SqliteVectorStore(db, orgId), documents: new DocumentRepository(db, orgId), chunkOptions: { chunkSize: 80, overlap: 0 } },
    { filename, buffer: Buffer.from(text) },
  );
  return result.documentId;
}

async function seedWorld(orgId: string, owner: Seeded, kind: "A" | "B"): Promise<World> {
  const [t1, t2] = kind === "A" ? ["Zebra policy: zebras are protected.", "Amber guide: amber is fossil resin."] : ["Yak policy: yaks live high.", "Quartz guide: quartz is a mineral."];
  const ready = [await ingest(orgId, `${kind} handbook one.txt`, t1), await ingest(orgId, `${kind} handbook two.txt`, t2)];
  const documents = new DocumentRepository(db, orgId);
  const failed = `${kind}-failed-doc`;
  documents.create({ id: failed, filename: `${kind} scan.pdf`, mimeType: "application/pdf", sizeBytes: 10 });
  documents.markFailed(failed, "No selectable text found in this PDF.");

  const conversations = new ConversationRepository(db, orgId, owner.userId);
  const conversationId = conversations.create(`${kind} private chat`);
  const [userMessage, assistantMessage] = conversations.addMessages(conversationId, [
    { role: "user", content: `${kind} question` },
    { role: "assistant", content: `${kind} answer`, provider: "gemini", model: "m", language: "en" },
  ]);

  const integrations = new IntegrationRepository(db, orgId);
  const website = integrations.list().find((i) => i.type === "website")!;
  integrations.update(website.id, { enabled: true, configuration: { url: `https://${kind.toLowerCase()}.example.com/` } });
  const run = integrations.startRun(website.id);
  integrations.finishRun(run.id, "success", { found: 1, added: 1, updated: 0, skipped: 0, failed: 0 }, [{ name: `${kind} page`, outcome: "added" }], null);

  return { docs: { ready, failed }, conversationId, assistantMessageId: assistantMessage!.id, userMessageId: userMessage!.id, integrationId: website.id, runId: run.id };
}

/** Everything Customer B owns, as one comparable string. */
function snapshot(orgId: string): string {
  const all = (sql: string) => db.prepare(sql).all(orgId);
  return JSON.stringify({
    documents: all("SELECT id, filename, status, chunk_count, error FROM documents WHERE org_id = ? ORDER BY id"),
    chunks: all("SELECT id, document_id, chunk_index, content, hex(embedding) AS e FROM chunks WHERE org_id = ? ORDER BY id"),
    conversations: all("SELECT id, title, user_id, knowledge_scope_json, updated_at FROM conversations WHERE org_id = ? ORDER BY id"),
    messages: all("SELECT m.id, m.content, m.language, m.variants_json FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.org_id = ? ORDER BY m.id"),
    integrations: all("SELECT * FROM integration_connections WHERE org_id = ? ORDER BY id"),
    runs: all("SELECT r.* FROM integration_sync_runs r JOIN integration_connections c ON c.id = r.integration_id WHERE c.org_id = ? ORDER BY r.id"),
    settings: all("SELECT * FROM org_settings WHERE org_id = ? ORDER BY key"),
  });
}

beforeAll(() => {
  Object.assign(process.env, { GEMINI_API_KEY: "test-key-not-real-1234", GEMINI_MODEL: "test-model", DEFAULT_AI_PROVIDER: "gemini" });
  resetConfigForTests();
});
afterAll(() => {
  for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "DEFAULT_AI_PROVIDER"]) delete process.env[k];
  resetConfigForTests();
});

beforeEach(async () => {
  db = memoryDb();
  h.db = db;
  h.embedder = new FakeEmbedder(VOCAB);
  h.generate.mockReset();
  h.generate.mockResolvedValue({ text: "Answer from the model [1]." });

  orgA = seedOrganization(db, "Acme");
  orgB = seedOrganization(db, "Globex");
  A = seedMember(db, orgA, "owner@acme.test", "owner");
  A2 = seedMember(db, orgA, "member@acme.test", "member");
  B = seedMember(db, orgB, "owner@globex.test", "owner");
  wa = await seedWorld(orgA, A, "A");
  wb = await seedWorld(orgB, B, "B");
});

/** What a foreign ID must look like: exactly what a nonexistent ID looks like. */
async function expectSameAsMissing(foreign: Response, missing: Response) {
  expect(foreign.status).toBe(missing.status);
  expect(await body(foreign)).toEqual(await body(missing));
}

describe("reading: Customer A sees only Customer A's data", () => {
  it("lists only its own documents, chat sources, statistics and conversations", async () => {
    const docs = await body<{ documents: { id: string; filename: string }[] }>(await call(documentsRoute.GET, "/api/documents", { cookie: A.cookie }));
    expect(docs.documents.map((d) => d.id).sort()).toEqual([...wa.docs.ready, wa.docs.failed].sort());
    expect(JSON.stringify(docs)).not.toMatch(/Globex|B handbook|B scan/);

    const sources = await body<{ sources: { label: string }[] }>(await call(sourcesRoute.GET, "/api/knowledge-sources", { cookie: A.cookie }));
    expect(sources.sources.map((s) => s.label)).toEqual(["All Knowledge Base", "A handbook one.txt", "A handbook two.txt"]);

    const stats = await body<{ documents: { total: number; failed: number }; conversations: number; questions: number }>(await call(statsRoute.GET, "/api/stats", { cookie: A.cookie }));
    expect(stats.documents).toMatchObject({ total: 3, failed: 1 });
    expect(stats.conversations).toBe(1);
    expect(stats.questions).toBe(1);

    const convs = await body<{ conversations: { id: string; title: string }[] }>(await call(conversationsRoute.GET, "/api/conversations", { cookie: A.cookie }));
    expect(convs.conversations.map((c) => c.id)).toEqual([wa.conversationId]);
    expect(JSON.stringify(convs)).not.toContain("B private chat");
  });

  it("searching conversations never surfaces the other customer's messages", async () => {
    const res = await body<{ conversations: unknown[] }>(await call(conversationsRoute.GET, "/api/conversations?q=B%20answer", { cookie: A.cookie }));
    expect(res.conversations).toEqual([]);
  });

  it("lists only its own integrations and sync history, never credentials", async () => {
    const res = await body<{ integrations: { id: string }[]; runs: { id: string }[] }>(await call(integrationsRoute.GET, "/api/integrations", { cookie: A.cookie }));
    const ownConnections = (db.prepare("SELECT id FROM integration_connections WHERE org_id = ?").all(orgA) as { id: string }[]).map((r) => r.id).sort();
    expect(res.integrations.map((i) => i.id).sort()).toEqual(ownConnections);
    expect(res.integrations.map((i) => i.id)).not.toContain(wb.integrationId);
    expect(res.runs.map((r) => r.id)).toEqual([wa.runId]);
    expect(JSON.stringify(res)).not.toMatch(/ciphertext|access_token|refresh_token/);
  });

  it("reads of another customer's objects by ID are answered exactly like IDs that do not exist", async () => {
    const asA = (handler: unknown, url: string, params: Record<string, string>, method = "GET") => call(handler, url, { method, cookie: A.cookie, params });

    await expectSameAsMissing(
      await asA(conversationRoute.GET, `/api/conversations/${wb.conversationId}`, { id: wb.conversationId }),
      await asA(conversationRoute.GET, `/api/conversations/${UNKNOWN_ID}`, { id: UNKNOWN_ID }),
    );
    await expectSameAsMissing(
      await asA(runsRoute.GET, `/api/integrations/${wb.integrationId}/sync-runs`, { id: wb.integrationId }),
      await asA(runsRoute.GET, `/api/integrations/${UNKNOWN_ID}/sync-runs`, { id: UNKNOWN_ID }),
    );
    await expectSameAsMissing(
      await asA(runRoute.GET, `/api/integrations/${wb.integrationId}/sync-runs/${wb.runId}`, { id: wb.integrationId, runId: wb.runId }),
      await asA(runRoute.GET, `/api/integrations/${UNKNOWN_ID}/sync-runs/${UNKNOWN_ID}`, { id: UNKNOWN_ID, runId: UNKNOWN_ID }),
    );
    await expectSameAsMissing(
      await asA(foldersRoute.GET, `/api/integrations/${wb.integrationId}/folders`, { id: wb.integrationId }),
      await asA(foldersRoute.GET, `/api/integrations/${UNKNOWN_ID}/folders`, { id: UNKNOWN_ID }),
    );
  });

  it("A's own integration cannot be used to read B's sync run, in either direction", async () => {
    const own = db.prepare("SELECT id FROM integration_connections WHERE org_id = ? AND type = 'website'").get(orgA) as { id: string };
    const viaOwnIntegration = await call(runRoute.GET, `/api/integrations/${own.id}/sync-runs/${wb.runId}`, { cookie: A.cookie, params: { id: own.id, runId: wb.runId } });
    expect(viaOwnIntegration.status).toBe(404);
    const viaForeignIntegration = await call(runRoute.GET, `/api/integrations/${wb.integrationId}/sync-runs/${wa.runId}`, { cookie: A.cookie, params: { id: wb.integrationId, runId: wa.runId } });
    expect(viaForeignIntegration.status).toBe(404);
  });
});

describe("searching and answering: Customer A never retrieves Customer B's text", () => {
  const ask = (cookie: string, json: unknown) => call(askRoute.POST, "/api/ask", { method: "POST", cookie, json });
  const promptsSent = () => h.generate.mock.calls.map((c) => JSON.stringify(c[0]));

  it("answers from its own documents only: the model sees A's passages and none of B's", async () => {
    const res = await ask(A.cookie, { question: "zebra policy" });

    expect(res.status).toBe(200);
    const data = await body<{ assistantMessage: { citations: { documentId: string; filename: string }[]; noContext: boolean } }>(res);
    expect(data.assistantMessage.noContext).toBe(false);
    expect(data.assistantMessage.citations.length).toBeGreaterThan(0);
    for (const c of data.assistantMessage.citations) expect(wa.docs.ready).toContain(c.documentId);
    const sent = promptsSent().join("\n");
    expect(sent).toContain("zebras are protected");
    expect(sent).not.toMatch(/yak|quartz|Globex|B handbook/i);
  });

  it("a question about B's content finds nothing for A, and the model is not even called", async () => {
    const res = await ask(A.cookie, { question: "yak quartz" });
    const data = await body<{ assistantMessage: { noContext: boolean; citations: unknown[] } }>(res);
    expect(data.assistantMessage.noContext).toBe(true);
    expect(data.assistantMessage.citations).toEqual([]);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("supplying B's document IDs does not reach B's documents: refused like a missing document, nothing sent to the model", async () => {
    const res = await ask(A.cookie, { question: "yak policy", documentIds: [wb.docs.ready[0]] });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "Document not found." });
    expect(h.generate).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE org_id = ?").get(orgA)).toEqual({ n: 1 }); // nothing was saved either
  });

  it("mixing one of A's documents with one of B's is refused as a whole", async () => {
    const res = await ask(A.cookie, { question: "zebra", documentIds: [wa.docs.ready[0], wb.docs.ready[0]] });
    expect(res.status).toBe(404);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("a 'Chat with' scope pointing at B's document searches nothing", async () => {
    const res = await ask(A.cookie, { question: "yak policy", knowledgeScope: { type: "document", documentId: wb.docs.ready[0] } });
    const data = await body<{ assistantMessage: { noContext: boolean } }>(res);
    expect(data.assistantMessage.noContext).toBe(true);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("cannot continue B's conversation, nor another member's private conversation in A's own organization", async () => {
    const before = snapshot(orgB);
    const intoB = await ask(A.cookie, { question: "hello", conversationId: wb.conversationId });
    expect(intoB.status).toBe(404);
    const colleague = await ask(A2.cookie, { question: "hello", conversationId: wa.conversationId }); // A2 is in A's org but the chat is A's
    expect(colleague.status).toBe(404);
    expect(h.generate).not.toHaveBeenCalled();
    expect(snapshot(orgB)).toBe(before);
  });

  it("each customer's suggested questions come from, and are cached for, that customer's documents only", async () => {
    h.generate.mockImplementation(async (req: { content: { text?: string }[] }) => {
      const prompt = JSON.stringify(req);
      return { text: JSON.stringify([prompt.includes("zebra") ? "What is the zebra policy?" : "What is the yak policy?", "Another question here?", "A third question here?"]) };
    });

    const a = await body<{ questions: string[] }>(await call(suggestionsRoute.GET, "/api/suggestions", { cookie: A.cookie }));
    const b = await body<{ questions: string[] }>(await call(suggestionsRoute.GET, "/api/suggestions", { cookie: B.cookie }));

    expect(a.questions[0]).toContain("zebra");
    expect(b.questions[0]).toContain("yak");
    const prompts = promptsSentTo();
    expect(prompts[0]).not.toMatch(/yak|quartz/i); // A's request carried only A's excerpts
    expect(prompts[1]).not.toMatch(/zebra|amber/i); // B's carried only B's
    const cached = db.prepare("SELECT org_id, value FROM org_settings WHERE key = 'suggested_questions' ORDER BY org_id").all() as { org_id: string; value: string }[];
    expect(cached.map((c) => c.org_id).sort()).toEqual([orgA, orgB].sort());
    expect(cached.find((c) => c.org_id === orgA)!.value).not.toMatch(/yak/);
    expect(cached.find((c) => c.org_id === orgB)!.value).not.toMatch(/zebra/);
    // B asking again is served from B's cache, never from A's.
    const again = await body<{ questions: string[] }>(await call(suggestionsRoute.GET, "/api/suggestions", { cookie: B.cookie }));
    expect(again.questions).toEqual(b.questions);
  });

  function promptsSentTo(): string[] {
    return h.generate.mock.calls.map((c) => JSON.stringify(c[0]));
  }
});

describe("writing: Customer A cannot change or delete Customer B's data", () => {
  it("every attempt on B's objects fails as 'not found' and leaves everything of B's untouched", async () => {
    const before = snapshot(orgB);
    const asA = (handler: unknown, url: string, params: Record<string, string>, method: string, json?: unknown) => call(handler, url, { method, cookie: A.cookie, params, json });

    const attempts = [
      await asA(documentRoute.DELETE, `/api/documents/${wb.docs.ready[0]}`, { id: wb.docs.ready[0]! }, "DELETE"),
      await asA(documentRoute.DELETE, `/api/documents/${wb.docs.failed}`, { id: wb.docs.failed }, "DELETE"),
      await asA(conversationRoute.PATCH, `/api/conversations/${wb.conversationId}`, { id: wb.conversationId }, "PATCH", { knowledgeScope: { type: "all" } }),
      await asA(conversationRoute.DELETE, `/api/conversations/${wb.conversationId}`, { id: wb.conversationId }, "DELETE"),
      await asA(languageRoute.POST, `/api/messages/${wb.assistantMessageId}/language`, { id: wb.assistantMessageId }, "POST", { language: "hi" }),
      await asA(languageRoute.POST, `/api/messages/${wb.userMessageId}/language`, { id: wb.userMessageId }, "POST", { language: "hi" }),
      await asA(integrationRoute.PATCH, `/api/integrations/${wb.integrationId}`, { id: wb.integrationId }, "PATCH", { enabled: false, configuration: { url: "https://evil.example.com/" } }),
      await asA(syncRoute.POST, `/api/integrations/${wb.integrationId}/sync`, { id: wb.integrationId }, "POST"),
      await asA(disconnectRoute.POST, `/api/integrations/${wb.integrationId}/disconnect`, { id: wb.integrationId }, "POST"),
    ];

    for (const res of attempts) expect(res.status).toBe(404);
    expect(snapshot(orgB)).toBe(before);
    expect(h.generate).not.toHaveBeenCalled();
  });

  it("'clear failed' removes only A's failed documents, never B's", async () => {
    const res = await call(failedRoute.DELETE, "/api/documents/failed", { method: "DELETE", cookie: A.cookie });
    expect((await body<{ deletedIds: string[] }>(res)).deletedIds).toEqual([wa.docs.failed]);
    expect((db.prepare("SELECT id FROM documents WHERE id = ?").get(wb.docs.failed) as { id: string }).id).toBe(wb.docs.failed);
  });

  it("an upload by A is stored in A's organization only", async () => {
    const form = new FormData();
    form.append("file", new File(["Zebra amber policy."], "new upload.txt", { type: "text/plain" }));
    const res = await call(documentsRoute.POST, "/api/documents", { method: "POST", cookie: A.cookie, form });
    expect(res.status).toBe(201);
    const id = (await body<{ document: { id: string } }>(res)).document.id;
    expect(db.prepare("SELECT org_id FROM documents WHERE id = ?").get(id)).toEqual({ org_id: orgA });
    expect(db.prepare("SELECT DISTINCT org_id FROM chunks WHERE document_id = ?").all(id)).toEqual([{ org_id: orgA }]);
    expect(await body(await call(documentsRoute.GET, "/api/documents", { cookie: B.cookie }))).not.toMatchObject({ documents: expect.arrayContaining([expect.objectContaining({ id })]) });
  });

  it("a chat message by A is saved under A's conversation and A's organization", async () => {
    const res = await call(askRoute.POST, "/api/ask", { method: "POST", cookie: A.cookie, json: { question: "zebra policy" } });
    const { conversationId } = await body<{ conversationId: string }>(res);
    expect(db.prepare("SELECT org_id, user_id FROM conversations WHERE id = ?").get(conversationId)).toEqual({ org_id: orgA, user_id: A.userId });
  });
});

describe("inside one organization, conversations are private to their author", () => {
  it("another member sees none of them: not in lists, not by ID, not by message", async () => {
    const list = await body<{ conversations: unknown[] }>(await call(conversationsRoute.GET, "/api/conversations", { cookie: A2.cookie }));
    expect(list.conversations).toEqual([]);

    const params = { id: wa.conversationId };
    await expectSameAsMissing(
      await call(conversationRoute.GET, `/api/conversations/${wa.conversationId}`, { cookie: A2.cookie, params }),
      await call(conversationRoute.GET, `/api/conversations/${UNKNOWN_ID}`, { cookie: A2.cookie, params: { id: UNKNOWN_ID } }),
    );
    expect((await call(conversationRoute.PATCH, "/x", { method: "PATCH", cookie: A2.cookie, params, json: { knowledgeScope: { type: "all" } } })).status).toBe(404);
    expect((await call(conversationRoute.DELETE, "/x", { method: "DELETE", cookie: A2.cookie, params })).status).toBe(404);
    expect((await call(languageRoute.POST, "/x", { method: "POST", cookie: A2.cookie, params: { id: wa.assistantMessageId }, json: { language: "hi" } })).status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id = ?").get(wa.conversationId)).toEqual({ n: 1 });
  });

  it("but the organization's documents are shared with all its members", async () => {
    const res = await body<{ documents: unknown[] }>(await call(documentsRoute.GET, "/api/documents", { cookie: A2.cookie }));
    expect(res.documents).toHaveLength(3);
  });
});

describe("the database itself refuses cross-organization data", () => {
  it("a repository, vector store or integration store cannot even be created without an organization", () => {
    expect(() => new DocumentRepository(db, "")).toThrow(/needs an organization/);
    expect(() => new SqliteVectorStore(db, "")).toThrow(/needs an organization/);
    expect(() => new IntegrationRepository(db, "")).toThrow(/needs an organization/);
    expect(() => new ConversationRepository(db, orgA, "")).toThrow(/needs an organization and a user/);
    expect(() => new ConversationRepository(db, "", A.userId)).toThrow(/needs an organization and a user/);
  });

  it("vector search is confined to the store's organization, whatever document IDs it is given", async () => {
    const query = await h.embedder.embedQuery("yak quartz policy guide zebra amber");
    const storeA = new SqliteVectorStore(db, orgA);
    const options = { topK: 50, minScore: -1, embeddingModel: h.embedder.modelId };

    const everything = storeA.search(query, options);
    expect(everything.length).toBeGreaterThan(0);
    for (const hit of everything) expect(wa.docs.ready).toContain(hit.documentId);

    // Even when asked for B's documents by ID, A's store returns nothing.
    expect(storeA.search(query, { ...options, documentIds: wb.docs.ready })).toEqual([]);
    expect(storeA.search(query, { ...options, documentIds: [...wb.docs.ready, wa.docs.ready[0]!] }).map((h2) => h2.documentId)).toEqual(
      expect.not.arrayContaining(wb.docs.ready),
    );
  });

  it("a store of one organization cannot write chunks into another organization's document (database trigger)", () => {
    const attacker = new SqliteVectorStore(db, orgA);
    expect(() =>
      attacker.addChunks(wb.docs.ready[0]!, h.embedder.modelId, [{ chunkIndex: 99, content: "planted", pageStart: null, pageEnd: null, embedding: new Float32Array(VOCAB.length) }]),
    ).toThrow(/same organization as its document/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE content = 'planted'").get()).toEqual({ n: 0 });
  });

  it("a repository of one organization cannot create or move rows into another", () => {
    // Even code that bypasses the repositories can't store ownerless rows or move rows between organizations.
    expect(() => db.prepare("INSERT INTO documents (id, filename, mime_type, size_bytes, status) VALUES ('x', 'x', 'x', 1, 'ready')").run()).toThrow(/org_id is required/);
    expect(() => db.prepare("UPDATE documents SET org_id = ? WHERE id = ?").run(orgA, wb.docs.ready[0])).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE conversations SET org_id = ? WHERE id = ?").run(orgA, wb.conversationId)).toThrow(/cannot be changed/);
    expect(() => db.prepare("UPDATE integration_connections SET org_id = ? WHERE id = ?").run(orgA, wb.integrationId)).toThrow(/cannot be changed/);
  });

  it("deleting by ID through a scoped repository cannot reach another organization's row", () => {
    const docsA = new DocumentRepository(db, orgA);
    expect(docsA.delete(wb.docs.ready[0]!)).toBe(false);
    expect(docsA.get(wb.docs.ready[0]!)).toBeUndefined();
    expect(docsA.existingIds([wb.docs.ready[0]!, wa.docs.ready[0]!])).toEqual(new Set([wa.docs.ready[0]]));
    expect(new ConversationRepository(db, orgA, A.userId).delete(wb.conversationId)).toBe(false);
    expect(new IntegrationRepository(db, orgA).get(wb.integrationId)).toBeUndefined();
    expect(new IntegrationRepository(db, orgA).getRun(wb.runId)).toBeUndefined();
    expect(new IntegrationRepository(db, orgA).getCredentials(wb.integrationId)).toBeNull();
  });

  it("OAuth state and credentials of one organization cannot be created, read or consumed by another", () => {
    const repoB = new IntegrationRepository(db, orgB);
    const repoA = new IntegrationRepository(db, orgA);
    const driveB = repoB.getByType("google_drive");
    repoB.createOAuthState("state-of-b", driveB.id, "verifier-of-b");

    expect(() => repoA.createOAuthState("sneaky", driveB.id, "v")).toThrow(/not found/);
    expect(repoA.consumeOAuthState("state-of-b")).toBeNull(); // A can't read it...
    expect(repoB.consumeOAuthState("state-of-b")).toMatchObject({ integrationId: driveB.id, codeVerifier: "verifier-of-b" }); // ...nor use it up for B
    expect(() => repoA.saveCredentials(driveB.id, { ciphertext: Buffer.from("x"), iv: Buffer.from("y"), authTag: Buffer.from("z") })).toThrow(/not found/);
    expect(() => repoA.startRun(driveB.id)).toThrow(/not found/);
  });
});

describe("sessions and membership decide which organization's data a request sees", () => {
  it("a person in two organizations sees only the one they are working in, and switching changes it", async () => {
    const both = seedMember(db, orgB, "owner@acme.test", "viewer"); // the same person (A) is also a viewer in B
    expect(both.userId).toBe(A.userId);

    const inB = await body<{ documents: { id: string }[] }>(await call(documentsRoute.GET, "/api/documents", { cookie: both.cookie }));
    expect(inB.documents.map((d) => d.id).sort()).toEqual([...wb.docs.ready, wb.docs.failed].sort());
    const inA = await body<{ documents: { id: string }[] }>(await call(documentsRoute.GET, "/api/documents", { cookie: A.cookie }));
    expect(inA.documents.map((d) => d.id).sort()).toEqual([...wa.docs.ready, wa.docs.failed].sort());
    // Their conversations belong to the organization they were created in.
    const convsInB = await body<{ conversations: unknown[] }>(await call(conversationsRoute.GET, "/api/conversations", { cookie: both.cookie }));
    expect(convsInB.conversations).toEqual([]);
  });

  it("losing membership cuts access immediately, with no way to read the data afterwards", async () => {
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: A2.cookie })).status).toBe(200);
    db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").run(orgA, A2.userId);
    const res = await call(documentsRoute.GET, "/api/documents", { cookie: A2.cookie });
    expect(res.status).toBe(401);
    expect(JSON.stringify(await body(res))).not.toContain("handbook");
  });

  it("a disabled account loses access at once", async () => {
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(A2.userId);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: A2.cookie })).status).toBe(401);
  });

  it("organization and user IDs sent in headers, query strings or bodies are ignored", async () => {
    const res = await call(documentsRoute.GET, `/api/documents?orgId=${orgB}&tenantId=${orgB}`, {
      cookie: A.cookie,
      headers: { "x-org-id": orgB, "x-tenant-id": orgB, "x-user-id": B.userId },
    });
    const docs = await body<{ documents: { id: string }[] }>(res);
    expect(docs.documents.map((d) => d.id)).not.toEqual(expect.arrayContaining(wb.docs.ready));
    expect(docs.documents).toHaveLength(3);
  });
});

describe("nothing is reachable without a signed-in session", () => {
  const routes: { name: string; handler: unknown; method: string; url: string; params?: Record<string, string> }[] = [
    { name: "documents GET", handler: documentsRoute.GET, method: "GET", url: "/api/documents" },
    { name: "documents POST", handler: documentsRoute.POST, method: "POST", url: "/api/documents" },
    { name: "document DELETE", handler: documentRoute.DELETE, method: "DELETE", url: "/api/documents/x", params: { id: "x" } },
    { name: "failed DELETE", handler: failedRoute.DELETE, method: "DELETE", url: "/api/documents/failed" },
    { name: "conversations GET", handler: conversationsRoute.GET, method: "GET", url: "/api/conversations" },
    { name: "conversation GET", handler: conversationRoute.GET, method: "GET", url: "/api/conversations/x", params: { id: "x" } },
    { name: "conversation PATCH", handler: conversationRoute.PATCH, method: "PATCH", url: "/api/conversations/x", params: { id: "x" } },
    { name: "conversation DELETE", handler: conversationRoute.DELETE, method: "DELETE", url: "/api/conversations/x", params: { id: "x" } },
    { name: "message language", handler: languageRoute.POST, method: "POST", url: "/api/messages/x/language", params: { id: "x" } },
    { name: "ask", handler: askRoute.POST, method: "POST", url: "/api/ask" },
    { name: "knowledge sources", handler: sourcesRoute.GET, method: "GET", url: "/api/knowledge-sources" },
    { name: "stats", handler: statsRoute.GET, method: "GET", url: "/api/stats" },
    { name: "suggestions", handler: suggestionsRoute.GET, method: "GET", url: "/api/suggestions" },
    { name: "integrations GET", handler: integrationsRoute.GET, method: "GET", url: "/api/integrations" },
    { name: "integration PATCH", handler: integrationRoute.PATCH, method: "PATCH", url: "/api/integrations/x", params: { id: "x" } },
    { name: "integration sync", handler: syncRoute.POST, method: "POST", url: "/api/integrations/x/sync", params: { id: "x" } },
    { name: "integration runs", handler: runsRoute.GET, method: "GET", url: "/api/integrations/x/sync-runs", params: { id: "x" } },
    { name: "integration run", handler: runRoute.GET, method: "GET", url: "/api/integrations/x/sync-runs/y", params: { id: "x", runId: "y" } },
    { name: "integration folders", handler: foldersRoute.GET, method: "GET", url: "/api/integrations/x/folders", params: { id: "x" } },
    { name: "integration disconnect", handler: disconnectRoute.POST, method: "POST", url: "/api/integrations/x/disconnect", params: { id: "x" } },
  ];

  it.each(routes)("$name answers 401 and reveals nothing", async ({ handler, method, url, params }) => {
    const before = snapshot(orgA) + snapshot(orgB);
    const res = await call(handler, url, { method, params });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue.", code: "unauthenticated" });
    expect(snapshot(orgA) + snapshot(orgB)).toBe(before);
  });

  it("a forged, expired or other-looking cookie is not accepted anywhere", async () => {
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: `kb_session=${"A".repeat(43)}` })).status).toBe(401);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: "kb_session=short" })).status).toBe(401);
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: `other=${A.cookie.split("=")[1]}` })).status).toBe(401);
    db.prepare("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await call(documentsRoute.GET, "/api/documents", { cookie: A.cookie })).status).toBe(401);
  });
});
