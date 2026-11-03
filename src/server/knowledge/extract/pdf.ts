import "server-only";
import { extractText, getDocumentProxy } from "unpdf";
import { getConfig } from "@/server/config";
import { normalizeText } from "./normalize";
import { ocrPdfPages, type PdfProxy } from "./ocr";
import { ExtractionError, type ExtractedDocument, type ExtractedPage } from "./types";

function readError(err: unknown): ExtractionError {
  const reason = err instanceof Error && /password/i.test(err.message) ? " It is password-protected." : "";
  return new ExtractionError(`Could not read this PDF.${reason}`);
}

/**
 * Text from the PDF's own text layer; pages that have none (scans, photographed pages) are read
 * with local OCR. A document that is mostly text keeps its text if OCR can't run for its few image pages.
 */
export async function extractPdf(buffer: Buffer): Promise<ExtractedDocument> {
  let pdf: PdfProxy;
  try {
    // pdf.js may detach the buffer it is given, so hand it a copy.
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    throw readError(err);
  }

  try {
    let pageTexts: string[];
    let totalPages: number;
    try {
      const result = await extractText(pdf, { mergePages: false });
      pageTexts = result.text;
      totalPages = result.totalPages;
    } catch (err) {
      throw readError(err);
    }

    const pages: ExtractedPage[] = pageTexts.map((text, i) => ({ pageNumber: i + 1, text: normalizeText(text) }));
    const withoutText = pages.filter((p) => p.text.length === 0).map((p) => p.pageNumber as number);
    const mostlyText = pages.length - withoutText.length >= pages.length / 2;

    if (withoutText.length > 0) {
      const ocrText = await ocrMissingPages(pdf, withoutText, mostlyText);
      for (const page of pages) {
        const text = ocrText.get(page.pageNumber as number);
        if (text) page.text = text;
      }
    }

    const readable = pages.filter((p) => p.text.length > 0);
    if (readable.length === 0) {
      throw new ExtractionError(
        getConfig().OCR_ENABLED
          ? "No text could be read from this PDF, even with OCR. It may be blank, handwritten or too low quality."
          : "No selectable text found in this PDF. It is probably a scanned image, and OCR is turned off (OCR_ENABLED=false).",
      );
    }
    return { kind: "pdf", mimeType: "application/pdf", pageCount: totalPages, pages: readable };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** Page number → OCR text for pages that have no text layer. Empty when OCR is off or was skipped. */
async function ocrMissingPages(pdf: PdfProxy, pageNumbers: number[], mostlyText: boolean): Promise<Map<number, string>> {
  const config = getConfig();
  if (!config.OCR_ENABLED) return new Map();

  if (pageNumbers.length > config.OCR_MAX_PAGES) {
    // A mostly-text document just goes without its image-only pages; a scan has nothing else to offer.
    if (mostlyText) return new Map();
    throw new ExtractionError(
      `This PDF is a scanned document with ${pageNumbers.length} pages. OCR is limited to ${config.OCR_MAX_PAGES} pages per document (OCR_MAX_PAGES); split the file into smaller parts.`,
    );
  }

  const started = Date.now();
  try {
    const text = new Map<number, string>();
    for (const [pageNumber, raw] of await ocrPdfPages(pdf, pageNumbers)) {
      const cleaned = normalizeText(raw);
      if (cleaned) text.set(pageNumber, cleaned);
    }
    console.info(`[ocr] read ${text.size} of ${pageNumbers.length} page(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return text;
  } catch (err) {
    console.error("[ocr] failed", err instanceof Error ? `${err.name}: ${err.message}` : err);
    if (mostlyText) return new Map();
    throw new ExtractionError("This PDF is a scanned image and OCR failed. Check the server logs for the reason.");
  }
}
