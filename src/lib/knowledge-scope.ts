import { z } from "zod";

// "Chat with": WHICH data a conversation searches. Independent of the AI model (which model answers)
// and of the per-response language (which language the answer is shown in).

export const knowledgeScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("all") }).strict(),
  z.object({ type: z.literal("document"), documentId: z.uuid() }).strict(),
  /** One website (host) crawled by the Website Scraper integration. */
  z.object({ type: z.literal("website"), integrationId: z.uuid(), host: z.string().min(1).max(253) }).strict(),
  z.object({ type: z.literal("google_drive"), integrationId: z.uuid() }).strict(),
  z.object({ type: z.literal("onedrive"), integrationId: z.uuid() }).strict(),
]);

export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;
export type KnowledgeScopeType = KnowledgeScope["type"];

export const ALL_SCOPE: KnowledgeScope = { type: "all" };

/** Stable identifier for a scope (dropdown keys, comparisons). */
export function scopeKey(scope: KnowledgeScope): string {
  switch (scope.type) {
    case "all":
      return "all";
    case "document":
      return `document:${scope.documentId}`;
    case "website":
      return `website:${scope.integrationId}:${scope.host}`;
    default:
      return `${scope.type}:${scope.integrationId}`;
  }
}

export function parseKnowledgeScope(value: unknown): KnowledgeScope | null {
  const parsed = knowledgeScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** A selectable "Chat with" source, built from the indexed documents. */
export interface KnowledgeSourceDTO {
  key: string;
  scope: KnowledgeScope;
  /** Domain, file name, "Google Drive", "OneDrive" or "All Knowledge Base". */
  label: string;
  /** Number of indexed documents (web pages for a website). */
  count: number;
}

/** "9 pages", "1 document", "10 documents". */
export function sourceCountLabel(source: Pick<KnowledgeSourceDTO, "scope" | "count">): string {
  const unit = source.scope.type === "website" ? "page" : "document";
  return `${source.count} ${unit}${source.count === 1 ? "" : "s"}`;
}

/** Host used to group website pages ("www." ignored, so both spellings are one website). */
export function websiteHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
