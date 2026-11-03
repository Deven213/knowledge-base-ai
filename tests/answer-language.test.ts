import { describe, expect, it, vi } from "vitest";
import { getLanguage } from "@/lib/languages";
import { ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import { toMessageDTO } from "@/server/dto";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { MessageNotFoundError, setAnswerLanguage } from "@/server/rag/answer-language";
import { askInConversation } from "@/server/rag/chat";
import { FakeEmbedder, memoryDb, promptText, SCRIPT_TAG, TEST_ORG, testConfig, testUserId } from "./helpers";

// Changing the language of an answer that already exists TRANSLATES it: no retrieval, no new answer, and only the text
// of the answer goes to the model. (Caching, checks, concurrency and isolation are in tests/answer-translation.test.ts.)

const english = JSON.stringify({
  found: true,
  title: "Common reactions",
  summary: "",
  sections: [
    { title: "Reactions", tab: "Reactions", kind: "info", content: "", bullets: ["Diarrhea in **10 %** [1]"], numbered: false, table: { headers: [], rows: [] }, callout: { type: "none", label: "", text: "" }, citations: [1] },
    { title: "Missed dose", tab: "Missed dose", kind: "info", content: "Take it when remembered [2].", bullets: [], numbered: false, table: { headers: [], rows: [] }, callout: { type: "none", label: "", text: "" }, citations: [2] },
  ],
});

/** Answers questions with the English reply above, and translates by tagging every string (which keeps markers and numbers). */
function fakeModel() {
  return vi.fn(async (req: LLMRequest) => {
    if (/^You translate/.test(req.system)) {
      const language = /into (\w+)/.exec(req.system)![1]!;
      const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
      return { text: JSON.stringify({ t: strings.map((s) => `${SCRIPT_TAG[language]}~${s}`) }) };
    }
    return { text: english };
  });
}

async function setup() {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["metformin", "reactions", "diarrhea", "dose", "missed"]);
  const vectorStore = new SqliteVectorStore(db, TEST_ORG);
  await ingestDocument(
    { db, embedder, vectorStore, documents: new DocumentRepository(db, TEST_ORG), chunkOptions: { chunkSize: 60, overlap: 0 } },
    { filename: "Metformin.txt", buffer: Buffer.from("Metformin reactions: diarrhea.\n\nMissed dose metformin: take when remembered.") },
  );
  const providerConfig = new ProviderConfigService(db, testConfig({ GEMINI_API_KEY: "AIza-test-key-12345678", GEMINI_MODEL: "g", DEFAULT_AI_PROVIDER: "gemini" }));
  const generate = fakeModel();
  const provider: LLMProvider = { id: "gemini", generate };
  const conversations = new ConversationRepository(db, TEST_ORG, testUserId(db));
  const search = vi.spyOn(vectorStore, "search");
  const embedQuery = vi.spyOn(embedder, "embedQuery");
  const embedDocuments = vi.spyOn(embedder, "embedDocuments");
  const deps = { embedder, vectorStore, providerConfig, conversations, getProvider: () => provider, retrieval: { topK: 3, minScore: 0.1 } };
  return { db, deps, generate, conversations, search, embedQuery, embedDocuments };
}

