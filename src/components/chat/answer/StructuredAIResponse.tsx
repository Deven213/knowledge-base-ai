"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpenText, Check, ChevronDown, Copy, RotateCcw, SearchX } from "lucide-react";
import { buildSources } from "@/lib/ai-response";
import { getLanguage } from "@/lib/languages";
import { PROVIDER_LABELS, type MessageDTO } from "@/lib/types";
import { api } from "@/lib/api";
import { InlineText, Markdown } from "../Markdown";
import { LanguageSelector } from "./LanguageSelector";
import { ResponseHeader } from "./ResponseHeader";
import { ResponseSection } from "./ResponseSection";
import { citationLabel, pageLabel, ResponseSources, shortCitationLabel } from "./ResponseSources";
import { ResponseTabs, type ResponseTab } from "./ResponseTabs";

// ONE assistant message = ONE container: header (AI icon, title, language), topic tabs, overview,
// numbered section cards with callouts, sources and retrieved passages, footer. The model only
// supplied the text; document names, pages and excerpts come from the existing citations.

function time(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Tab text when the model gave none (older answers): the section title's first words. */
function fallbackTab(title: string): string {
  const words = title.split(/\s+/);
  const short = words.slice(0, 3).join(" ");
  return short.length > 28 ? `${short.slice(0, 27)}…` : short;
}

/**
 * Scroll-spy for the tabs: the active section is the last one whose top has passed just below the
 * sticky tab bar (or the first one, before any has). Recomputed whenever a section moves across
 * the viewport, so no scroll listener is needed.
 */
function useActiveSection(ids: string[], barId: string): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join("|");

  useEffect(() => {
    const targets = key ? key.split("|") : [];
    const elements = targets.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
    if (elements.length < 2) return;
    const update = () => {
      const line = (document.getElementById(barId)?.getBoundingClientRect().bottom ?? 0) + 24;
      const passed = elements.filter((el) => el.getBoundingClientRect().top <= line);
      setActive((passed.at(-1) ?? elements[0]!).id);
    };
    const observer = new IntersectionObserver(update, { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] });
    elements.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [key, barId]);

  return [active, setActive];
}

/**
 * One assistant response. Its language can be changed on its own: the SAME message is updated in
 * place (same question, same sources); other responses are unaffected.
 */
