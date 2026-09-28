import "server-only";
import { normalizeText } from "./normalize";
import { openOoxml, readPart, textRuns } from "./ooxml";
import { ExtractionError, type ExtractedDocument, type ExtractedPage } from "./types";

/** PowerPoint deck → one text block per slide; slide numbers are used like page numbers in citations. */
export async function extractPptx(buffer: Buffer): Promise<ExtractedDocument> {
  const zip = await openOoxml(buffer, "ppt/presentation.xml", "PowerPoint presentation");

  const slides = Object.keys(zip.files)
    .map((path) => ({ path, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(path)?.[1]) }))
    .filter((s) => Number.isInteger(s.n) && s.n > 0)
    .sort((a, b) => a.n - b.n);

  const pages: ExtractedPage[] = [];
  for (const { path, n } of slides) {
    const xml = (await readPart(zip, path)) ?? "";
    // Each <a:p> is a paragraph; its <a:t> runs are the text.
    const paragraphs = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => textRuns(p[1]!, "a:t").trim());
    const text = normalizeText(paragraphs.filter(Boolean).join("\n"));
    if (text) pages.push({ pageNumber: n, text });
  }

  if (pages.length === 0) throw new ExtractionError("This PowerPoint presentation contains no text.");
  return {
    kind: "pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    pageCount: slides.length,
    pages,
  };
}
