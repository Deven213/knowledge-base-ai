import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrate } from "@/server/db/migrate";
import { AppSettingsRepository, ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { ProviderConfigService } from "@/server/llm/resolve";
import { LLMError, type LLMProvider, type LLMRequest } from "@/server/llm/types";
import { askInConversation, ConversationNotFoundError } from "@/server/rag/chat";
import { parseQuestions, suggestQuestions } from "@/server/rag/suggest";
import { FakeEmbedder, memoryDb, testConfig } from "./helpers";

async function setup(generateText = "Battery warranty is 12 months [1].") {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["refund", "policy", "days", "warranty", "battery", "months"]);
  const vectorStore = new SqliteVectorStore(db);
  await ingestDocument(
    { db, embedder, vectorStore, chunkOptions: { chunkSize: 32, overlap: 0 } },
    { filename: "policy.txt", buffer: Buffer.from("Refund policy: 30 days.\n\nBattery warranty: 12 months.") },
  );
  const providerConfig = new ProviderConfigService(
    db,
    testConfig({ DEFAULT_AI_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-test-key-1234567890", GEMINI_MODEL: "g-model" }),
  );
  const generate = vi.fn(async (_req: LLMRequest) => ({ text: generateText }));
  const provider: LLMProvider = { id: "gemini", generate };
  const conversations = new ConversationRepository(db);
  const deps = {
    embedder,
    vectorStore,
    providerConfig,
    conversations,
    getProvider: () => provider,
    retrieval: { topK: 3, minScore: 0.2 },
  };
  return { db, deps, generate, conversations, providerConfig, embedder };
}

describe("askInConversation", () => {
  it("creates a conversation, uses the active provider and stores both messages", async () => {
    const { deps, generate, conversations } = await setup();
    const res = await askInConversation(deps, { question: "battery warranty?" });

    expect(generate.mock.calls[0]![0].model).toBe("g-model");
    expect(res.assistantMessage).toMatchObject({ role: "assistant", provider: "gemini", model: "g-model", noContext: false });
    expect(res.assistantMessage.citations[0]).toMatchObject({ filename: "policy.txt", cited: true });
    expect(conversations.get(res.conversationId)).toMatchObject({ title: "battery warranty?", message_count: 2 });

    // A follow-up goes into the same conversation, in order.
    await askInConversation(deps, { question: "refund policy?", conversationId: res.conversationId });
    const roles = conversations.messages(res.conversationId).map((m) => `${m.role}:${m.content.slice(0, 6)}`);
    expect(roles).toEqual(["user:batter", "assistant:Batter", "user:refund", "assistant:Batter"]);
  });

  it("saves nothing when the provider fails", async () => {
    const { deps, generate, conversations } = await setup();
    generate.mockRejectedValueOnce(new LLMError("auth", "bad key"));
    await expect(askInConversation(deps, { question: "battery warranty?" })).rejects.toThrow("bad key");
    expect(conversations.list()).toEqual([]);
  });

  it("rejects unknown conversations", async () => {
    const { deps } = await setup();
    await expect(
      askInConversation(deps, { question: "q", conversationId: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toThrow(ConversationNotFoundError);
  });

  it("searches titles and messages literally, and deletes messages with the conversation", async () => {
    const { deps, conversations, db } = await setup();
    const a = await askInConversation(deps, { question: "battery warranty?" });
    await askInConversation(deps, { question: "refund policy 100%?" });

    expect(conversations.list("warranty").map((c) => c.id)).toContain(a.conversationId);
    expect(conversations.list("100%")).toHaveLength(1);
    expect(conversations.list("%")).toHaveLength(1); // the wildcard is escaped
    expect(conversations.counts()).toEqual({ conversations: 2, questions: 2 });

    conversations.delete(a.conversationId);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(a.conversationId)).toEqual({ n: 0 });
  });
});

describe("suggestions", () => {
  it("parses a JSON array out of a chatty reply", () => {
    expect(parseQuestions('Sure!\n["What is the refund window?", "How long is the warranty?", 3, "x"]')).toEqual([
      "What is the refund window?",
      "How long is the warranty?",
    ]);
    expect(parseQuestions("no json here")).toEqual([]);
  });

  it("generates once and caches until the model or documents change", async () => {
    const { db, generate, providerConfig, embedder } = await setup(
      '["What is the refund policy?", "How long is the battery warranty?", "Is there a warranty?"]',
    );
    const deps = {
      documents: new DocumentRepository(db),
      settings: new AppSettingsRepository(db),
      providerConfig,
      getProvider: () => ({ id: "gemini" as const, generate }),
      embeddingModel: embedder.modelId,
    };
    const first = await suggestQuestions(deps);
    expect(first).toHaveLength(3);
    expect(await suggestQuestions(deps)).toEqual(first);
    expect(generate).toHaveBeenCalledOnce();

    providerConfig.saveModel("gemini", "other-model");
    await suggestQuestions(deps);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("returns [] without calling the LLM when the provider is not ready", async () => {
    const { db, generate, embedder } = await setup();
    const out = await suggestQuestions({
      documents: new DocumentRepository(db),
      settings: new AppSettingsRepository(db),
      providerConfig: new ProviderConfigService(db, testConfig({ DEFAULT_AI_PROVIDER: "openai" })),
      getProvider: () => ({ id: "openai" as const, generate }),
      embeddingModel: embedder.modelId,
    });
    expect(out).toEqual([]);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("migrations 2-3", () => {
  it("drops stored API keys from an existing v1 database but keeps model overrides", () => {
    const db = new Database(":memory:");
    // A v1 database with an encrypted key saved from the old UI.
    db.exec(`
      CREATE TABLE documents (id TEXT PRIMARY KEY, filename TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        page_count INTEGER, status TEXT NOT NULL, error TEXT, chunk_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT '');
      CREATE TABLE chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL,
        page_start INTEGER, page_end INTEGER, embedding BLOB NOT NULL, embedding_model TEXT NOT NULL);
      CREATE TABLE provider_settings (provider TEXT PRIMARY KEY, key_ciphertext BLOB, key_iv BLOB, key_auth_tag BLOB,
        key_last4 TEXT, model TEXT, updated_at TEXT NOT NULL DEFAULT '');
      INSERT INTO provider_settings VALUES ('openai', x'01', x'02', x'03', 'abcd', 'kept-model', '');
      PRAGMA user_version = 1;
    `);
    migrate(db);

    const cols = (db.prepare("PRAGMA table_info(provider_settings)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["provider", "model", "updated_at"]);
    expect(db.prepare("SELECT model FROM provider_settings").get()).toEqual({ model: "kept-model" });
    expect(db.pragma("user_version", { simple: true })).toBe(9);
  });
});
