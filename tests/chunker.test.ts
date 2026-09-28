import { describe, expect, it } from "vitest";
import { chunkPages } from "@/server/knowledge/chunker";

const sentence = (i: number) => `This is sentence number ${i} about the topic.`;

describe("chunkPages", () => {
  it("returns a single chunk for short text", () => {
    const chunks = chunkPages([{ pageNumber: 1, text: "Hello world." }]);
    expect(chunks).toEqual([{ index: 0, content: "Hello world.", pageStart: 1, pageEnd: 1 }]);
  });

  it("never exceeds the chunk size and keeps every sentence", () => {
    const text = Array.from({ length: 200 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkPages([{ pageNumber: 1, text }], { chunkSize: 300, overlap: 60 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(300);
    const all = chunks.map((c) => c.content).join(" ");
    for (let i = 0; i < 200; i++) expect(all).toContain(sentence(i));
  });

  it("overlaps consecutive chunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkPages([{ pageNumber: 1, text }], { chunkSize: 200, overlap: 80 });
    for (let i = 1; i < chunks.length; i++) {
      const prevLastSentence = chunks[i - 1]!.content.split(/(?<=\.)\s/).at(-1)!;
      expect(chunks[i]!.content.startsWith(prevLastSentence)).toBe(true);
    }
  });

  it("prefers paragraph boundaries", () => {
    const p1 = "A".repeat(40) + ".";
    const p2 = "B".repeat(40) + ".";
    const chunks = chunkPages([{ pageNumber: null, text: `${p1}\n\n${p2}` }], { chunkSize: 60, overlap: 0 });
    expect(chunks.map((c) => c.content)).toEqual([p1, p2]);
  });

  it("tracks page ranges across pages", () => {
    const chunks = chunkPages(
      [
        { pageNumber: 1, text: "Short page one." },
        { pageNumber: 2, text: "Short page two." },
        { pageNumber: 3, text: "C".repeat(90) },
      ],
      { chunkSize: 100, overlap: 0 },
    );
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
    expect(chunks[1]).toMatchObject({ pageStart: 3, pageEnd: 3 });
  });

  it("hard-splits a single oversized token", () => {
    const chunks = chunkPages([{ pageNumber: null, text: "x".repeat(250) }], { chunkSize: 100, overlap: 0 });
    expect(chunks.map((c) => c.content.length)).toEqual([100, 100, 50]);
    expect(chunks[0]!.pageStart).toBeNull();
  });

  it("ignores empty pages and rejects invalid options", () => {
    expect(chunkPages([{ pageNumber: 1, text: "   " }])).toEqual([]);
    expect(() => chunkPages([], { chunkSize: 100, overlap: 100 })).toThrow();
  });
});
