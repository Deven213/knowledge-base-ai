import "server-only";
import mammoth from "mammoth";
import { normalizeText } from "./normalize";
import { ExtractionError, type ExtractedDocument } from "./types";

export async function extractDocx(buffer: Buffer): Promise<ExtractedDocument> {
  let raw: string;
  try {
    raw = (await mammoth.extractRawText({ buffer })).value;
  } catch {
    throw new ExtractionError("Could not read this DOCX file. It may be corrupted or not a Word document.");
  }

  const text = normalizeText(raw);
  if (!text) throw new ExtractionError("This DOCX file contains no text.");

  // DOCX has no fixed pagination, so citations reference the document without page numbers.
  return {
    kind: "docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pageCount: null,
    pages: [{ pageNumber: null, text }],
  };
}
