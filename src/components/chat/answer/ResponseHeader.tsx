"use client";

import type { ReactNode } from "react";
import { BookOpenText } from "lucide-react";

/** AI icon + dynamic title (from the answer itself) + the response's own controls (language). */
export function ResponseHeader({ title, lang, eyebrow, actions }: { title: string | undefined; lang: string; eyebrow: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start gap-x-3 gap-y-3 pt-4 pb-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-400 to-emerald-500 text-navy-950 shadow-sm" aria-hidden>
        <BookOpenText className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0 flex-1 basis-48">
        <p className="text-[11px] font-semibold tracking-[0.14em] text-teal-300 uppercase">{eyebrow}</p>
        {title ? (
          <h3 lang={lang} className="mt-0.5 text-lg leading-snug font-bold text-white sm:text-xl">
            {title}
          </h3>
        ) : (
          <p className="mt-0.5 text-base font-semibold text-slate-200">Knowledge Base AI</p>
        )}
      </div>
      {actions && <div className="ml-auto shrink-0">{actions}</div>}
    </header>
  );
}
