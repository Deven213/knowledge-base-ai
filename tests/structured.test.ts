import { describe, expect, it, vi } from "vitest";
import { parseAIResponse } from "@/lib/ai-response";
import { getLanguage, LANGUAGES } from "@/lib/languages";
import type { CitationDTO } from "@/lib/types";
import { ConversationRepository, DocumentRepository } from "@/server/db/repositories";
import { toMessageDTO } from "@/server/dto";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { LLMProvider, LLMRequest } from "@/server/llm/types";
import { answerQuestion, NO_CONTEXT_ANSWER } from "@/server/rag/answer";
import { askInConversation } from "@/server/rag/chat";
import { buildSystemPrompt } from "@/server/rag/prompt";
import { needsEnglishSearchQuery } from "@/server/rag/query-translation";
import { buildSources, normalizeModelAnswer, parseModelJson, RESPONSE_FORMAT, structuredToText } from "@/server/rag/structured";
import { FakeEmbedder, memoryDb, TEST_ORG, testConfig, testUserId } from "./helpers";

const citation = (over: Partial<CitationDTO>): CitationDTO => ({
  index: 1,
  source: "knowledge_base",
  documentId: "d1",
  filename: "Metformin.pdf",
  pageStart: 6,
  pageEnd: 6,
  excerpt: "excerpt",
  score: 0.7,
  cited: true,
  ...over,
});

describe("parseModelJson", () => {
  it("reads plain JSON, fenced JSON and JSON surrounded by text", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseModelJson('Here you go: {"a":3} thanks')).toEqual({ a: 3 });
    expect(parseModelJson("not json at all")).toBeNull();
  });
});

