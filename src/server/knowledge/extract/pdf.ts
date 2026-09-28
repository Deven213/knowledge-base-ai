import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import { normalizeText } from "./normalize";
import { ExtractionError, type ExtractedDocument } from "./types";

export async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  let pageTexts: string[];
  let totalPages: number;
  try {
    // pdf.js may detach the buffer it is given, so hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    try {
      const result = await extractText(pdf, { mergePages: false });
      pageTexts = result.text;
      totalPages = result.totalPages;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (err) {
    const reason = err instanceof Error && /password/i.test(err.message) ? " It is password-protected." : "";
    throw new ExtractionError(`Could not read this PDF.${reason}`);
  }

  const pages = pageTexts
    .map((text, i) => ({ pageNumber: i + 1, text: normalizeText(text) }))
    .filter((p) => p.text.length > 0);

  if (pages.length === 0) {
    throw new ExtractionError(
      "No selectable text found in this PDF. It is probably a scanned image; OCR is not supported yet.",
    );
  }

  return { kind: "pdf", mimeType: "application/pdf", pageCount: totalPages, pages };
}
