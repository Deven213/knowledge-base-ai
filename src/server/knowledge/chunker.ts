import type { ExtractedPage } from "./extract";

export interface Chunk {
  index: number;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  chunkSize: number;
  /** Approximate characters of trailing context repeated at the start of the next chunk. */
  overlap: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { chunkSize: 1000, overlap: 150 };

/** The smallest piece of text the packer moves around, with the separator that precedes it. */
interface Unit {
  text: string;
  page: number | null;
  sep: string;
}

// From coarsest to finest: paragraphs → lines → sentences → words.
const LEVELS: { split: (t: string) => string[]; sep: string }[] = [
  { split: (t) => t.split(/\n{2,}/), sep: "\n\n" },
  { split: (t) => t.split("\n"), sep: "\n" },
  { split: (t) => t.split(/(?<=[.!?;:])\s+/), sep: " " },
  { split: (t) => t.split(/\s+/), sep: " " },
];

function toUnits(text: string, page: number | null, maxLen: number, sep: string, level = 0): Unit[] {
  if (text.length <= maxLen) return [{ text, page, sep }];

  if (level >= LEVELS.length) {
    // A single "word" longer than a chunk (e.g. a base64 blob): hard-split it.
    const out: Unit[] = [];
    for (let i = 0; i < text.length; i += maxLen) {
      out.push({ text: text.slice(i, i + maxLen), page, sep: i === 0 ? sep : "" });
    }
    return out;
  }

  const { split, sep: levelSep } = LEVELS[level]!;
  const parts = split(text)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return toUnits(text, page, maxLen, sep, level + 1);

  return parts.flatMap((part, i) => toUnits(part, page, maxLen, i === 0 ? sep : levelSep, level + 1));
}

function unitsLength(units: Unit[]): number {
  return units.reduce((len, u, i) => len + u.text.length + (i === 0 ? 0 : u.sep.length), 0);
}

function buildChunk(units: Unit[], index: number): Chunk {
  const content = units.map((u, i) => (i === 0 ? u.text : u.sep + u.text)).join("");
  const pages = units.map((u) => u.page).filter((p): p is number => p !== null);
  return {
    index,
    content,
    pageStart: pages.length ? Math.min(...pages) : null,
    pageEnd: pages.length ? Math.max(...pages) : null,
  };
}

/**
 * Splits document pages into overlapping chunks that respect natural boundaries
 * (paragraph, then line, sentence, word) and remember which pages they came from.
 */
export function chunkPages(pages: ExtractedPage[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  const { chunkSize, overlap } = options;
  if (chunkSize <= 0) throw new Error("chunkSize must be positive");
  if (overlap < 0 || overlap >= chunkSize) throw new Error("overlap must be in [0, chunkSize)");

  const units = pages.flatMap((p) => (p.text.trim() ? toUnits(p.text.trim(), p.pageNumber, chunkSize, "\n\n") : []));

  const chunks: Chunk[] = [];
  let current: Unit[] = [];

  for (const unit of units) {
    const candidateLength = unitsLength([...current, unit]);
    if (current.length > 0 && candidateLength > chunkSize) {
      chunks.push(buildChunk(current, chunks.length));

      // Carry trailing units forward as overlap, never the entire previous chunk.
      const carried: Unit[] = [];
      for (let i = current.length - 1; i > 0; i--) {
        const next = [current[i]!, ...carried];
        if (unitsLength(next) > overlap) break;
        carried.unshift(current[i]!);
      }
      // Drop overlap from the front if it would stop the new unit from fitting.
      while (carried.length > 0 && unitsLength([...carried, unit]) > chunkSize) carried.shift();
      current = carried;
    }
    current.push(unit);
  }
  if (current.length > 0) chunks.push(buildChunk(current, chunks.length));

  return chunks;
}
