import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { checkAttachment } from "@/lib/attachments";
import { IMAGE_UNSUPPORTED_MESSAGE, supportsImageInput } from "@/lib/capabilities";
import { ConversationRepository } from "@/server/db/repositories";
import { detectKind, extractDocument, sniffImage } from "@/server/knowledge/extract";
import { ingestDocument } from "@/server/knowledge/ingest";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { toAnthropicContent } from "@/server/llm/anthropic";
import { toLLMError } from "@/server/llm/errors";
import { toGeminiParts } from "@/server/llm/gemini";
import { toOpenAIContent } from "@/server/llm/openai";
import { ProviderConfigService } from "@/server/llm/resolve";
import type { ContentPart, LLMProvider, LLMRequest } from "@/server/llm/types";
import { answerQuestion, AnswerInputError } from "@/server/rag/answer";
import { AttachmentError, prepareAttachments, selectAttachmentSources } from "@/server/rag/attachments";
import { askInConversation } from "@/server/rag/chat";
import { FakeEmbedder, memoryDb, promptText, testConfig } from "./helpers";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

async function zip(files: Record<string, string>): Promise<Buffer> {
  const z = new JSZip();
  for (const [path, content] of Object.entries(files)) z.file(path, content);
  return z.generateAsync({ type: "nodebuffer" });
}

const xlsx = () =>
  zip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml":
      '<workbook xmlns:r="r"><sheets><sheet name="Doses &amp; Prices" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": "<sst><si><t>Drug</t></si><si><t>Dose</t></si><si><r><t>Metf</t></r><r><t>ormin</t></r></si></sst>",
    "xl/worksheets/sheet1.xml":
      '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>500</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Note &lt;daily&gt;</t></is></c></row></sheetData></worksheet>',
  });

const pptx = () =>
  zip({
    "ppt/presentation.xml": "<presentation/>",
    "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide10.xml": "<p:sld><a:p><a:r><a:t>Tenth</a:t></a:r></a:p></p:sld>",
    "ppt/slides/slide1.xml":
      "<p:sld><a:p><a:r><a:t>Metformin </a:t></a:r><a:r><a:t>overview</a:t></a:r></a:p><a:p><a:r><a:t>Take with food</a:t></a:r></a:p></p:sld>",
  });

// ── Detection & extraction ───────────────────────────────────────────────────

describe("file type detection", () => {
  it("sniffs images from bytes, not names", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(JPEG)).toBe("jpeg");
    expect(sniffImage(WEBP)).toBe("webp");
    expect(sniffImage(Buffer.from("just text"))).toBeNull();
  });

  it("accepts the new document types and rejects mismatched content", async () => {
    expect(detectKind("notes.md", Buffer.from("# Title"))).toBe("md");
    expect(detectKind("data.CSV", Buffer.from("a,b\n1,2"))).toBe("csv");
    expect(detectKind("book.xlsx", await xlsx())).toBe("xlsx");
    expect(() => detectKind("fake.xlsx", Buffer.from("not a zip"))).toThrow(/not a valid Excel workbook/);
    expect(() => detectKind("photo.png", PNG)).toThrow(/Images can't be added to the Knowledge Base/);
    // A PPTX renamed to .xlsx is a ZIP, but the extractor checks for the workbook part.
    await expect(extractDocument("renamed.xlsx", await pptx())).rejects.toThrow(/not a valid Excel workbook/);
  });

  it("extracts XLSX sheets with shared strings, inline strings, numbers and column gaps", async () => {
    const doc = await extractDocument("book.xlsx", await xlsx());
    expect(doc.kind).toBe("xlsx");
    expect(doc.pages[0]!.text).toBe("Sheet: Doses & Prices\nDrug | Dose\nMetformin | | 500\nNote <daily>");
  });

  it("extracts PPTX slides in numeric order with slide numbers", async () => {
    const doc = await extractDocument("deck.pptx", await pptx());
    expect(doc.pages.map((p) => [p.pageNumber, p.text])).toEqual([
      [1, "Metformin overview\nTake with food"],
      [2, "Second slide"],
      [10, "Tenth"],
    ]);
  });

  it("reads Markdown and CSV as text", async () => {
    expect((await extractDocument("a.md", Buffer.from("# Dose\n\n- 500 mg"))).mimeType).toBe("text/markdown");
    expect((await extractDocument("a.csv", Buffer.from("drug,dose\nmetformin,500"))).pages[0]!.text).toContain("metformin,500");
  });
});

