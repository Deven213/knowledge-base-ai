"use client";

import type { ReactNode } from "react";
import { SearchX } from "lucide-react";
import type { ClinicalNote, NoteCaution } from "@/lib/clinical-note";
import type { AnswerUIText } from "@/lib/languages";
import { CAUTION_LEVELS, LEVEL_STYLES, LevelBox } from "./ResponseCallout";
import { ResponseBulletList, ResponseTable } from "./ResponseSection";

// The four blocks of the clinical note. Each has a small upright heading; the note text itself is italic (Latin script)
// with values, drug names and warnings in upright bold, so the eye lands on them.

/** Small uppercase heading of a block. Plain text, never colour alone. */
export function BlockHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h4 id={id} className="mb-1 text-xs font-bold tracking-wide text-slate-600 uppercase">
      {children}
    </h4>
  );
}

export function ClinicalSummary({ id, text, label, italic, render }: { id: string; text: string; label: string; italic: boolean; render: (t: string) => ReactNode }) {
  return (
    <section aria-labelledby={id} className="border-l-4 border-brand-600 pl-3">
      <BlockHeading id={id}>{label}</BlockHeading>
      <p className={`text-base leading-relaxed text-slate-900 ${italic ? "italic" : "font-medium"}`}>{render(text)}</p>
    </section>
  );
}

export function KeyPoints({ id, note, label, italic, render }: { id: string; note: ClinicalNote; label: string; italic: boolean; render: (t: string) => ReactNode }) {
  if (note.keyPoints.length === 0 && !note.keyPointsTable) return null;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <BlockHeading id={id}>{label}</BlockHeading>
      {note.keyPoints.length > 0 &&
        (note.keyPoints.length === 1 && !note.keyPointsNumbered ? (
          // A single point (the model gave a sentence, not a list) reads as a sentence, not a one-item list.
          <p className={`text-[15px] leading-relaxed text-slate-800 ${italic ? "italic" : ""}`}>{render(note.keyPoints[0]!)}</p>
        ) : (
          <ResponseBulletList items={note.keyPoints} numbered={note.keyPointsNumbered} render={render} italic={italic} />
        ))}
      {note.keyPointsTable && <ResponseTable table={note.keyPointsTable} render={render} />}
    </section>
  );
}

/**
 * Warnings, contraindications, red flags and limits the sources state. ALWAYS visible (never behind "More details"),
 * strongest first, each with its own icon and label so severity doesn't depend on colour.
 */
export function CautionBox({ id, cautions, ui, render }: { id: string; cautions: NoteCaution[]; ui: AnswerUIText; render: (t: string) => ReactNode }) {
  if (cautions.length === 0) return null;
  const strongest = CAUTION_LEVELS.find((level) => cautions.some((c) => c.level === level))!;
  const style = LEVEL_STYLES[strongest];
  return (
    <section aria-labelledby={id} data-level={strongest} className={`rounded-lg border-l-4 border px-3.5 py-3 ${style.box}`}>
      <BlockHeading id={id}>{ui.note.caution}</BlockHeading>
      <ul className="space-y-2.5">
        {cautions.map((c, i) => {
          const Icon = LEVEL_STYLES[c.level].icon;
          const word = ui.callouts[c.level];
          // The level's own word already says it: don't repeat it as the heading ("Red flag — Red flags").
          const heading = [c.label, c.title].find((h) => h && h.toLowerCase().replace(/s$/, "") !== word.toLowerCase().replace(/s$/, ""));
          return (
            <li key={i} data-level={c.level} className="flex gap-2.5">
              <Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${LEVEL_STYLES[c.level].label}`} aria-hidden />
              <div className="min-w-0 space-y-1.5 text-[15px] leading-relaxed text-slate-900">
                {/* The level's own word first (Red flag, Warning, Important), then the model's heading when it added one. */}
                <p className={`text-xs font-bold tracking-wide uppercase ${LEVEL_STYLES[c.level].label}`}>
                  {word}
                  {heading ? <span className="font-semibold normal-case"> — {heading}</span> : null}
                </p>
                {c.text && <p className={c.level === "critical" ? "font-medium text-slate-950" : undefined}>{render(c.text)}</p>}
                {c.bullets && c.bullets.length > 0 && <ResponseBulletList items={c.bullets} render={render} />}
                {c.table && <ResponseTable table={c.table} render={render} />}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The documents don't answer the question: said plainly, in a neutral box (it is not a warning). */
export function NotEstablished({ ui, text, italic, render }: { ui: AnswerUIText; text?: string; italic: boolean; render: (t: string) => ReactNode }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-lg border border-slate-300 bg-slate-50 px-3.5 py-3">
      <SearchX className="mt-0.5 h-4.5 w-4.5 shrink-0 text-slate-600" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-bold tracking-wide text-slate-700 uppercase">{ui.note.notEstablished}</p>
        {text && <p className={`text-[15px] leading-relaxed text-slate-800 ${italic ? "italic" : ""}`}>{render(text)}</p>}
      </div>
    </div>
  );
}

/** Shown when an answer cites nothing: it is not presented as source-backed. */
export function NoSourceNotice({ ui }: { ui: AnswerUIText }) {
  return (
    <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
      <strong className="font-semibold">{ui.callouts.important}:</strong> {ui.note.noSourceCited}
    </p>
  );
}