describe("per-response language", () => {
  it("translates the answer in place, keeping the question, sources and history, without retrieval or a new answer", async () => {
    const { deps, generate, conversations, search, embedQuery, embedDocuments } = await setup();
    const q1 = await askInConversation(deps, { question: "metformin reactions and missed dose?" });
    const q2 = await askInConversation(deps, { question: "missed dose metformin?", conversationId: q1.conversationId });
    const before = conversations.messages(q1.conversationId).map(toMessageDTO);
    const counts = { search: search.mock.calls.length, embedQuery: embedQuery.mock.calls.length, embedDocuments: embedDocuments.mock.calls.length, model: generate.mock.calls.length };

    const hi = await setAnswerLanguage(deps, q1.assistantMessage.id, "hi");

    expect(hi.id).toBe(q1.assistantMessage.id);
    expect(hi.language).toBe("hi");
    expect(hi.structured?.title).toBe("हिन्दी~Common reactions");
    expect(hi.structured?.sections.map((s) => s.title)).toEqual(["हिन्दी~Reactions", "हिन्दी~Missed dose"]);
    expect(hi.citations).toEqual(q1.assistantMessage.citations); // same sources and pages
    expect(hi.structured?.sources).toEqual(q1.assistantMessage.structured?.sources);
    // Nothing was searched, embedded or answered again: exactly one model call, a translation.
    expect(search.mock.calls.length).toBe(counts.search);
    expect(embedQuery.mock.calls.length).toBe(counts.embedQuery);
    expect(embedDocuments.mock.calls.length).toBe(counts.embedDocuments);
    expect(generate.mock.calls.length).toBe(counts.model + 1);

    const after = conversations.messages(q1.conversationId).map(toMessageDTO);
    expect(after).toHaveLength(before.length); // no new message
    expect(after[0]!.content).toBe("metformin reactions and missed dose?"); // question unchanged
    expect(after[3]).toEqual(before[3]); // the other response is untouched
    expect(after[3]!.id).toBe(q2.assistantMessage.id);
    expect(after[3]!.language).toBe("en");
  });

  it("sends only the text of the answer to the model: no passages, no question, no answering rules, no sources", async () => {
    const { deps, generate } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions and missed dose?" });
    await setAnswerLanguage(deps, assistantMessage.id, "gu");

    const req = generate.mock.calls.at(-1)![0];
    expect(req.system).toMatch(/^You translate a clinical reference note into Gujarati/);
    expect(req.system).not.toMatch(/Answer using ONLY|Output format|<sources>/);
    expect(req.responseFormat?.name).toBe("translated_strings");
    expect(req.reasoning).toBe("minimal"); // translating needs no reasoning, and reasoning is most of the waiting time
    const sent = promptText(req);
    expect(JSON.parse(sent)).toEqual(["Common reactions", "Reactions", "Reactions", "Diarrhea in **10 %** [1]", "Missed dose", "Missed dose", "Take it when remembered [2]."]);
    expect(sent).not.toContain("Metformin reactions: diarrhea."); // the passages stay on the server
    expect(sent).not.toContain("metformin reactions and missed dose?"); // and so does the question
    expect(sent.length).toBeLessThan(400);
  });

  it("keeps the structure of the answer exactly: kinds, steps, callout types, source numbers and sources", async () => {
    const { deps } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    const gu = await setAnswerLanguage(deps, assistantMessage.id, "gu");
    const strip = (r: typeof gu.structured) => JSON.stringify(r?.sections.map(({ title: _t, tab: _a, content: _c, bullets, callout, ...rest }) => ({ ...rest, bullets: bullets?.length, callout: callout?.type })));
    expect(strip(gu.structured)).toBe(strip(assistantMessage.structured));
    expect(gu.structured?.sources).toEqual(assistantMessage.structured?.sources);
    expect(gu.structured?.found).toBe(true);
    expect(gu.structured?.language).toBe("gu");
  });

  it("reuses saved language versions without calling the model again", async () => {
    const { deps, generate } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    await setAnswerLanguage(deps, assistantMessage.id, "gu");
    const calls = generate.mock.calls.length;

    const en = await setAnswerLanguage(deps, assistantMessage.id, "en");
    const gu = await setAnswerLanguage(deps, assistantMessage.id, "gu");
    expect(generate.mock.calls.length).toBe(calls);
    expect(en).toMatchObject({ language: "en", content: assistantMessage.content, structured: assistantMessage.structured });
    expect(gu.structured?.title).toBe("ગુજરાતી~Common reactions");
  });

  it("keeps the current answer when translation fails", async () => {
    const { deps, generate, conversations } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    generate.mockRejectedValueOnce(new Error("provider down"));
    await expect(setAnswerLanguage(deps, assistantMessage.id, "hi")).rejects.toThrow("provider down");
    expect(toMessageDTO(conversations.getMessage(assistantMessage.id)!)).toEqual(assistantMessage);
  });

  it("uses the fixed not-found text for answers where nothing was retrieved (no model call)", async () => {
    const { deps, generate } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "stock market?" });
    const calls = generate.mock.calls.length;
    const gu = await setAnswerLanguage(deps, assistantMessage.id, "gu");
    expect(generate.mock.calls.length).toBe(calls);
    expect(gu.structured).toMatchObject({ found: false, summary: getLanguage("gu").notFound });
  });

  it("works for messages saved before snapshots and language versions existed (translation needs neither)", async () => {
    const { deps, db, generate } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    db.prepare("UPDATE messages SET context_json = NULL, variants_json = NULL, language = NULL WHERE id = ?").run(assistantMessage.id);

    const hi = await setAnswerLanguage(deps, assistantMessage.id, "hi");

    expect(hi.language).toBe("hi");
    expect(hi.structured?.title).toBe("हिन्दी~Common reactions");
    expect(promptText(generate.mock.calls.at(-1)![0])).not.toContain("Question:");
    expect(toMessageDTO(deps.conversations.getMessage(assistantMessage.id)!).language).toBe("hi");
  });

  it("rejects unknown and user messages", async () => {
    const { deps } = await setup();
    const { userMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    await expect(setAnswerLanguage(deps, "00000000-0000-4000-8000-000000000000", "hi")).rejects.toThrow(MessageNotFoundError);
    await expect(setAnswerLanguage(deps, userMessage.id, "hi")).rejects.toThrow(MessageNotFoundError);
  });
});
