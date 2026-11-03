import type { AIResponse, AIResponseSection, CalloutType } from "./ai-response";

// The "clinical note" view of a structured answer: what a clinician should see in 10-15 seconds, and what waits behind
// "More details". It only SELECTS and ARRANGES what the model already wrote (and the sources retrieval found): it never
// rewrites a sentence, never drops text and never invents any. Cautions are never collapsed.
//
//   summary    -> Clinical summary (one short sentence)
//   first plain section's bullets (at most MAX_KEY_POINTS; ordered steps are never cut) -> Key points
//   warning / critical sections and important / warning / critical callouts, from ANY section -> Important / Caution
//   everything else (further sections, tables of later sections, info and quote callouts, overflow bullets) -> More details
//   retrieval's sources -> Reference

export const MAX_KEY_POINTS = 5;

export type CautionLevel = "critical" | "warning" | "important";

export interface NoteCaution {
  level: CautionLevel;
  /** The model's own heading for a callout ("What to avoid"), when it gave one. */
  label?: string;
  /** Heading of the warning section this came from. */
  title?: string;
  text?: string;
  bullets?: string[];
  table?: AIResponseSection["table"];
  citations: number[];
}

export interface ClinicalNote {
  found: boolean;
  title?: string;
  summary?: string;
  /** Heading of the section the key points came from (used when it has nothing else to say). */
  keyPointsTitle?: string;
  keyPoints: string[];
  /** The key points are ordered steps (shown numbered, and never shortened). */
  keyPointsNumbered: boolean;
  /** A table that belongs to the key-points section (a dose table is often the answer itself). */
  keyPointsTable?: AIResponseSection["table"];
  keyPointsCitations: number[];
  cautions: NoteCaution[];
  /** Everything else, in the order the model wrote it. Rendered collapsed, in full. */
  details: AIResponseSection[];
}

const LEVEL_ORDER: Record<CautionLevel, number> = { critical: 0, warning: 1, important: 2 };
const CAUTION_CALLOUTS: readonly CalloutType[] = ["important", "warning", "critical"];

const normalize = (s: string | undefined) => (s ?? "").replace(/\*\*/g, "").replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

const isCautionSection = (s: AIResponseSection) => s.kind === "warning" || s.kind === "critical";

/** The note for one answer. `found: false` answers have only a summary. */
export function buildClinicalNote(response: AIResponse): ClinicalNote {
  const note: ClinicalNote = {
    found: response.found,
    title: response.title,
    summary: response.summary,
    keyPoints: [],
    keyPointsNumbered: false,
    keyPointsCitations: [],
    cautions: [],
    details: [],
  };
  if (!response.found) return note;

  const primaryIndex = response.sections.findIndex((s) => !isCautionSection(s));
  const seen = new Set<string>();
  const addCaution = (c: NoteCaution) => {
    const key = normalize([c.text, ...(c.bullets ?? [])].join(" ")) || normalize(c.title);
    if (key && seen.has(key)) return; // the same caution written twice (as a callout and a bullet) is shown once
    if (key) seen.add(key);
    note.cautions.push(c);
  };

  response.sections.forEach((section, index) => {
    const citations = section.citations ?? [];
    // What is left of the section for "More details" after its cautions have been lifted out.
    const rest: AIResponseSection = { ...section };

    if (isCautionSection(section)) {
      addCaution({ level: section.kind as CautionLevel, title: section.title, text: section.content, bullets: section.bullets, table: section.table, citations });
      rest.content = undefined;
      rest.bullets = undefined;
      rest.table = undefined;
    }

    if (section.callout && CAUTION_CALLOUTS.includes(section.callout.type)) {
      addCaution({ level: section.callout.type as CautionLevel, label: section.callout.label, text: section.callout.text, citations });
      rest.callout = undefined;
    }

    if (index === primaryIndex) {
      note.keyPointsTitle = section.title;
      note.keyPointsCitations = citations;
      note.keyPointsTable = section.table;
      rest.table = undefined;
      const bullets = section.bullets ?? [];
      if (bullets.length > 0) {
        note.keyPointsNumbered = section.numbered === true;
        // A procedure is never shown partially; a plain list is cut to the first few points, and the rest follows under "More details".
        const shown = note.keyPointsNumbered ? bullets : bullets.slice(0, MAX_KEY_POINTS);
        note.keyPoints = shown;
        rest.bullets = bullets.length > shown.length ? bullets.slice(shown.length) : undefined;
        rest.numbered = undefined;
        // The paragraph behind the bullets is the elaboration: it is kept, under "More details".
      } else if (section.content) {
        note.keyPoints = [section.content];
        rest.content = undefined;
      }
    }

    const hasRest = !!(rest.content || rest.bullets?.length || rest.table || rest.callout);
    if (hasRest) note.details.push(rest);
  });

  note.cautions.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  return note;
}

/** Words in the part of the note that is visible without opening "More details" (summary, key points, cautions). */
export function visibleWordCount(note: ClinicalNote): number {
  const text = [note.summary, ...note.keyPoints, ...note.cautions.flatMap((c) => [c.label, c.title, c.text, ...(c.bullets ?? [])])]
    .filter((t): t is string => !!t)
    .join(" ")
    .replace(/\*\*/g, "")
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "");
  return text.split(/\s+/).filter(Boolean).length;
}
