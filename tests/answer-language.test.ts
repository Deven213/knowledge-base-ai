import { describe, expect, it, vi } from "vitest";
import { getLanguage } from "@/lib/languages";
import { ConversationRepository } from "@/server/db/repositories";
import { toMessageDTO } from "@/server/dto";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { MessageNotFoundError, setAnswerLanguage } from "@/server/rag/answer-language";
import { askInConversation } from "@/server/rag/chat";
import { FakeEmbedder, memoryDb, promptText, testConfig } from "./helpers";

const reply = (lang: string) =>
  JSON.stringify({
    found: true,
    title: { en: "Common reactions", hi: "सामान्य प्रतिक्रियाएँ", gu: "સામાન્ય પ્રતિક્રિયાઓ" }[lang],
    summary: "",
    sections: [
      { title: { en: "Reactions", hi: "प्रतिक्रियाएँ", gu: "પ્રતિક્રિયાઓ" }[lang], content: "", bullets: ["x"], callout: { type: "none", text: "" }, citations: [1] },
      { title: { en: "Missed dose", hi: "छूटी खुराक", gu: "ચૂકી ગયેલ ડોઝ" }[lang], content: "y", bullets: [], callout: { type: "none", text: "" }, citations: [2] },
    ],
  });

async function setup() {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["metformin", "reactions", "diarrhea", "dose", "missed"]);
  const vectorStore = new SqliteVectorStore(db);
  await ingestDocument(
    { db, embedder, vectorStore, chunkOptions: { chunkSize: 60, overlap: 0 } },
    { filename: "Metformin.txt", buffer: Buffer.from("Metformin reactions: diarrhea.\n\nMissed dose metformin: take when remembered.") },
  );
  const providerConfig = new ProviderConfigService(db, testConfig({ GEMINI_API_KEY: "AIza-test-key-12345678", GEMINI_MODEL: "g", DEFAULT_AI_PROVIDER: "gemini" }));
  const generate = vi.fn(async (req: LLMRequest) => {
    const lang = /Response language: Hindi/.test(req.system) ? "hi" : /Response language: Gujarati/.test(req.system) ? "gu" : "en";
    return { text: reply(lang) };
  });
  const provider: LLMProvider = { id: "gemini", generate };
  const conversations = new ConversationRepository(db);
  const search = vi.spyOn(vectorStore, "search");
  const deps = { embedder, vectorStore, providerConfig, conversations, getProvider: () => provider, retrieval: { topK: 3, minScore: 0.1 } };
  return { db, deps, generate, conversations, search };
}

describe("per-response language", () => {
  it("updates the same message in place, keeps the question and sources, and does not search again", async () => {
    const { deps, generate, conversations, search } = await setup();
    const q1 = await askInConversation(deps, { question: "metformin reactions and missed dose?" });
    const q2 = await askInConversation(deps, { question: "missed dose metformin?", conversationId: q1.conversationId });
    const before = conversations.messages(q1.conversationId).map(toMessageDTO);
    const searchesBefore = search.mock.calls.length;

    const hi = await setAnswerLanguage(deps, q1.assistantMessage.id, "hi");

    expect(hi.id).toBe(q1.assistantMessage.id);
    expect(hi.language).toBe("hi");
    expect(hi.structured?.title).toBe("सामान्य प्रतिक्रियाएँ");
    expect(hi.citations).toEqual(q1.assistantMessage.citations); // same sources and pages
    expect(hi.structured?.sources).toEqual(q1.assistantMessage.structured?.sources);
    expect(search.mock.calls.length).toBe(searchesBefore); // no new vector search

    const after = conversations.messages(q1.conversationId).map(toMessageDTO);
    expect(after).toHaveLength(before.length); // no new message
    expect(after[0]!.content).toBe("metformin reactions and missed dose?"); // question unchanged
    expect(after[3]).toEqual(before[3]); // the other response is untouched
    expect(after[3]!.id).toBe(q2.assistantMessage.id);
    expect(after[3]!.language).toBe("en");

    // The regeneration used the stored passages and the current answer as reference.
    const req = generate.mock.calls.at(-1)![0];
    expect(req.system).toContain("Response language: Hindi");
    expect(promptText(req)).toContain("Metformin reactions: diarrhea.");
    expect(promptText(req)).toContain("<reference_answer>");
    expect(promptText(req)).toContain("Question: metformin reactions and missed dose?");
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
    expect(gu.structured?.title).toBe("સામાન્ય પ્રતિક્રિયાઓ");
  });

  it("keeps the current answer when generation fails", async () => {
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

  it("works for messages saved before snapshots existed, using their stored citation excerpts", async () => {
    const { deps, db, generate } = await setup();
    const { assistantMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    db.prepare("UPDATE messages SET context_json = NULL, variants_json = NULL, language = NULL WHERE id = ?").run(assistantMessage.id);

    const hi = await setAnswerLanguage(deps, assistantMessage.id, "hi");
    expect(hi.language).toBe("hi");
    const prompt = promptText(generate.mock.calls.at(-1)![0]);
    expect(prompt).toContain("Question: metformin reactions?"); // recovered from the preceding user message
    expect(prompt).toContain(assistantMessage.citations[0]!.excerpt);
  });

  it("rejects unknown and user messages", async () => {
    const { deps } = await setup();
    const { userMessage } = await askInConversation(deps, { question: "metformin reactions?" });
    await expect(setAnswerLanguage(deps, "00000000-0000-4000-8000-000000000000", "hi")).rejects.toThrow(MessageNotFoundError);
    await expect(setAnswerLanguage(deps, userMessage.id, "hi")).rejects.toThrow(MessageNotFoundError);
  });
});
