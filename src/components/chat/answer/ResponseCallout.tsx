"use client";

import type { ReactNode } from "react";
import { AlertTriangle, CircleAlert, Info, MessageSquareQuote, OctagonAlert, type LucideIcon } from "lucide-react";
import type { AIResponseSection, CalloutType } from "@/lib/ai-response";
import type { AnswerUIText } from "@/lib/languages";

export type WarningLevel = Exclude<CalloutType, "quote">;

// Colour carries meaning, so each level has exactly one look:
// info = blue · important = orange · warning = red-orange · critical = strong red.
const WARNING_STYLES: Record<WarningLevel, { icon: LucideIcon; box: string; label: string; text: string }> = {
  info: { icon: Info, box: "border-sky-400/25 bg-sky-400/[0.07]", label: "text-sky-300", text: "text-sky-50/90" },
  important: { icon: CircleAlert, box: "border-orange-400/35 bg-orange-400/[0.08]", label: "text-orange-300", text: "text-orange-50/90" },
  warning: { icon: AlertTriangle, box: "border-[#ff6a3d]/45 bg-[#ff6a3d]/10", label: "text-[#ff9470]", text: "text-orange-50" },
  critical: {
    icon: OctagonAlert,
    box: "border-red-500/70 border-l-4 bg-red-600/15 shadow-[0_0_0_1px_rgba(239,68,68,0.15)]",
    label: "text-red-300",
    text: "font-medium text-red-50",
  },
};

/** Info / important / warning / critical box: icon, label, content. */
export function WarningCallout({ level, label, children }: { level: WarningLevel; label: string; children: ReactNode }) {
  const s = WARNING_STYLES[level];
  const Icon = s.icon;
  return (
    <div className={`rounded-xl border px-4 py-3 ${s.box}`} role={level === "critical" || level === "warning" ? "alert" : "note"}>
      <p className={`mb-1 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] uppercase ${s.label}`}>
        <Icon className="h-4 w-4" aria-hidden /> {label}
      </p>
      <p className={`text-[15px] leading-relaxed ${s.text}`}>{children}</p>
    </div>
  );
}

/** Recommended wording ("What to say"): the warm orange/brown quote box. */
export function QuoteCallout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <figure className="rounded-xl border border-[#b8702a]/45 bg-[linear-gradient(135deg,rgba(120,64,20,0.35),rgba(80,42,14,0.25))] px-4 py-3">
      <figcaption className="mb-1 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] text-orange-300 uppercase">
        <MessageSquareQuote className="h-4 w-4" aria-hidden /> {label}
      </figcaption>
      <blockquote className="text-[15px] leading-relaxed font-medium text-orange-50 italic">“{children}”</blockquote>
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
    <WarningCallout level={callout.type} label={label}>
      {render(callout.text)}
    </WarningCallout>
  );
}