export function StructuredAIResponse({
  message,
  onMessageUpdate,
  onLanguageChosen,
}: {
  message: MessageDTO;
  /** Receives the updated message (same id) after a language change. */
  onMessageUpdate: (updated: MessageDTO) => void;
  /** Remembers the last chosen language as the default for new answers. */
  onLanguageChosen?: (code: string) => void;
}) {
  const [showPassages, setShowPassages] = useState(false);
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ language: string; text: string } | null>(null);

  const response = message.structured;
  const { citations } = message;
  const sources = response ? response.sources : buildSources(citations);
  const language = getLanguage(message.language);
  const ui = language.ui;
  const base = `resp-${message.id}`;
  const notFound = response ? !response.found : message.noContext;

  // Tabs come from this answer's own sections (plus its overview), in the answer's language.
  const tabs: ResponseTab[] = useMemo(() => {
    if (!response || notFound) return [];
    const list: ResponseTab[] = response.summary ? [{ target: `${base}-overview`, label: ui.overview }] : [];
    response.sections.forEach((s, i) => list.push({ target: `${base}-s${i}`, label: s.tab || fallbackTab(s.title) }));
    return list;
  }, [response, notFound, base, ui.overview]);
  const [activeTab, setActiveTab] = useActiveSection(tabs.map((t) => t.target), `${base}-tabs`);

  function goTo(target: string) {
    setActiveTab(target);
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function cite(n: number) {
    setShowPassages(true);
    setHighlighted(n);
    requestAnimationFrame(() => document.getElementById(`src-${message.id}-${n}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  async function changeLanguage(code: string) {
    setBusy(code);
    setError(null);
    try {
      onMessageUpdate(await api.setMessageLanguage(message.id, code));
      onLanguageChosen?.(code);
    } catch (err) {
      setError({ language: code, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  const inline = (text: string) => (
    <InlineText
      text={text}
      maxCitation={citations.length}
      onCite={cite}
      titleFor={(n) => citationLabel(citations.find((c) => c.index === n))}
      labelFor={(n) => shortCitationLabel(citations.find((c) => c.index === n))}
      tone="dark"
    />
  );

  return (
    <article aria-label="AI response" aria-busy={!!busy} className="rounded-2xl border border-navy-700 bg-navy-950 px-4 text-slate-100 shadow-lg sm:px-6">
      <ResponseHeader
        title={response?.title}
        lang={language.htmlLang}
        eyebrow={notFound ? "AI answer · not found" : "Knowledge Base answer"}
        actions={<LanguageSelector value={message.language} onChange={(code) => void changeLanguage(code)} busy={busy} />}
      />
      {busy && (
        <p className="-mt-1 mb-2 text-xs text-orange-200" role="status">
          Updating this answer to {getLanguage(busy).nativeName}…
        </p>
      )}

      <ResponseTabs id={`${base}-tabs`} tabs={tabs} active={activeTab} onSelect={goTo} />

      {/* Content, in the response language (fixed labels follow it too) */}
      <div lang={language.htmlLang} className={`space-y-3 pt-3 pb-4 transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {response ? (
          <>
            {response.summary &&
              (notFound ? (
                <div className="flex items-start gap-2.5 rounded-xl border border-navy-700 bg-navy-900 px-4 py-3">
                  <SearchX className="mt-0.5 h-4.5 w-4.5 shrink-0 text-slate-400" aria-hidden />
                  <p className="text-[15px] leading-relaxed text-slate-200">{inline(response.summary)}</p>
                </div>
              ) : (
                <section id={`${base}-overview`} aria-label={ui.overview} className="scroll-mt-16 rounded-2xl border border-navy-700 border-l-4 border-l-orange-400 bg-navy-900 px-4 py-3 sm:px-5">
                  <p className="mb-1 text-[11px] font-bold tracking-[0.12em] text-orange-300 uppercase">{ui.overview}</p>
                  <p className="text-[15px] leading-relaxed text-slate-100">{inline(response.summary)}</p>
                </section>
              ))}
            {response.sections.map((section, i) => (
              <ResponseSection key={i} id={`${base}-s${i}`} section={section} number={i + 1} citations={citations} ui={ui} onCite={cite} />
            ))}
          </>
        ) : (
          // Plain-text answers (older messages or unstructured output) in the same container.
          <div className={`rounded-xl border border-navy-700 bg-navy-900 px-4 py-3 text-slate-200 [&_code]:bg-navy-700 [&_strong]:text-orange-200 ${notFound ? "text-slate-300" : ""}`}>
            <Markdown text={message.content} maxCitation={citations.length} onCite={cite} />
          </div>
        )}

        {/* Language change failed: shown here, the current answer stays */}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-red-500/40 bg-red-600/10 px-4 py-2.5 text-sm text-red-100">
            <span className="min-w-0 flex-1">
              Unable to generate the {getLanguage(error.language).label} response. {error.text}
            </span>
            <button
              type="button"
              onClick={() => void changeLanguage(error.language)}
              className="inline-flex items-center gap-1 rounded-full bg-orange-500 px-3 py-1 text-xs font-semibold text-navy-950 hover:bg-orange-400"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        )}
      </div>

      {/* Sources, inside the same response */}
      {(sources.length > 0 || citations.length > 0) && (
        <div className="border-t border-navy-700 py-4">
          {sources.length > 0 && (
            <>
              <h4 className="mb-2.5 flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] text-slate-400 uppercase">
                <BookOpenText className="h-3.5 w-3.5" aria-hidden /> {ui.sources}
              </h4>
              <ResponseSources sources={sources} citations={citations} onCite={cite} />
            </>
          )}
          {citations.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowPassages((s) => !s)}
                aria-expanded={showPassages}
                className="flex items-center gap-1 text-xs font-medium text-sky-300 hover:underline"
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showPassages ? "rotate-180" : ""}`} />
                {showPassages ? "Hide retrieved passages" : `Show all retrieved passages (${citations.length})`}
              </button>
              {showPassages && (
                <ul className="mt-2 space-y-2">
                  {citations.map((c) => (
                    <li
                      key={c.index}
                      id={`src-${message.id}-${c.index}`}
                      className={`rounded-lg border p-2.5 text-xs transition-colors ${
                        highlighted === c.index ? "border-orange-400/60 bg-orange-400/10" : "border-navy-700 bg-navy-900"
                      } ${c.cited ? "" : "opacity-70"}`}
                    >
                      <div className="mb-1 flex items-center gap-2">
                        <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded bg-sky-500/80 px-1 text-[11px] font-semibold text-white">
                          {c.index}
                        </span>
                        <span className="truncate font-medium text-slate-100">{c.filename}</span>
                        {pageLabel(c.pageStart, c.pageEnd) && <span className="shrink-0 text-slate-400">{pageLabel(c.pageStart, c.pageEnd)}</span>}
                        {c.source === "attachment" && (
                          <span className="shrink-0 rounded bg-violet-400/20 px-1 py-px text-[10px] font-medium text-violet-200">Attachment</span>
                        )}
                        <span className="ml-auto shrink-0 text-slate-500" title={c.score === null ? undefined : "Similarity score"}>
                          {c.cited ? "cited" : ""}
                          {c.cited && c.score !== null ? " · " : ""}
                          {c.score !== null && c.score.toFixed(2)}
                        </span>
                      </div>
                      <p className="leading-relaxed text-slate-300">{c.excerpt}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {/* Footer */}
      <footer className="-mx-4 flex items-center gap-1 rounded-b-2xl border-t border-navy-700 bg-navy-900/60 px-3 py-1.5 text-slate-500 sm:-mx-6">
        <button type="button" onClick={() => void copy()} className="rounded-md p-1.5 hover:bg-navy-700 hover:text-slate-200" aria-label="Copy answer">
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
        <span className="truncate text-[11px]">
          {message.provider ? `${PROVIDER_LABELS[message.provider]} · ${message.model} · ` : ""}
          {time(message.createdAt)}
        </span>
      </footer>
    </article>
  );
}
