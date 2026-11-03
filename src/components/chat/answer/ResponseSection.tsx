"use client";

import type { ReactNode } from "react";
import type { AIResponseSection } from "@/lib/ai-response";
import type { AnswerUIText } from "@/lib/languages";
import type { CitationDTO } from "@/lib/types";
import { InlineText } from "../Markdown";
import { ResponseCallout } from "./ResponseCallout";
import { citationLabel, shortCitationLabel, SourceChip } from "./ResponseSources";

/** Inline source markers such as " [1]", "[2, 3]" or "[4-5]". */
const INLINE_MARKERS = /\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

/** Short list items: a small dot (or the step number), then the text. `italic` is the clinical-note typography. */
export function ResponseBulletList({ items, numbered, render, italic = false }: { items: string[]; numbered?: boolean; render: (t: string) => ReactNode; italic?: boolean }) {
  const List = numbered ? "ol" : "ul";
  return (
    <List className="space-y-1.5">
      {items.map((b, i) => (
        <li key={i} className={`flex gap-2.5 text-[15px] leading-relaxed text-slate-800 ${italic ? "italic" : ""}`}>
          {numbered ? (
            <span className="w-5 shrink-0 pt-px text-right text-sm font-semibold text-brand-700 not-italic" aria-hidden>
              {i + 1}.
            </span>
          ) : (
            <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand-600" aria-hidden />
          )}
          <span className="min-w-0">{render(b)}</span>
        </li>
      ))}
    </List>
  );
}

export function ResponseTable({ table, render }: { table: NonNullable<AIResponseSection["table"]>; render: (t: string) => ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[420px] border-collapse text-left text-sm">
        <thead className="bg-slate-100 text-xs tracking-wide text-slate-700 uppercase">
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 text-slate-800">
          {table.rows.map((row, i) => (
            <tr key={i} className="even:bg-slate-50">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 align-top leading-relaxed">
                  {render(cell)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders model text with **bold** terms, *emphasis* and clickable source markers (shown as "p. 6"). */
export function noteTextRenderer(citations: CitationDTO[], onCite: (n: number) => void, italic: boolean, dropMarkers = false) {
  const byIndex = (n: number) => citations.find((c) => c.index === n);
  return function renderNoteText(text: string) {
    return (
      <InlineText
        text={dropMarkers ? text.replace(INLINE_MARKERS, "") : text}
        maxCitation={citations.length}
        onCite={onCite}
        titleFor={(n) => citationLabel(byIndex(n))}
        labelFor={(n) => shortCitationLabel(byIndex(n))}
        italicContext={italic}
      />
    );
  };
}

/**
 * One further section, shown under "More details": its title, text, bullets, table and note callouts, with the sources
 * that support it. (Its cautions were already lifted into the caution box.)
 */
export function ResponseSection({
  id,
  section,
  citations,
  ui,
  italic,
  onCite,
}: {
  id: string;
  section: AIResponseSection;
  citations: CitationDTO[];
  ui: AnswerUIText;
  italic: boolean;
  onCite: (n: number) => void;
}) {
  const byIndex = (n: number) => citations.find((c) => c.index === n);
  // One chip per distinct document/page range cited by this section.
  const refs = [...new Map((section.citations ?? []).map((n) => [citationLabel(byIndex(n)), n])).entries()].filter(([label]) => label);
  // A single source already shows as the chip below, so repeated inline markers are dropped.
  const render = noteTextRenderer(citations, onCite, italic, refs.length <= 1);

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2">
      <h5 id={`${id}-title`} className="text-[15px] leading-snug font-semibold text-slate-900">
        {section.title}
      </h5>
      {section.content && <p className={`text-[15px] leading-relaxed text-slate-800 ${italic ? "italic" : ""}`}>{render(section.content)}</p>}
      {section.bullets && <ResponseBulletList items={section.bullets} numbered={section.numbered} render={render} italic={italic} />}
      {section.table && <ResponseTable table={section.table} render={render} />}
      {section.callout && <ResponseCallout callout={section.callout} ui={ui} render={render} />}
      {refs.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <span className="text-xs font-semibold tracking-wide text-slate-600 uppercase">{ui.source}</span>
          {refs.map(([label, n]) => (
            <SourceChip key={label} citation={byIndex(n)!} onClick={() => onCite(n)} />
          ))}
        </div>
      )}
    </section>
  );
}