describe("client-side attachment check", () => {
  it("gives clear messages for unsupported, empty and oversized files", () => {
    expect(checkAttachment({ name: "virus.exe", size: 10 })).toMatch(/unsupported file type/);
    expect(checkAttachment({ name: "a.png", size: 0 })).toMatch(/empty/);
    expect(checkAttachment({ name: "big.jpg", size: 6 * 1024 * 1024 })).toMatch(/max 5 MB for images/);
    expect(checkAttachment({ name: "ok.pdf", size: 1000 })).toBeNull();
  });
});

// ── Server-side preparation ──────────────────────────────────────────────────

describe("prepareAttachments", () => {
  it("validates by content, uses the sniffed image type, dedupes and keeps the KB flag", async () => {
    const out = await prepareAttachments([
      { name: "scan.jpg", buffer: PNG }, // wrong extension, real PNG → sent as image/png
      { name: "notes.txt", buffer: Buffer.from("Metformin is taken with meals."), addToKnowledgeBase: true },
      { name: "notes.txt", buffer: Buffer.from("Metformin is taken with meals.") }, // duplicate
    ]);
    expect(out.images).toEqual([expect.objectContaining({ name: "scan.jpg", mediaType: "image/png" })]);
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]).toMatchObject({ name: "notes.txt", addToKnowledgeBase: true });
    expect(out.meta.map((m) => [m.name, m.kind, m.mediaType])).toEqual([
      ["scan.jpg", "image", "image/png"],
      ["notes.txt", "document", "text/plain"],
    ]);
  });

  it.each([
    [[{ name: "fake.png", buffer: Buffer.from("hello") }], /not a valid PNG, JPG or WEBP/],
    [[{ name: "tool.exe", buffer: Buffer.from("MZ") }], /unsupported file type/],
    [[{ name: "broken.pdf", buffer: Buffer.from("nope") }], /broken\.pdf: .*not a valid PDF/],
    [Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, buffer: Buffer.from(`x${i}`) })), /up to 5 files/],
    [[{ name: "huge.png", buffer: Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]) }], /at most 5 MB/],
  ])("rejects invalid input %#", async (files, message) => {
    await expect(prepareAttachments(files)).rejects.toThrow(AttachmentError);
    await expect(prepareAttachments(files)).rejects.toThrow(message);
  });
});

