import { z } from "zod";
import type { CitationDTO } from "./types";

// Provider-neutral, normalized AI answer. Every provider's output is validated into this shape on
// the server; the browser renders it. The model only fills in text: sources, document names and
// page numbers always come from retrieval (the existing citation system), never from the model.

/**
 * info = blue note · important = orange caution · warning = red-orange · critical = strong red
 * (only for urgent risks the sources state) · quote = recommended wording ("What to say").
 */
export const CALLOUT_TYPES = ["info", "important", "warning", "critical", "quote"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** How a whole section reads: normal information, steps/instructions, a caution, or a critical warning. */
export const SECTION_KINDS = ["info", "instruction", "warning", "critical"] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

const text = (max: number) => z.string().trim().max(max);

export const aiResponseSectionSchema = z.object({
  title: text(200).min(1),
  /** Short topic-tab label (1–3 words), in the answer language. Missing on older answers. */
  tab: text(40).optional(),
  /** Missing = "info". */
  kind: z.enum(SECTION_KINDS).optional(),
  content: text(4000).optional(),
  bullets: z.array(text(1000).min(1)).max(25).optional(),
  /** Bullets are ordered steps. */
  numbered: z.boolean().optional(),
  table: z
    .object({ headers: z.array(text(120)).min(1).max(6), rows: z.array(z.array(text(500))).min(1).max(20) })
    .optional(),
  callout: z.object({ type: z.enum(CALLOUT_TYPES), label: text(40).optional(), text: text(1500).min(1) }).optional(),
  /** Source numbers ([n]) that support this section; they index the message's citations. */
  citations: z.array(z.number().int().min(1)).max(30).optional(),
});

export const aiSourceSchema = z.object({
  /** Knowledge-base document ID; null for temporary chat attachments. */
  documentId: z.string().nullable(),
  documentName: z.string(),
  pageStart: z.number().int().nullable(),
  pageEnd: z.number().int().nullable(),
  excerpt: z.string().optional(),
  /** Which [n] citations this source card covers. */
  citationIndexes: z.array(z.number().int()),
  origin: z.enum(["knowledge_base", "attachment"]),
});

export const aiResponseSchema = z.object({
  /** False when the documents didn't contain the answer (the summary then says so). */
  found: z.boolean(),
  title: text(200).optional(),
  summary: text(2000).optional(),
  sections: z.array(aiResponseSectionSchema).max(12),
  sources: z.array(aiSourceSchema),
  /** Answer language code (see lib/languages.ts). */
  language: z.string(),
});

export type AIResponseSection = z.infer<typeof aiResponseSectionSchema>;
export type AISource = z.infer<typeof aiSourceSchema>;
export type AIResponse = z.infer<typeof aiResponseSchema>;

/** Validates a stored/received structured answer; null if it doesn't match (render as plain text instead). */
export function parseAIResponse(value: unknown): AIResponse | null {
  const parsed = aiResponseSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Source cards for the answer, built from the existing citations (never from model output):
 * cited passages only (all retrieved ones if none were cited), grouped by document and page range.
 */
export function buildSources(citations: CitationDTO[]): AISource[] {
  const pool = citations.some((c) => c.cited) ? citations.filter((c) => c.cited) : citations;
  const groups = new Map<string, AISource>();
  for (const c of pool) {
    const origin = c.source ?? "knowledge_base";
    const key = `${origin}|${c.documentId ?? c.filename}|${c.pageStart}|${c.pageEnd}`;
    const existing = groups.get(key);
    if (existing) existing.citationIndexes.push(c.index);
    else {
      groups.set(key, {
        documentId: c.documentId,
        documentName: c.filename,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        excerpt: c.excerpt,
        citationIndexes: [c.index],
        origin,
      });
    }
  }
  return [...groups.values()];
}