describe("normalizeModelAnswer", () => {
  it("normalizes a schema-shaped answer: empty strings dropped, callout 'none' removed, citations bounded", () => {
    const out = normalizeModelAnswer(
      {
        found: true,
        title: "  Common reactions ",
        summary: "",
        sections: [
          { title: "Reactions", content: "", bullets: ["Diarrhea [1]", " ", "Nausea"], callout: { type: "none", text: "" }, citations: [1, 9, "2", 1] },
          { title: "Take with food", content: "Reduces GI upset.", bullets: [], callout: { type: "IMPORTANT", text: "Take with meals." }, citations: [] },
          { title: "", content: "dropped: no title", bullets: [], callout: { type: "none", text: "" }, citations: [] },
        ],
      },
      3,
      "not found",
    );
    expect(out).toEqual({
      found: true,
      title: "Common reactions",
      summary: undefined,
      sections: [
        { title: "Reactions", content: undefined, bullets: ["Diarrhea [1]", "Nausea"], callout: undefined, citations: [1, 2] },
        { title: "Take with food", content: "Reduces GI upset.", bullets: undefined, callout: { type: "important", text: "Take with meals." }, citations: undefined },
      ],
    });
  });

  it("supports any number of sections (1 or 7) without forcing a template", () => {
    const make = (n: number) => ({ found: true, title: "T", summary: "", sections: Array.from({ length: n }, (_, i) => ({ title: `S${i + 1}`, content: "x", bullets: [], callout: { type: "none", text: "" }, citations: [] })) });
    expect(normalizeModelAnswer(make(1), 1, "nf")!.sections).toHaveLength(1);
    expect(normalizeModelAnswer(make(7), 1, "nf")!.sections.map((s) => s.title)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7"]);
  });

  it("turns found=false into a section-less 'not found' answer (no invented content)", () => {
    const out = normalizeModelAnswer({ found: false, title: "", summary: "", sections: [{ title: "Made up", content: "x" }] }, 2, "मुझे यह जानकारी नहीं मिली।");
    expect(out).toEqual({ found: false, title: undefined, summary: "मुझे यह जानकारी नहीं मिली।", sections: [] });
  });

  it("rejects unusable output so the caller falls back to plain text", () => {
    expect(normalizeModelAnswer(null, 1, "nf")).toBeNull();
    expect(normalizeModelAnswer({ sections: "nope" }, 1, "nf")).toBeNull();
    expect(normalizeModelAnswer({ found: true, title: "Only a title", summary: "", sections: [] }, 1, "nf")).toBeNull();
  });
});

describe("structuredToText and buildSources", () => {
  it("renders readable text that still carries the [n] markers used to mark citations as cited", () => {
    const text = structuredToText({ found: true, title: "T", summary: "S", sections: [{ title: "A", bullets: ["b"], callout: { type: "warning", text: "w" }, citations: [2] }] });
    expect(text).toBe("T\n\nS\n\n1. A\n- b\nWARNING: w\nSources: [2]");
  });

  it("builds deduplicated source cards from cited citations only", () => {
    const sources = buildSources([
      citation({ index: 1, pageStart: 6, pageEnd: 7 }),
      citation({ index: 2, pageStart: 6, pageEnd: 7 }), // same document + pages → merged
      citation({ index: 3, pageStart: 13, pageEnd: 13, cited: false }), // not cited → omitted
      citation({ index: 4, source: "attachment", documentId: null, filename: "note.txt", pageStart: null, pageEnd: null }),
    ]);
    expect(sources.map((s) => [s.documentName, s.pageStart, s.pageEnd, s.citationIndexes, s.origin])).toEqual([
      ["Metformin.pdf", 6, 7, [1, 2], "knowledge_base"],
      ["note.txt", null, null, [4], "attachment"],
    ]);
  });
});

describe("languages and prompts", () => {
  it("has English, Hindi and Gujarati with a not-found message each", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", "hi", "gu"]);
    expect(getLanguage("xx").code).toBe("en");
    expect(NO_CONTEXT_ANSWER).toBe("I couldn't find this information in the available documents.");
  });

  it("adds the language instruction only for non-English, keeping citations unchanged", () => {
    expect(buildSystemPrompt({ structured: true, languageName: "English" })).not.toContain("Response language");
    const hi = buildSystemPrompt({ structured: true, languageName: getLanguage("hi").promptName });
    expect(hi).toContain("Response language: Hindi");
    expect(hi).toContain("Keep document names, page numbers, source numbers and [n] markers exactly");
    expect(hi).toContain("Answer using ONLY the numbered sources"); // grounding rules unchanged
    expect(hi).toContain("never write HTML");
  });

  it("detects questions that need an English search query", () => {
    expect(needsEnglishSearchQuery("What are the side effects of metformin?")).toBe(false);
    expect(needsEnglishSearchQuery("मेटफॉर्मिन के दुष्प्रभाव क्या हैं?")).toBe(true);
    expect(needsEnglishSearchQuery("મેટફોર્મિનની આડઅસરો શું છે?")).toBe(true);
    expect(needsEnglishSearchQuery("metformin क्या है")).toBe(true);
    expect(needsEnglishSearchQuery("123 ?")).toBe(false);
  });

  it("keeps the provider schema portable (all properties required, no extra keys)", () => {
    const schema = RESPONSE_FORMAT.schema as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
    expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort());
    expect(JSON.stringify(schema)).not.toMatch(/"null"|anyOf|oneOf/);
  });
});

// ── End-to-end through answerQuestion / chat history ────────────────────────

async function setup(reply: (req: LLMRequest) => string) {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["metformin", "reactions", "diarrhea", "nausea", "dose"]);
  const vectorStore = new SqliteVectorStore(db, TEST_ORG);
  await ingestDocument(
    { db, embedder, vectorStore, documents: new DocumentRepository(db, TEST_ORG), chunkOptions: { chunkSize: 60, overlap: 0 } },
    { filename: "Metformin.pdf.txt", buffer: Buffer.from("Metformin reactions: diarrhea and nausea.\n\nMissed dose: take it when remembered.") },
  );
  const providerConfig = new ProviderConfigService(db, testConfig({ GEMINI_API_KEY: "AIza-test-key-12345678", GEMINI_MODEL: "g", DEFAULT_AI_PROVIDER: "gemini" }));
  const generate = vi.fn(async (req: LLMRequest) => ({ text: reply(req) }));
  const provider: LLMProvider = { id: "gemini", generate };
  const conversations = new ConversationRepository(db, TEST_ORG, testUserId(db));
  const deps = { embedder, vectorStore, providerConfig, conversations, getProvider: () => provider, retrieval: { topK: 3, minScore: 0.2 } };
  return { deps, generate, conversations };
}

