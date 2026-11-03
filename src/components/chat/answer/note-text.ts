import type { AISource, AIResponse } from "@/lib/ai-response";
import type { ClinicalNote } from "@/lib/clinical-note";
import type { AnswerUIText } from "@/lib/languages";
import type { CitationDTO } from "@/lib/types";
import { citationLabel, describeCitation } from "./ResponseSources";

// Plain text for "Copy answer": the note in reading order, with its labels in the answer's language and the references
// spelled out (so it can be pasted into a record and still be checked). Everything shown on screen is included,
// "More details" and cautions too: copying must never lose a warning. Display markers (**bold**, [n]) are removed.

const plain = (text: string) =>
  text
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*(?!\s)([^*\n]+?)(?<!\s)\*/g, "$1")
    .trim();

/** "Metformin.pdf — Page 6" for a source card, from its first citation when there is one. */
function sourceLabel(source: AISource, citations: CitationDTO[]): string {
  const first = citations.find((c) => c.index === source.citationIndexes[0]);
  if (first) return citationLabel(first);
  const d = describeCitation({ filename: source.documentName, pageStart: source.pageStart, pageEnd: source.pageEnd, source: source.origin });
  return d.detail ? `${d.title} — ${d.detail}` : d.title;
}

export function clinicalNoteToText(response: AIResponse, note: ClinicalNote, sources: AISource[], citations: CitationDTO[], ui: AnswerUIText): string {
  const lines: string[] = [];
  if (response.title) lines.push(plain(response.title), "");
  if (!note.found) {
    lines.push(`${ui.note.notEstablished}${note.summary ? `: ${plain(note.summary)}` : ""}`);
    return lines.join("\n").trim();
  }

  if (note.summary) lines.push(`${ui.note.clinicalSummary}: ${plain(note.summary)}`, "");
  if (note.keyPoints.length > 0) {
    lines.push(`${ui.note.keyPoints}:`);
    note.keyPoints.forEach((p, i) => lines.push(note.keyPointsNumbered ? `${i + 1}. ${plain(p)}` : `- ${plain(p)}`));
    lines.push("");
  }
  if (note.keyPointsTable) lines.push(...tableLines(note.keyPointsTable), "");
  if (note.cautions.length > 0) {
    lines.push(`${ui.note.caution}:`);
    for (const c of note.cautions) {
      const heading = [ui.callouts[c.level], c.label || c.title].filter(Boolean).join(" — ");
      lines.push(`- ${heading}${c.text ? `: ${plain(c.text)}` : ""}`);
      (c.bullets ?? []).forEach((b) => lines.push(`  - ${plain(b)}`));
      if (c.table) lines.push(...tableLines(c.table).map((l) => `  ${l}`));
    }
    lines.push("");
  }
  if (note.details.length > 0) {
    lines.push(`${ui.note.moreDetails}:`);
    for (const s of note.details) {
      lines.push(plain(s.title));
      if (s.content) lines.push(plain(s.content));
      (s.bullets ?? []).forEach((b, i) => lines.push(s.numbered ? `${i + 1}. ${plain(b)}` : `- ${plain(b)}`));
      if (s.table) lines.push(...tableLines(s.table));
      if (s.callout) lines.push(`${s.callout.label || ui.callouts[s.callout.type]}: ${plain(s.callout.text)}`);
      lines.push("");
    }
  }
  if (sources.length > 0) lines.push(`${ui.note.reference}: ${sources.map((s) => sourceLabel(s, citations)).join("; ")}`);
  else lines.push(ui.note.noSourceCited);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function tableLines(table: NonNullable<ClinicalNote["keyPointsTable"]>): string[] {
  return [table.headers.map(plain).join(" | "), ...table.rows.map((r) => r.map(plain).join(" | "))];
}
