import { normalizeText } from "./normalize";
import { ExtractionError, type ExtractedDocument } from "./types";

const TEXT_TYPES = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
} as const;

/** Plain-text formats (TXT, Markdown, CSV) are read as text; Markdown and CSV syntax is kept as-is. */
export function extractTxt(buffer: Buffer, kind: keyof typeof TEXT_TYPES = "txt"): ExtractedDocument {
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    // Not valid UTF-8: fall back to Windows-1252, the most common legacy encoding for text files.
    raw = new TextDecoder("windows-1252").decode(buffer);
  }

  const text = normalizeText(raw);
  if (!text) throw new ExtractionError("This text file is empty.");

  return { kind, mimeType: TEXT_TYPES[kind], pageCount: null, pages: [{ pageNumber: null, text }] };
}
