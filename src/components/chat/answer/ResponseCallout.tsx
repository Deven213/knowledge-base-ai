"use client";

import type { ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info, MessageSquareQuote, OctagonAlert, type LucideIcon } from "lucide-react";
import type { AIResponseSection, CalloutType } from "@/lib/ai-response";
import type { CautionLevel } from "@/lib/clinical-note";
import type { AnswerUIText } from "@/lib/languages";

export type WarningLevel = Exclude<CalloutType, "quote">;

// Severity is never carried by colour alone: every level has its own icon and a text label.
// info = blue note · important = amber · warning = orange · critical = red.
export const LEVEL_STYLES: Record<WarningLevel, { icon: LucideIcon; box: string; label: string; text: string }> = {
  info: { icon: Info, box: "border-sky-300 bg-sky-50", label: "text-sky-900", text: "text-slate-800" },
  important: { icon: CircleAlert, box: "border-amber-300 bg-amber-50", label: "text-amber-900", text: "text-slate-900" },
  warning: { icon: AlertTriangle, box: "border-orange-400 bg-orange-50", label: "text-orange-900", text: "text-slate-900" },
  critical: { icon: OctagonAlert, box: "border-red-400 border-l-4 bg-red-50", label: "text-red-900", text: "font-medium text-slate-950" },
};

/** The levels the caution box can hold, strongest first. */
export const CAUTION_LEVELS: readonly CautionLevel[] = ["critical", "warning", "important"];

/** A short labelled box (note or caution): icon, label, content. */
export function LevelBox({ level, label, children, role = "note" }: { level: WarningLevel; label: string; children: ReactNode; role?: "note" | "alert" }) {
  const s = LEVEL_STYLES[level];
  const Icon = s.icon;
  return (
    <div className={`rounded-lg border px-3.5 py-2.5 ${s.box}`} role={role} aria-label={label}>
      <p className={`mb-1 flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase ${s.label}`}>
        <Icon className="h-4 w-4 shrink-0" aria-hidden /> {label}
      </p>
      <div className={`text-[15px] leading-relaxed ${s.text}`}>{children}</div>
    </div>
  );
}

/** Recommended wording ("What to say"): a quiet quote. */
export function QuoteCallout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5">
      <figcaption className="mb-1 flex items-center gap-1.5 text-xs font-bold tracking-wide text-slate-700 uppercase">
        <MessageSquareQuote className="h-4 w-4 shrink-0" aria-hidden /> {label}
      </figcaption>
      <blockquote className="text-[15px] leading-relaxed text-slate-800">“{children}”</blockquote>
    </figure>
  );
}

/** A section's callout, in the right component; its label is the model's (e.g. "What to say") or the default. */
export function ResponseCallout({
  callout,
  ui,
  render,
}: {
  callout: NonNullable<AIResponseSection["callout"]>;
  ui: AnswerUIText;
  render: (text: string) => ReactNode;
}) {
  const label = callout.label || ui.callouts[callout.type];
  if (callout.type === "quote") return <QuoteCallout label={label}>{render(callout.text)}</QuoteCallout>;
  return (
    <LevelBox level={callout.type} label={label}>
      {render(callout.text)}
    </LevelBox>
  );
}
