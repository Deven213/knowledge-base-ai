"use client";

import type { ReactNode } from "react";
import { BookOpenText } from "lucide-react";

/** Compact answer header: a small icon, the answer's own title on one or two lines, and the response's controls (language). */
export function ResponseHeader({ title, lang, actions }: { title: string | undefined; lang: string; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-2 sm:px-5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700 ring-1 ring-brand-500/20" aria-hidden>
        <BookOpenText className="h-4 w-4" />
      </div>
      <h3 lang={title ? lang : undefined} className="min-w-0 flex-1 basis-40 text-base leading-snug font-semibold text-slate-900">
        {title || "Knowledge Base"}
      </h3>
      {actions && <div className="ml-auto shrink-0">{actions}</div>}
    </header>
  );
}