const structuredReply = JSON.stringify({
  found: true,
  title: "सामान्य दुष्प्रभाव",
  summary: "",
  sections: [{ title: "दुष्प्रभाव", content: "", bullets: ["दस्त", "मतली"], callout: { type: "none", text: "" }, citations: [1] }],
});

describe("structured answers end to end", () => {
  it("requests the schema, passes the language, and returns a validated structured answer", async () => {
    const { deps, generate } = await setup(() => structuredReply);
    const res = await answerQuestion(deps, { question: "metformin reactions?", provider: "gemini", language: "hi" });

    const req = generate.mock.calls[0]![0];
    expect(req.responseFormat?.name).toBe("knowledge_base_answer");
    expect(req.system).toContain("Response language: Hindi");
    expect(res.structured).toMatchObject({ found: true, language: "hi", title: "सामान्य दुष्प्रभाव" });
    expect(res.structured!.sections[0]!.bullets).toEqual(["दस्त", "मतली"]);
    expect(res.structured!.sources[0]).toMatchObject({ documentName: "Metformin.pdf.txt", citationIndexes: [1] });
    expect(res.citations[0]!.cited).toBe(true);
  });

  it("falls back to plain text when the model output isn't valid structured JSON", async () => {
    const { deps } = await setup(() => "Diarrhea and nausea [1].");
    const res = await answerQuestion(deps, { question: "metformin reactions?", provider: "gemini" });
    expect(res.structured).toBeNull();
    expect(res.answer).toBe("Diarrhea and nausea [1].");
    expect(res.citations[0]!.cited).toBe(true);
  });

  it("uses the language's not-found message without calling the model when nothing is retrieved", async () => {
    const { deps, generate } = await setup(() => structuredReply);
    const res = await answerQuestion(deps, { question: "stock prices?", provider: "gemini", language: "gu" });
    expect(generate).not.toHaveBeenCalled();
    expect(res.structured).toMatchObject({ found: false, summary: getLanguage("gu").notFound, sections: [] });
  });

  it("stores the structured answer and returns it from history without regenerating", async () => {
    const { deps, generate, conversations } = await setup(() => structuredReply);
    const res = await askInConversation(deps, { question: "metformin reactions?", language: "hi" });
    expect(res.assistantMessage.structured?.title).toBe("सामान्य दुष्प्रभाव");

    const reloaded = conversations.messages(res.conversationId).map(toMessageDTO)[1]!;
    expect(reloaded.structured).toEqual(res.assistantMessage.structured);
    expect(parseAIResponse(reloaded.structured)).not.toBeNull();
    expect(generate).toHaveBeenCalledOnce();
  });

  it("translates a non-Latin question into an English search query for retrieval only", async () => {
    const { deps, generate } = await setup((req) => (req.responseFormat ? structuredReply : "metformin reactions"));
    const res = await answerQuestion(deps, { question: "मेटफॉर्मिन के दुष्प्रभाव?", provider: "gemini", language: "hi" });
    expect(generate).toHaveBeenCalledTimes(2); // 1) search query, 2) answer
    expect(generate.mock.calls[0]![0].responseFormat).toBeUndefined();
    const answerPrompt = (generate.mock.calls[1]![0].content[0] as { text: string }).text;
    expect(answerPrompt).toContain("Question: मेटफॉर्मिन के दुष्प्रभाव?"); // the model sees the original question
    expect(answerPrompt).toContain("Metformin reactions: diarrhea and nausea."); // English chunk was retrieved
    expect(res.noContext).toBe(false);
  });
});
