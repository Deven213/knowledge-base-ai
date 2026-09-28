"use client";

import type { ReactNode } from "react";
import type { AIResponseSection, SectionKind } from "@/lib/ai-response";
import type { AnswerUIText } from "@/lib/languages";
import type { CitationDTO } from "@/lib/types";
import { InlineText } from "../Markdown";
import { ResponseCallout } from "./ResponseCallout";
import { citationLabel, shortCitationLabel, SourceChip } from "./ResponseSources";

/** Inline source markers such as " [1]", "[2, 3]" or "[4-5]". */
const INLINE_MARKERS = /\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

// Normal information is calm; only warning/critical sections get warm or red accents.
const KIND_STYLES: Record<SectionKind, { card: string; badge: string }> = {
  info: { card: "border-navy-700", badge: "bg-orange-500 text-navy-950" },
  instruction: { card: "border-navy-700", badge: "bg-teal-400 text-navy-950" },
  warning: { card: "border-[#ff6a3d]/40", badge: "bg-[#ff6a3d] text-white" },
  critical: { card: "border-red-500/60 bg-red-950/20", badge: "bg-red-600 text-white" },
};

export function ResponseBulletList({ items, numbered, render }: { items: string[]; numbered?: boolean; render: (t: string) => ReactNode }) {
  const List = numbered ? "ol" : "ul";
  return (
    <List className="space-y-1.5">
      {items.map((b, i) => (
        <li key={i} className="flex gap-2.5 text-[15px] leading-relaxed text-slate-200">
          {numbered ? (
            <span className="w-5 shrink-0 pt-px text-right text-sm font-semibold text-orange-300" aria-hidden>
              {i + 1}.
            </span>
          ) : (
            <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" aria-hidden />
          )}
          <span className="min-w-0">{render(b)}</span>
        </li>
      ))}
    </List>
  );
}

export function ResponseTable({ table, render }: { table: NonNullable<AIResponseSection["table"]>; render: (t: string) => ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-navy-700">
      <table className="w-full min-w-[420px] border-collapse text-left text-sm">
        <thead className="bg-navy-800 text-xs tracking-wide text-orange-200 uppercase">
          <tr>
            {table.headers.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-navy-700 text-slate-200">
          {table.rows.map((row, i) => (
            <tr key={i} className="even:bg-navy-900/60">
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

/** One numbered section card inside the single AI response (never a separate chat message). */
export function ResponseSection({
  id,
  section,
  number,
  citations,
  ui,
  onCite,
}: {
  id: string;
  section: AIResponseSection;
  number: number;
  citations: CitationDTO[];
  ui: AnswerUIText;
  onCite: (n: number) => void;
}) {
  const byIndex = (n: number) => citations.find((c) => c.index === n);
  // One chip per distinct document/page range cited by this section.
  const refs = [...new Map((section.citations ?? []).map((n) => [citationLabel(byIndex(n)), n])).entries()].filter(([label]) => label);
  // A single source already shows as the chip below, so repeated inline markers are dropped;
  // with several, markers stay and read as friendly labels ("p. 6") instead of numbers.
  const render = (text: string) => (
    <InlineText
      text={refs.length <= 1 ? text.replace(INLINE_MARKERS, "") : text}
      maxCitation={citations.length}
      onCite={onCite}
      titleFor={(n) => citationLabel(byIndex(n))}
      labelFor={(n) => shortCitationLabel(byIndex(n))}
      tone="dark"
    />
  );
  const style = KIND_STYLES[section.kind ?? "info"];

  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`scroll-mt-16 rounded-2xl border bg-navy-850 p-4 sm:p-5 ${style.card}`}>
      <h4 id={`${id}-title`} className="flex items-start gap-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold ${style.badge}`} aria-hidden>
          {number}
        </span>
        <span className="pt-0.5 text-[17px] leading-snug font-semibold text-white">{section.title}</span>
      </h4>
      <div className="mt-2.5 space-y-3 sm:pl-10">
        {section.content && <p className="text-[15px] leading-relaxed text-slate-200">{render(section.content)}</p>}
        {section.bullets && <ResponseBulletList items={section.bullets} numbered={section.numbered} render={render} />}
        {section.table && <ResponseTable table={section.table} render={render} />}
        {section.callout && <ResponseCallout callout={section.callout} ui={ui} render={render} />}
        {refs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span className="text-[11px] font-semibold tracking-wider text-slate-500 uppercase">{ui.source}</span>
            {refs.map(([label, n]) => (
              <SourceChip key={label} citation={byIndex(n)!} onClick={() => onCite(n)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