describe("selectAttachmentSources", () => {
  const embedder = new FakeEmbedder(["warranty", "battery", "refund", "shipping"]);

  it("sends small attachments in full, without scores", async () => {
    const { documents } = await prepareAttachments([{ name: "a.txt", buffer: Buffer.from("Battery warranty is two years.") }]);
    const sources = await selectAttachmentSources(embedder, "anything", documents);
    expect(sources).toEqual([expect.objectContaining({ source: "attachment", documentId: null, filename: "a.txt", score: null })]);
  });

  it("narrows large attachments to the most relevant chunks, in document order", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Shipping paragraph ${i} ${"lorem ".repeat(80)}`);
    filler.splice(40, 0, "The battery warranty lasts 24 months from purchase.");
    const { documents } = await prepareAttachments([{ name: "big.txt", buffer: Buffer.from(filler.join("\n\n")) }]);
    const sources = await selectAttachmentSources(embedder, "battery warranty", documents);
    expect(sources.length).toBeLessThanOrEqual(8);
    expect(sources.some((s) => s.content.includes("battery warranty lasts 24 months"))).toBe(true);
    expect(sources.every((s) => typeof s.score === "number")).toBe(true);
  });
});

// ── Answering with attachments ───────────────────────────────────────────────

async function setup(model = "vision-model") {
  const db = memoryDb();
  const embedder = new FakeEmbedder(["refund", "policy", "days", "warranty", "battery", "months", "prescription"]);
  const vectorStore = new SqliteVectorStore(db);
  await ingestDocument(
    { db, embedder, vectorStore, chunkOptions: { chunkSize: 32, overlap: 0 } },
    { filename: "policy.txt", buffer: Buffer.from("Refund policy: 30 days.\n\nBattery warranty: 12 months.") },
  );
  const providerConfig = new ProviderConfigService(
    db,
    testConfig({ DEFAULT_AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test-key-123456789", OPENAI_MODEL: model }),
  );
  const generate = vi.fn(async (_req: LLMRequest) => ({ text: "From the image and the policy [1]." }));
  const provider: LLMProvider = { id: "openai", generate };
  const conversations = new ConversationRepository(db);
  const deps = { embedder, vectorStore, providerConfig, conversations, getProvider: () => provider, retrieval: { topK: 3, minScore: 0.2 } };
  return { db, deps, generate, conversations };
}

describe("answerQuestion with attachments", () => {
  it("sends an image as a real image part even when the knowledge base has nothing relevant", async () => {
    const { deps, generate } = await setup();
    const attachments = await prepareAttachments([{ name: "photo.png", buffer: PNG }]);
    const res = await answerQuestion(deps, { question: "What does this image show?", provider: "openai", attachments });

    const req = generate.mock.calls[0]![0];
    expect(req.content[0]).toMatchObject({ type: "image", mediaType: "image/png", name: "photo.png" });
    expect((req.content[0] as Extract<ContentPart, { type: "image" }>).data.equals(PNG)).toBe(true);
    expect(promptText(req)).toContain("Attached image: photo.png");
    expect(res.noContext).toBe(false);
  });

  it("combines knowledge-base chunks with the image (KB + image question)", async () => {
    const { deps, generate } = await setup();
    const attachments = await prepareAttachments([{ name: "prescription.jpg", buffer: JPEG }]);
    const res = await answerQuestion(deps, { question: "Check the battery warranty against this prescription", provider: "openai", attachments });
    const req = generate.mock.calls[0]![0];
    expect(req.content.map((p) => p.type)).toEqual(["image", "text"]);
    expect(promptText(req)).toContain("Battery warranty: 12 months.");
    expect(res.citations[0]).toMatchObject({ source: "knowledge_base", filename: "policy.txt" });
  });

  it("numbers attached-document passages as sources with attachment citations", async () => {
    const { deps, generate } = await setup();
    const attachments = await prepareAttachments([{ name: "leaflet.md", buffer: Buffer.from("# Leaflet\n\nTake one tablet daily.") }]);
    const res = await answerQuestion(deps, { question: "How often?", provider: "openai", attachments });
    expect(promptText(generate.mock.calls[0]![0])).toContain('document="leaflet.md" origin="attached to this message"');
    expect(res.citations[0]).toMatchObject({ index: 1, source: "attachment", documentId: null, filename: "leaflet.md", cited: true });
  });

  it("refuses images for a text-only model with the exact message, before calling the provider", async () => {
    const { deps, generate } = await setup("gpt-3.5-turbo");
    const attachments = await prepareAttachments([{ name: "photo.png", buffer: PNG }]);
    await expect(answerQuestion(deps, { question: "What is this?", provider: "openai", attachments })).rejects.toThrow(
      new AnswerInputError(IMAGE_UNSUPPORTED_MESSAGE),
    );
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("askInConversation with attachments", () => {
  it("uses a default question for attachment-only messages and stores attachment metadata (not contents)", async () => {
    const { deps, conversations, db } = await setup();
    const attachments = await prepareAttachments([{ name: "photo.webp", buffer: WEBP }]);
    const res = await askInConversation(deps, { question: "  ", attachments });

    expect(res.userMessage).toMatchObject({ content: "Describe the attached image." });
    expect(res.userMessage.attachments).toEqual([{ name: "photo.webp", kind: "image", mediaType: "image/webp", sizeBytes: WEBP.length }]);
    expect(conversations.messages(res.conversationId)[0]!.attachments_json).not.toContain("UklGR"); // no base64 bytes
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 1 }); // nothing added to the KB
  });

  it("adds a document to the knowledge base only when the user opted in", async () => {
    const { deps } = await setup();
    const addToKnowledgeBase = vi.fn(async () => ({ documentId: "doc-1", status: "ready" as const, error: null }));
    const attachments = await prepareAttachments([
      { name: "keep.txt", buffer: Buffer.from("Keep me"), addToKnowledgeBase: true },
      { name: "temp.txt", buffer: Buffer.from("Temporary") },
    ]);
    const res = await askInConversation({ ...deps, addToKnowledgeBase }, { question: "Summarize", attachments });

    expect(addToKnowledgeBase).toHaveBeenCalledOnce();
    expect(addToKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({ filename: "keep.txt" }));
    expect(res.userMessage.attachments.find((a) => a.name === "keep.txt")).toMatchObject({ knowledgeBaseDocumentId: "doc-1" });
    expect(res.userMessage.attachments.find((a) => a.name === "temp.txt")?.knowledgeBaseDocumentId).toBeUndefined();
  });

  it("does not add to the knowledge base when answering fails", async () => {
    const { deps, generate } = await setup();
    generate.mockRejectedValueOnce(new Error("boom"));
    const addToKnowledgeBase = vi.fn();
    const attachments = await prepareAttachments([{ name: "keep.txt", buffer: Buffer.from("Keep"), addToKnowledgeBase: true }]);
    await expect(askInConversation({ ...deps, addToKnowledgeBase }, { question: "Hi", attachments })).rejects.toThrow("boom");
    expect(addToKnowledgeBase).not.toHaveBeenCalled();
  });
});

// ── Provider adapters & capabilities ─────────────────────────────────────────

describe("provider adapters convert neutral content", () => {
  const content: ContentPart[] = [
    { type: "text", text: "What is this?" },
    { type: "image", mediaType: "image/png", data: PNG, name: "a.png" },
  ];
  const b64 = PNG.toString("base64");

  it("OpenAI: input_image data URL first, then input_text", () => {
    expect(toOpenAIContent(content)).toEqual([
      { type: "input_image", detail: "auto", image_url: `data:image/png;base64,${b64}` },
      { type: "input_text", text: "What is this?" },
    ]);
  });

  it("Anthropic: base64 image block first, then text", () => {
    expect(toAnthropicContent(content)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: "What is this?" },
    ]);
  });

  it("Gemini: inlineData part first, then text", () => {
    expect(toGeminiParts(content)).toEqual([{ inlineData: { mimeType: "image/png", data: b64 } }, { text: "What is this?" }]);
  });
});

describe("image capability and errors", () => {
  it("knows common text-only models", () => {
    expect(supportsImageInput("openai", "gpt-5.4-mini")).toBe(true);
    expect(supportsImageInput("openai", "gpt-4o")).toBe(true);
    expect(supportsImageInput("openai", "gpt-3.5-turbo")).toBe(false);
    expect(supportsImageInput("openai", "o3-mini")).toBe(false);
    expect(supportsImageInput("anthropic", "claude-2.1")).toBe(false);
    expect(supportsImageInput("anthropic", "claude-sonnet-5")).toBe(true);
    expect(supportsImageInput("gemini", "gemini-2.5-flash")).toBe(true);
    expect(supportsImageInput("gemini", "gemini-2.5-flash-preview-tts")).toBe(false);
    expect(supportsImageInput("gemini", null)).toBe(false);
  });

  it("maps a provider's 'image not supported' error and user cancellation", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const err = Object.assign(new Error("Invalid content: image input is not supported by this model"), { status: 400 });
    expect(toLLMError(err, "openai", "m", "k")).toMatchObject({ kind: "image_unsupported", message: IMAGE_UNSUPPORTED_MESSAGE });

    const controller = new AbortController();
    controller.abort();
    expect(toLLMError(new Error("aborted"), "gemini", "m", "k", controller.signal).kind).toBe("cancelled");
  });
});
