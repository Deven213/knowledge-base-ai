import { Bot, ChevronDown, FileText, Info, Paperclip, ArrowUp, BookOpenText } from "lucide-react";
import { BRAND } from "@/lib/brand";

/**
 * A static picture of the real chat screen (same header, "Chat with" selector, answer card, language
 * switch, tabs and source chips), so visitors see the product they will enter. Illustrative only.
 */
export function ProductPreview() {
  return (
    <figure aria-label={`Preview of the ${BRAND.name} chat`} className="relative">
      <div aria-hidden className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_center,rgba(20,163,139,0.22),transparent_65%)] blur-2xl" />
      <div aria-hidden className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl shadow-slate-900/15">
        {/* App bar */}
        <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
          <div className="brand-gradient flex h-6 w-6 items-center justify-center rounded-md text-white">
            <BookOpenText className="h-3.5 w-3.5" />
          </div>
          <span className="hidden text-xs font-medium text-slate-400 sm:inline">Chat with:</span>
          <span className="flex min-w-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1">
            <span className="flex h-4.5 w-4.5 items-center justify-center rounded bg-orange-50 text-orange-600">
              <FileText className="h-3 w-3" />
            </span>
            <span className="truncate text-xs font-semibold text-slate-800">Metformin.pdf</span>
            <ChevronDown className="h-3 w-3 text-slate-400" />
          </span>
          <span className="ml-auto hidden items-center gap-1 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-600 sm:flex">
            <Bot className="h-3 w-3" /> <span className="text-slate-400">Model:</span> Google Gemini
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          </span>
        </div>
        <div className="flex items-center gap-1.5 border-b border-slate-100 bg-slate-50 px-3 py-1 text-[10px] text-slate-500">
          <Info className="h-3 w-3 text-blue-500" /> You are chatting with: <b className="text-slate-700">Metformin.pdf</b>
        </div>

        <div className="space-y-3 p-3 sm:p-4">
          {/* Question */}
          <div className="flex justify-end">
            <p className="max-w-[80%] rounded-2xl rounded-tr-sm bg-blue-600 px-3 py-2 text-xs text-white shadow-sm">What are the common side effects?</p>
          </div>

          {/* Answer card */}
          <div className="rounded-xl border border-navy-700 bg-navy-950 px-3 pb-3 text-slate-100 shadow-lg">
            <div className="flex items-start gap-2 pt-3">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-teal-400 to-emerald-500 text-navy-950">
                <BookOpenText className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[8px] font-semibold tracking-[0.14em] text-teal-300 uppercase">Knowledge Base answer</p>
                <p className="text-sm leading-snug font-bold text-white">Common Side Effects</p>
              </div>
              <div className="flex shrink-0 rounded-full border border-navy-600 bg-navy-900 p-0.5 text-[9px] font-semibold">
                <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-navy-950">EN</span>
                <span className="px-1.5 py-0.5 text-slate-300">हिन्दी</span>
                <span className="hidden px-1.5 py-0.5 text-slate-300 sm:inline">ગુજરાતી</span>
              </div>
            </div>
            <div className="mt-2 flex gap-1 overflow-hidden border-b border-navy-700 pb-2">
              {["Overview", "Side effects", "Taking it", "Important"].map((t, i) => (
                <span
                  key={t}
                  className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold ${i === 1 ? "border-orange-400 bg-orange-500/15 text-orange-200" : "border-navy-600 text-slate-300"}`}
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-2 rounded-lg border border-navy-700 bg-navy-850 p-2.5">
              <p className="flex items-center gap-2 text-xs font-semibold text-white">
                <span className="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-orange-500 text-[9px] font-bold text-navy-950">1</span>
                Most common reactions
              </p>
              <ul className="mt-1.5 space-y-1 pl-6.5 text-[11px] text-slate-200">
                {["Diarrhea", "Nausea", "Stomach upset"].map((b) => (
                  <li key={b} className="flex items-center gap-1.5">
                    <span className="h-1 w-1 rounded-full bg-orange-400" /> {b}
                  </li>
                ))}
              </ul>
              <div className="mt-2 ml-6.5 rounded-md border border-orange-400/35 bg-orange-400/[0.08] px-2 py-1 text-[10px] text-orange-50">
                <span className="font-bold tracking-wider text-orange-300 uppercase">Important · </span>
                Take with food to reduce stomach upset.
              </div>
              <p className="mt-2 ml-6.5 inline-flex items-center gap-1 rounded-full border border-navy-600 bg-navy-800 px-2 py-0.5 text-[9px] text-slate-300">
                <FileText className="h-2.5 w-2.5" /> Metformin.pdf — Page 6
              </p>
            </div>
          </div>

          {/* Composer */}
          <div className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-sm">
            <Paperclip className="h-3.5 w-3.5 text-slate-400" />
            <span className="flex-1 text-[11px] text-slate-400">Ask about Metformin.pdf…</span>
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-slate-500">
              <ArrowUp className="h-3 w-3" />
            </span>
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-slate-400">The chat you get after signing in: grounded answers with page-level sources.</figcaption>
    </figure>
  );
}
