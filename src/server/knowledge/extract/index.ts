import "server-only";
import path from "node:path";
import { DOCUMENT_EXTENSIONS, IMAGE_EXTENSIONS, type DocumentKind, type ImageKind } from "@/lib/attachments";
import { extractDocx } from "./docx";
import { extractPdf } from "./pdf";
import { extractPptx } from "./pptx";
import { extractTxt } from "./txt";
import { ExtractionError, type ExtractedDocument } from "./types";
import { extractXlsx } from "./xlsx";

export { ExtractionError } from "./types";
export type { ExtractedDocument, ExtractedPage } from "./types";

export const SUPPORTED_EXTENSIONS = Object.keys(DOCUMENT_EXTENSIONS);

const FORMAT_NAMES: Record<DocumentKind, string> = {
  pdf: "PDF",
  docx: "Word document",
  txt: "text file",
  md: "Markdown file",
  csv: "CSV file",
  xlsx: "Excel workbook",
  pptx: "PowerPoint presentation",
};

const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Sniffs an image type from its first bytes; the file name and browser-sent MIME type are not trusted. */
export function sniffImage(buffer: Buffer): ImageKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
    return "webp";
  }
  return null;
}

/**
 * Determines a document's type from its extension, then checks that the content really is that
 * type (magic bytes; for Office files the extractor also checks the archive's main part).
 * A renamed file of the wrong type is rejected.
 */
export function detectKind(filename: string, buffer: Buffer): DocumentKind {
  const ext = path.extname(filename).toLowerCase();
  const kind = DOCUMENT_EXTENSIONS[ext];

  if (!kind) {
    if (ext in IMAGE_EXTENSIONS) {
      throw new ExtractionError("Images can't be added to the Knowledge Base. Attach them to a chat message instead.");
    }
    throw new ExtractionError(`Unsupported file type "${ext || "(none)"}". Upload a ${SUPPORTED_EXTENSIONS.join(", ")} file.`);
  }

  const mismatch = () => new ExtractionError(`This file has a ${ext} extension but is not a valid ${FORMAT_NAMES[kind]}.`);
  switch (kind) {
    case "pdf":
      if (buffer.toString("latin1", 0, 5) !== "%PDF-") throw mismatch();
      break;
    case "docx":
    case "xlsx":
    case "pptx":
      if (!isZip(buffer)) throw mismatch();
      break;
    case "txt":
    case "md":
    case "csv":
      // Text must not contain NUL bytes; this also rejects images or archives renamed to .txt.
      if (buffer.subarray(0, 8192).includes(0)) {
        throw new ExtractionError(`This file has a ${ext} extension but appears to be binary.`);
      }
      break;
  }
  return kind;
}

export async function extractDocument(filename: string, buffer: Buffer): Promise<ExtractedDocument> {
  if (buffer.length === 0) throw new ExtractionError("The uploaded file is empty.");
  const kind = detectKind(filename, buffer);
  switch (kind) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "xlsx":
      return extractXlsx(buffer);
    case "pptx":
      return extractPptx(buffer);
    case "txt":
    case "md":
    case "csv":
      return extractTxt(buffer, kind);
  }
}
