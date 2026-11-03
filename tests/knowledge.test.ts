import { describe, expect, it } from "vitest";
import { DocumentRepository } from "@/server/db/repositories";
import { detectKind, extractDocument, ExtractionError } from "@/server/knowledge/extract";
import { normalizeText } from "@/server/knowledge/extract/normalize";
import { ingestDocument } from "@/server/knowledge/ingest";
import { retrieveContext } from "@/server/knowledge/retrieve";
import { SqliteVectorStore } from "@/server/knowledge/vector-store";
import { FakeEmbedder, memoryDb, TEST_ORG } from "./helpers";

const VOCAB = ["refund", "policy", "days", "shipping", "international", "warranty", "battery", "months"];

const DOC_TEXT = [
  "Refund policy: customers may request a refund within 30 days.",
  "Shipping: international shipping takes 10 business days.",
  "Warranty: the battery warranty lasts 12 months.",
].join("\n\n");

function setup() {
  const db = memoryDb();
  const embedder = new FakeEmbedder(VOCAB);
  const vectorStore = new SqliteVectorStore(db, TEST_ORG);
  const deps = { db, embedder, vectorStore, documents: new DocumentRepository(db, TEST_ORG), chunkOptions: { chunkSize: 80, overlap: 0 } };
  return { db, embedder, vectorStore, documents: new DocumentRepository(db, TEST_ORG), deps, docs: new DocumentRepository(db, TEST_ORG) };
}

describe("extraction", () => {
  it("detects types by extension and verifies magic bytes", () => {
    expect(detectKind("a.pdf", Buffer.from("%PDF-1.7\n"))).toBe("pdf");
    expect(detectKind("a.DOCX", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe("docx");
    expect(detectKind("a.txt", Buffer.from("hello"))).toBe("txt");
    expect(() => detectKind("a.pdf", Buffer.from("not a pdf"))).toThrow(ExtractionError);
    expect(() => detectKind("a.docx", Buffer.from("plain text"))).toThrow(ExtractionError);
    expect(() => detectKind("a.txt", Buffer.from([0x68, 0x00, 0x69]))).toThrow(/binary/);
    expect(() => detectKind("a.exe", Buffer.from("MZ"))).toThrow(/Unsupported/);
  });

  it("extracts TXT, falling back to Windows-1252 for non-UTF-8 bytes", async () => {
    const doc = await extractDocument("a.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in cp1252
    expect(doc.pages[0]!.text).toBe("café");
    await expect(extractDocument("a.txt", Buffer.from("  \n "))).rejects.toThrow(/empty/);
  });

  it("normalises whitespace but keeps paragraphs", () => {
    expect(normalizeText("﻿a  b\r\n\r\n\r\n\r\nc\u0000 hyphen-\nated")).toBe("a b\n\nc hyphenated");
  });
});

describe("ingest + retrieve", () => {
  it("indexes a document and retrieves the most relevant chunk first", async () => {
    const { deps, docs } = setup();
    const result = await ingestDocument(deps, { filename: "policy.txt", buffer: Buffer.from(DOC_TEXT) });
    expect(result.status).toBe("ready");

    const row = docs.get(result.documentId)!;
    expect(row).toMatchObject({ status: "ready", chunk_count: 3, mime_type: "text/plain", embedding_models: "test-embedder" });

    const hits = await retrieveContext(deps, "How long is the battery warranty?", { topK: 2, minScore: 0.1 });
    expect(hits[0]!.content).toContain("battery warranty");
    expect(hits[0]!.filename).toBe("policy.txt");
    expect(hits.every((h) => h.score >= 0.1)).toBe(true);
  });

  it("records extraction failures on the document without throwing", async () => {
    const { deps, docs } = setup();
    const result = await ingestDocument(deps, { filename: "fake.pdf", buffer: Buffer.from("nope") });
    expect(result).toMatchObject({ status: "failed" });
    expect(docs.get(result.documentId)).toMatchObject({ status: "failed", chunk_count: 0 });
  });

  it("filters by document, score threshold and embedding model", async () => {
    const { deps, embedder } = setup();
    const a = await ingestDocument(deps, { filename: "a.txt", buffer: Buffer.from("Refund policy is 30 days.") });
    const b = await ingestDocument(deps, { filename: "b.txt", buffer: Buffer.from("Refund policy is 60 days.") });

    const onlyB = await retrieveContext(deps, "refund policy", { topK: 5, minScore: 0, documentIds: [b.documentId] });
    expect(onlyB.map((h) => h.documentId)).toEqual([b.documentId]);

    const none = await retrieveContext(deps, "shipping international", { topK: 5, minScore: 0.5 });
    expect(none).toEqual([]);

    // Vectors from another model are never compared.
    const otherModel = { ...deps, embedder: new FakeEmbedder(VOCAB, "other-model") };
    expect(await retrieveContext(otherModel, "refund", { topK: 5, minScore: 0 })).toEqual([]);
    expect(embedder.modelId).toBe("test-embedder");
    expect(a.status).toBe("ready");
  });

  it("deleting a document removes its chunks", async () => {
    const { deps, docs, db } = setup();
    const r = await ingestDocument(deps, { filename: "a.txt", buffer: Buffer.from(DOC_TEXT) });
    expect(docs.delete(r.documentId)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 0 });
  });
});
