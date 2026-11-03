import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "@/server/config";
import { extractDocument, ExtractionError } from "@/server/knowledge/extract";
import { setOcrEngineForTests, type OcrEngine } from "@/server/knowledge/extract/ocr";

/** A minimal valid PDF: one 300x300 page per entry, with a text layer when the entry is a string and none when null. */
function makePdf(pages: (string | null)[]): Buffer {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((text, i) => {
    const pageId = 4 + i * 2;
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    const stream = text ? `BT /F1 14 Tf 20 150 Td (${text}) Tj ET` : "";
    objs[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  out += offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const isPng = (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

/** Fake recognizer: records the images it is given and answers "scanned page N" for the Nth image. */
function fakeEngine(opts: { fail?: boolean; blank?: boolean } = {}) {
  const images: Buffer[] = [];
  const engine: OcrEngine = {
    concurrency: 2,
    async recognize(png) {
      images.push(png);
      if (opts.fail) throw new Error("engine down");
      return opts.blank ? "  \n " : `scanned page ${images.length}`;
    },
  };
  return { engine, images };
}

describe("OCR for scanned PDFs", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    setOcrEngineForTests(null);
    delete process.env.OCR_ENABLED;
    delete process.env.OCR_MAX_PAGES;
    resetConfigForTests();
    vi.restoreAllMocks();
  });

  it("reads every page of a fully scanned PDF and keeps page numbers", async () => {
    const { engine, images } = fakeEngine();
    setOcrEngineForTests(engine);

    const doc = await extractDocument("scan.pdf", makePdf([null, null, null]));

    expect(doc.pageCount).toBe(3);
    expect(doc.pages.map((p) => [p.pageNumber, p.text])).toEqual([
      [1, "scanned page 1"],
      [2, "scanned page 2"],
      [3, "scanned page 3"],
    ]);
    expect(images).toHaveLength(3);
    expect(images.every(isPng)).toBe(true);
    // The first page render loads the native canvas module and fonts, which can pass vitest's 5 s default
    // when the whole suite runs in parallel.
  }, 30_000);

  it("only OCRs the pages that have no text layer", async () => {
    const { engine, images } = fakeEngine();
    setOcrEngineForTests(engine);

    const doc = await extractDocument("mixed.pdf", makePdf(["First page text", null, "Third page text"]));

    expect(images).toHaveLength(1);
    expect(doc.pages.map((p) => [p.pageNumber, p.text])).toEqual([
      [1, "First page text"],
      [2, "scanned page 1"],
      [3, "Third page text"],
    ]);
  });

  it("does not touch OCR for a PDF that already has text on every page", async () => {
    const { engine, images } = fakeEngine();
    setOcrEngineForTests(engine);
    const doc = await extractDocument("text.pdf", makePdf(["Alpha", "Beta"]));
    expect(images).toHaveLength(0);
    expect(doc.pages.map((p) => p.text)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps the text of a mostly-text PDF when OCR fails on its image-only pages", async () => {
    setOcrEngineForTests(fakeEngine({ fail: true }).engine);
    const doc = await extractDocument("mostly-text.pdf", makePdf(["One", "Two", null]));
    expect(doc.pages.map((p) => p.text)).toEqual(["One", "Two"]);
  });

  it("rejects a scanned PDF with a clear message when OCR fails", async () => {
    setOcrEngineForTests(fakeEngine({ fail: true }).engine);
    await expect(extractDocument("scan.pdf", makePdf([null, null]))).rejects.toThrow(/scanned image and OCR failed/);
  });

  it("rejects a scan that OCR can't read anything from", async () => {
    setOcrEngineForTests(fakeEngine({ blank: true }).engine);
    await expect(extractDocument("blank.pdf", makePdf([null]))).rejects.toThrow(/even with OCR/);
  });

  it("refuses a scan longer than OCR_MAX_PAGES instead of running for hours", async () => {
    process.env.OCR_MAX_PAGES = "2";
    resetConfigForTests();
    const { engine, images } = fakeEngine();
    setOcrEngineForTests(engine);

    const err = await extractDocument("long-scan.pdf", makePdf([null, null, null])).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExtractionError);
    expect((err as Error).message).toMatch(/3 pages.*limited to 2 pages/);
    expect(images).toHaveLength(0);
  });

  it("gives the old 'scanned image' rejection when OCR is turned off", async () => {
    process.env.OCR_ENABLED = "false";
    resetConfigForTests();
    const { engine, images } = fakeEngine();
    setOcrEngineForTests(engine);

    await expect(extractDocument("scan.pdf", makePdf([null]))).rejects.toThrow(/OCR is turned off/);
    expect(images).toHaveLength(0);
  });
});
