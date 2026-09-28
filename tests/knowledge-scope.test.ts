import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { knowledgeScopeSchema, scopeKey, sourceCountLabel, websiteHost, type KnowledgeScope } from "@/lib/knowledge-scope";
import { ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import { toConversationSummaryDTO } from "@/server/dto";
import { ingestDocument, upsertSourceDocument } from "@/server/knowledge/ingest";
import { listKnowledgeSources, scopeDocumentIds, searchableDocuments } from "@/server/knowledge/scope";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { askInConversation } from "@/server/rag/chat";
import { FakeEmbedder, memoryDb, promptText, testConfig } from "./helpers";

const WEB = randomUUID();
const DRIVE = randomUUID();

/** A knowledge base with two websites, a Google Drive file and two uploads, all about "policy". */
async function setup() {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["policy", "refund", "quotes", "einstein", "metformin", "dose", "drive", "handbook", "other"]);
  const vectorStore = new SqliteVectorStore(db);
  const ingest = { db, embedder, vectorStore, chunkOptions: { chunkSize: 200, overlap: 0 } };
  const page = (url: string, text: string) =>
    upsertSourceDocument(ingest, {
      filename: "page.txt",
      displayName: url,
      buffer: Buffer.from(text),
      source: { type: "website", externalId: url, url, integrationId: WEB },
    });
  await page("http://quotes.toscrape.com/", "Quotes policy: famous quotes by Einstein.");
  await page("http://www.quotes.toscrape.com/page/2", "More quotes policy from Einstein.");
  await page("https://other.example/", "Other website policy text.");
  await upsertSourceDocument(ingest, {
    filename: "handbook.txt",
    displayName: "handbook.txt",
    buffer: Buffer.from("Drive handbook policy."),
    source: { type: "google_drive", externalId: "file-1", url: null, integrationId: DRIVE },
  });
  const metformin = await ingestDocument(ingest, { filename: "Metformin.txt", buffer: Buffer.from("Metformin dose policy: start low.") });
  const refund = await ingestDocument(ingest, { filename: "refund.txt", buffer: Buffer.from("Refund policy: 30 days.") });

  const generate = vi.fn(async (_req: LLMRequest) => ({ text: "Answer [1]." }));
  const provider: LLMProvider = { id: "gemini", generate };
  const conversations = new ConversationRepository(db);
  const documents = new DocumentRepository(db);
  const deps = {
    embedder,
    vectorStore,
    conversations,
    documents,
    providerConfig: new ProviderConfigService(db, testConfig({ DEFAULT_AI_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-test-key-1234567890", GEMINI_MODEL: "g" })),
    getProvider: () => provider,
    retrieval: { topK: 10, minScore: 0.01 },
  };
  const citedFiles = async (knowledgeScope?: KnowledgeScope, conversationId?: string) => {
    const res = await askInConversation(deps, { question: "What is the policy?", knowledgeScope, conversationId });
    return { res, files: [...new Set(res.assistantMessage.citations.map((c) => c.filename))].sort() };
  };
  return { db, embedder, documents, conversations, deps, generate, metformin: metformin.documentId, refund: refund.documentId, citedFiles };
}

describe("knowledge scope model", () => {
  it("validates scopes and builds stable keys", () => {
    expect(knowledgeScopeSchema.safeParse({ type: "all" }).success).toBe(true);
    expect(knowledgeScopeSchema.safeParse({ type: "website", integrationId: WEB, host: "quotes.toscrape.com" }).success).toBe(true);
    expect(knowledgeScopeSchema.safeParse({ type: "document", documentId: "not-a-uuid" }).success).toBe(false);
    expect(knowledgeScopeSchema.safeParse({ type: "all", extra: 1 }).success).toBe(false);
    expect(scopeKey({ type: "google_drive", integrationId: DRIVE })).toBe(`google_drive:${DRIVE}`);
    expect(websiteHost("https://WWW.Example.com/a")).toBe("example.com");
    expect(sourceCountLabel({ scope: { type: "website", integrationId: WEB, host: "x" }, count: 9 })).toBe("9 pages");
    expect(sourceCountLabel({ scope: { type: "document", documentId: WEB }, count: 1 })).toBe("1 document");
  });
});

describe("Chat with: sources from the database", () => {
  it("lists All Knowledge Base, each website (by host), each cloud drive and each uploaded document", async () => {
    const { documents, embedder } = await setup();
    const sources = listKnowledgeSources(searchableDocuments(documents.list(), embedder.modelId));
    expect(sources.map((s) => `${s.scope.type}:${s.label}:${s.count}`)).toEqual([
      "all:All Knowledge Base:6",
      "website:other.example:1",
      "website:quotes.toscrape.com:2", // www. and bare host are one website
      "google_drive:Google Drive:1",
      "document:Metformin.txt:1",
      "document:refund.txt:1",
    ]);
  });

  it("only offers indexed content: failed or outdated documents are not sources", async () => {
    const { documents, embedder, metformin, db } = await setup();
    db.prepare("UPDATE documents SET status = 'failed' WHERE id = ?").run(metformin);
    const sources = listKnowledgeSources(searchableDocuments(documents.list(), embedder.modelId));
    expect(sources.find((s) => s.label === "Metformin.txt")).toBeUndefined();
    expect(sources[0]!.count).toBe(5);
    expect(listKnowledgeSources(searchableDocuments(documents.list(), "another-model"))).toEqual([
      { key: "all", scope: { type: "all" }, label: "All Knowledge Base", count: 0 },
    ]);
  });

  it("resolves a scope to exactly its documents; an empty scope is not 'everything'", async () => {
    const { documents, embedder } = await setup();
    const rows = searchableDocuments(documents.list(), embedder.modelId);
    expect(scopeDocumentIds(rows, { type: "all" })).toBeUndefined();
    expect(scopeDocumentIds(rows, { type: "website", integrationId: WEB, host: "quotes.toscrape.com" })).toHaveLength(2);
    expect(scopeDocumentIds(rows, { type: "onedrive", integrationId: randomUUID() })).toEqual([]);
  });
});

describe("Chat with: retrieval is really filtered", () => {
  it("website scope retrieves only that website's pages", async () => {
    const { citedFiles } = await setup();
    const { files } = await citedFiles({ type: "website", integrationId: WEB, host: "quotes.toscrape.com" });
    expect(files).toEqual(["http://quotes.toscrape.com/", "http://www.quotes.toscrape.com/page/2"]);
  });

  it("document scope retrieves only that document", async () => {
    const { citedFiles, metformin, generate } = await setup();
    const { files } = await citedFiles({ type: "document", documentId: metformin });
    expect(files).toEqual(["Metformin.txt"]);
    expect(promptText(generate.mock.calls[0]![0])).not.toMatch(/Einstein|Refund|handbook/i);
  });

  it("Google Drive scope retrieves only Drive files", async () => {
    const { citedFiles } = await setup();
    expect((await citedFiles({ type: "google_drive", integrationId: DRIVE })).files).toEqual(["handbook.txt"]);
  });

  it("All Knowledge Base retrieves from every source", async () => {
    const { citedFiles } = await setup();
    expect((await citedFiles({ type: "all" })).files).toHaveLength(6);
  });

  it("a source with no indexed documents searches nothing (no fallback to everything)", async () => {
    const { citedFiles, generate } = await setup();
    const { res } = await citedFiles({ type: "onedrive", integrationId: randomUUID() });
    expect(res.assistantMessage).toMatchObject({ noContext: true, citations: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("citations carry their source (website URL / drive / upload)", async () => {
    const { citedFiles } = await setup();
    const { res } = await citedFiles({ type: "all" });
    const bySource = Object.fromEntries(res.assistantMessage.citations.map((c) => [c.filename, [c.sourceType, c.sourceUrl ?? null]]));
    expect(bySource["http://quotes.toscrape.com/"]).toEqual(["website", "http://quotes.toscrape.com/"]);
    expect(bySource["handbook.txt"]).toEqual(["google_drive", null]);
    expect(bySource["refund.txt"]).toEqual(["upload", null]);
  });
});

describe("Chat with: stored with the conversation", () => {
  it("remembers the scope, reuses it for follow-ups, and changes only when asked", async () => {
    const { citedFiles, conversations, metformin } = await setup();
    const website: KnowledgeScope = { type: "website", integrationId: WEB, host: "quotes.toscrape.com" };
    const first = await citedFiles(website);
    const id = first.res.conversationId;
    expect(toConversationSummaryDTO(conversations.get(id)!).knowledgeScope).toEqual(website);

    // Follow-up without a scope: the conversation's own scope applies (no mixing).
    const followUp = await citedFiles(undefined, id);
    expect(followUp.files.every((f) => f.includes("quotes.toscrape.com"))).toBe(true);

    // An explicit change (after the user confirmed) is stored.
    conversations.setKnowledgeScope(id, { type: "document", documentId: metformin });
    expect((await citedFiles(undefined, id)).files).toEqual(["Metformin.txt"]);
    expect(toConversationSummaryDTO(conversations.get(id)!).knowledgeScope).toEqual({ type: "document", documentId: metformin });
  });

  it("older chats without a stored scope read as All Knowledge Base (null)", async () => {
    const { conversations } = await setup();
    const id = conversations.create("old chat");
    expect(toConversationSummaryDTO(conversations.get(id)!).knowledgeScope).toBeNull();
  });
});
