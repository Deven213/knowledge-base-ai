import "server-only";
import { z } from "zod";
import { aiResponseSchema, CALLOUT_TYPES, SECTION_KINDS, type AIResponse, type AIResponseSection, type CalloutType, type SectionKind } from "@/lib/ai-response";
export { buildSources } from "@/lib/ai-response";

/**
 * JSON Schema sent to every provider's structured-output feature. It's deliberately simple and
 * portable (no nulls/unions, every field required, no extra keys) so OpenAI strict mode, Gemini
 * and Claude all accept it. "Empty" is expressed with "" / [] / callout type "none".
 */
export const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "title", "summary", "sections"],
  properties: {
    found: { type: "boolean", description: "false if the sources do not contain the answer" },
    title: { type: "string", description: "Short answer title" },
    summary: { type: "string", description: "One or two sentence overview; empty string if not needed" },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "tab", "kind", "content", "bullets", "numbered", "table", "callout", "citations"],
        properties: {
          title: { type: "string" },
          tab: { type: "string", description: "1-3 word topic tab label for this section, in the answer language" },
          kind: { type: "string", enum: ["info", "instruction", "warning", "critical"] },
          content: { type: "string", description: "Explanation paragraph; empty string if not needed" },
          bullets: { type: "array", items: { type: "string" } },
          numbered: { type: "boolean", description: "true if the bullets are ordered steps" },
          table: {
            type: "object",
            additionalProperties: false,
            required: ["headers", "rows"],
            description: "Only for genuinely tabular source data; empty headers and rows otherwise",
            properties: {
              headers: { type: "array", items: { type: "string" } },
              rows: { type: "array", items: { type: "array", items: { type: "string" } } },
            },
          },
          callout: {
            type: "object",
            additionalProperties: false,
            required: ["type", "label", "text"],
            properties: {
              type: { type: "string", enum: ["none", "info", "important", "warning", "critical", "quote"] },
              label: { type: "string", description: "Short heading such as \"What to say\" or \"Example\"; empty string for the default" },
              text: { type: "string" },
            },
          },
          citations: { type: "array", items: { type: "integer" }, description: "Source numbers supporting this section" },
        },
      },
    },
  },
} as const;

export const RESPONSE_FORMAT = {
  name: "knowledge_base_answer",
  description: "A structured, source-grounded answer",
  schema: RESPONSE_JSON_SCHEMA as unknown as Record<string, unknown>,
};

