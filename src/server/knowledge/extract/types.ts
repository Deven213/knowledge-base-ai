import type { DocumentKind } from "@/lib/attachments";

export type SupportedKind = DocumentKind;

/** A unit of source text. `pageNumber` is 1-based for PDF pages and PPTX slides, null otherwise. */
export interface ExtractedPage {
  pageNumber: number | null;
  text: string;
}

export interface ExtractedDocument {
  kind: SupportedKind;
  mimeType: string;
  pageCount: number | null;
  pages: ExtractedPage[];
}

/** An error whose message is safe and useful to show the user. */
export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}
