// Chat attachment rules shared by the browser (fast feedback) and the server (authoritative checks).
// The server never trusts these alone: it re-validates every file by its actual bytes.

export type DocumentKind = "pdf" | "docx" | "txt" | "md" | "csv" | "xlsx" | "pptx";
export type ImageKind = "png" | "jpeg" | "webp";
export type AttachmentKind = "document" | "image";

export const DOCUMENT_EXTENSIONS: Record<string, DocumentKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
  ".csv": "csv",
  ".xlsx": "xlsx",
  ".pptx": "pptx",
};

export const IMAGE_EXTENSIONS: Record<string, ImageKind> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
};

export const IMAGE_MEDIA_TYPES: Record<ImageKind, "image/png" | "image/jpeg" | "image/webp"> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

export const ATTACHMENT_LIMITS = {
  maxFiles: 5,
  /** Per document. Matches the default MAX_UPLOAD_MB for the knowledge base. */
  maxDocumentBytes: 20 * 1024 * 1024,
  /** Per image. 5 MB is the smallest per-image limit among the three providers (Anthropic). */
  maxImageBytes: 5 * 1024 * 1024,
  maxTotalBytes: 25 * 1024 * 1024,
} as const;

export const DOCUMENT_ACCEPT = Object.keys(DOCUMENT_EXTENSIONS).join(",");
export const IMAGE_ACCEPT = Object.keys(IMAGE_EXTENSIONS).join(",");

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

/** Classifies a file by extension only. Used for UI feedback; the server checks the real bytes. */
export function attachmentKindFromName(filename: string): AttachmentKind | null {
  const ext = extensionOf(filename);
  if (ext in DOCUMENT_EXTENSIONS) return "document";
  if (ext in IMAGE_EXTENSIONS) return "image";
  return null;
}

/** Returns a user-facing problem with the file, or null if it may be attached. */
export function checkAttachment(file: { name: string; size: number }): string | null {
  const kind = attachmentKindFromName(file.name);
  if (!kind) {
    return `${file.name}: unsupported file type. Use PDF, DOCX, TXT, MD, CSV, XLSX, PPTX, PNG, JPG or WEBP.`;
  }
  if (file.size === 0) return `${file.name}: the file is empty.`;
  const max = kind === "image" ? ATTACHMENT_LIMITS.maxImageBytes : ATTACHMENT_LIMITS.maxDocumentBytes;
  if (file.size > max) return `${file.name}: too large (max ${Math.round(max / 1024 / 1024)} MB for ${kind}s).`;
  return null;
}