// Lenient reading of model output: tolerate missing fields and wrong-but-harmless types, then
// normalize strictly. Model output is never trusted as-is.
const rawSchema = z.object({
  found: z.boolean().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  sections: z
    .array(
      z.object({
        title: z.string().optional(),
        tab: z.string().optional(),
        kind: z.string().optional(),
        content: z.string().optional(),
        bullets: z.array(z.unknown()).optional(),
        numbered: z.boolean().optional(),
        table: z.object({ headers: z.array(z.unknown()).optional(), rows: z.array(z.array(z.unknown())).optional() }).nullish(),
        callout: z.object({ type: z.string().optional(), label: z.string().optional(), text: z.string().optional() }).nullish(),
        citations: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

/** Extracts a JSON object from model text (plain JSON, a ```json fence, or the outermost {...}). */
export function parseModelJson(text: string): unknown {
  const attempts = [text.trim(), /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]?.trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(text.slice(first, last + 1));
  for (const candidate of attempts) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next form
    }
  }
  return null;
}

const clean = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined;
  const v = s.replace(/\s+\n/g, "\n").trim().slice(0, max);
  return v || undefined;
};

const CALLOUTS: readonly string[] = CALLOUT_TYPES;
const KINDS: readonly string[] = SECTION_KINDS;

/** A usable table (1–6 columns, 1–20 rows, rows padded/trimmed to the header width), else undefined. */
function normalizeTable(t: { headers?: unknown[]; rows?: unknown[][] } | null | undefined): AIResponseSection["table"] {
  const headers = (t?.headers ?? []).map((h) => clean(h, 120) ?? "").slice(0, 6);
  if (headers.length === 0 || headers.every((h) => !h)) return undefined;
  const rows = (t?.rows ?? [])
    .map((r) => headers.map((_, i) => clean(r[i], 500) ?? ""))
    .filter((r) => r.some(Boolean))
    .slice(0, 20);
  return rows.length ? { headers, rows } : undefined;
}

/**
 * Turns raw model JSON into the normalized answer (without sources). Returns null if the output
 * isn't usable, in which case the caller falls back to plain text.
 */
export function normalizeModelAnswer(
  raw: unknown,
  sourceCount: number,
  notFoundText: string,
): Omit<AIResponse, "sources" | "language"> | null {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;

  const validCitation = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= sourceCount;
  const sections: AIResponseSection[] = (r.sections ?? [])
    .slice(0, 12)
    .flatMap((s): AIResponseSection[] => {
      const title = clean(s.title, 200);
      if (!title) return [];
      const bullets = (s.bullets ?? []).map((b) => clean(b, 1000)).filter((b): b is string => !!b).slice(0, 25);
      const calloutType = s.callout?.type?.toLowerCase();
      const calloutText = clean(s.callout?.text, 1500);
      const calloutLabel = clean(s.callout?.label, 40);
      const kind = s.kind?.toLowerCase();
      const tab = clean(s.tab, 40);
      const table = normalizeTable(s.table);
      const citations = [...new Set((s.citations ?? []).map((c) => (typeof c === "string" ? Number(c) : c)).filter(validCitation))];
      return [
        {
          title,
          // Optional presentation fields are only kept when given (older answers simply don't have them).
          ...(tab ? { tab } : {}),
          ...(kind && KINDS.includes(kind) && kind !== "info" ? { kind: kind as SectionKind } : {}),
          content: clean(s.content, 4000),
          bullets: bullets.length ? bullets : undefined,
          ...(bullets.length > 1 && s.numbered === true ? { numbered: true } : {}),
          ...(table ? { table } : {}),
          callout:
            calloutType && CALLOUTS.includes(calloutType) && calloutText
              ? { type: calloutType as CalloutType, ...(calloutLabel ? { label: calloutLabel } : {}), text: calloutText }
              : undefined,
          citations: citations.length ? citations : undefined,
        },
      ];
    });

  const found = r.found !== false;
  if (!found) {
    // "Not found" answers never carry content sections (nothing to ground them in).
    return { found: false, title: clean(r.title, 200), summary: clean(r.summary, 2000) ?? notFoundText, sections: [] };
  }
  const summary = clean(r.summary, 2000);
  if (sections.length === 0 && !summary) return null;
  return { found: true, title: clean(r.title, 200), summary, sections };
}

/**
 * Plain-text version of a structured answer: stored as the message text (search, copy, older
 * clients) and used to find which [n] sources the answer cites.
 */
export function structuredToText(a: Omit<AIResponse, "sources" | "language">): string {
  const lines: string[] = [];
  if (a.title) lines.push(a.title, "");
  if (a.summary) lines.push(a.summary, "");
  a.sections.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title}`);
    if (s.content) lines.push(s.content);
    (s.bullets ?? []).forEach((b, j) => lines.push(s.numbered ? `${j + 1}. ${b}` : `- ${b}`));
    if (s.table) {
      lines.push(s.table.headers.join(" | "));
      for (const row of s.table.rows) lines.push(row.join(" | "));
    }
    if (s.callout) lines.push(`${(s.callout.label ?? s.callout.type).toUpperCase()}: ${s.callout.text}`);
    if (s.citations?.length) lines.push(`Sources: ${s.citations.map((n) => `[${n}]`).join("")}`);
    lines.push("");
  });
  return lines.join("\n").trim();
}

/** Final validation of the assembled answer. */
export function finalizeAnswer(answer: AIResponse): AIResponse | null {
  const parsed = aiResponseSchema.safeParse(answer);
  return parsed.success ? parsed.data : null;
}
