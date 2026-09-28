import type { CitationDTO } from "@/lib/types";
import type { SearchHit } from "../knowledge/vector-store";

const EXCERPT_CHARS = 320;

/** Source numbers referenced as [n], [n, m] or [n-m] in the answer, limited to 1..max. */
export function extractCitedIndices(answer: string, max: number): Set<number> {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(/\s*,\s*/)) {
      const [a, b] = part.split(/\s*[-–]\s*/).map(Number);
      const from = a!;
      const to = b ?? from;
      for (let n = from; n <= Math.min(to, from + max); n++) {
        if (n >= 1 && n <= max) cited.add(n);
      }
    }
  }
  return cited;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const cut = flat.slice(0, EXCERPT_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > EXCERPT_CHARS * 0.6 ? lastSpace : EXCERPT_CHARS)}…`;
}

/**
 * A passage that was sent to the model as a numbered source: a knowledge-base hit, or a chunk of
 * a file attached to this message (documentId null, score null when included in full).
 */
export interface SourceChunk {
  source: "knowledge_base" | "attachment";
  documentId: string | null;
  filename: string;
  pageStart: number | null;
  pageEnd: number | null;
  content: string;
  score: number | null;
}

export function fromSearchHit(hit: SearchHit): SourceChunk {
  return {
    source: "knowledge_base",
    documentId: hit.documentId,
    filename: hit.filename,
    pageStart: hit.pageStart,
    pageEnd: hit.pageEnd,
    content: hit.content,
    score: hit.score,
  };
}

/** One citation per source, in prompt order, flagged with whether the answer used it. */
export function buildCitations(
  answer: string,
  sources: (Omit<SourceChunk, "source"> & { source?: SourceChunk["source"] })[],
): CitationDTO[] {
  const cited = extractCitedIndices(answer, sources.length);
  return sources.map((s, i) => ({
    index: i + 1,
    source: s.source ?? "knowledge_base",
    documentId: s.documentId,
    filename: s.filename,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    excerpt: excerpt(s.content),
    score: s.score === null ? null : Math.round(s.score * 1000) / 1000,
    cited: cited.has(i + 1),
  }));
}
