"use client";

import { Cloud, FileText, Globe, HardDrive, Paperclip, type LucideIcon } from "lucide-react";
import type { AISource } from "@/lib/ai-response";
import type { CitationDTO } from "@/lib/types";

// Friendly source labels ("Metformin.pdf — Page 6", "quotes.toscrape.com /tag/love") built from the
// existing citations. The [n] mapping underneath is unchanged.

export function pageLabel(pageStart: number | null, pageEnd: number | null): string | null {
  if (pageStart === null) return null;
  return pageEnd !== null && pageEnd !== pageStart ? `Pages ${pageStart}–${pageEnd}` : `Page ${pageStart}`;
}

type SourceKind = "website" | "google_drive" | "onedrive" | "attachment" | "document";

export interface SourceDisplay {
  kind: SourceKind;
  /** Document name, website domain or drive name. */
  title: string;
  /** Page(s), web page path or file name. */
  detail: string | null;
}

/** How to show one citation (or source card) to a person. */
export function describeCitation(c: Pick<CitationDTO, "filename" | "pageStart" | "pageEnd" | "source" | "sourceType" | "sourceUrl">): SourceDisplay {
  const pages = pageLabel(c.pageStart, c.pageEnd);
  if (c.source === "attachment") return { kind: "attachment", title: c.filename, detail: pages ?? "Attached to this message" };
  if (c.sourceType === "website" && c.sourceUrl) {
    try {
      const u = new URL(c.sourceUrl);
      const path = `${u.pathname}${u.search}`;
      return { kind: "website", title: u.hostname.replace(/^www\./, ""), detail: path === "/" ? "Home page" : path };
    } catch {
      /* fall through to the document name */
    }
  }
  if (c.sourceType === "google_drive" || c.sourceType === "onedrive") {
    return { kind: c.sourceType, title: c.sourceType === "google_drive" ? "Google Drive" : "OneDrive", detail: pages ? `${c.filename} · ${pages}` : c.filename };
  }
  return { kind: "document", title: c.filename, detail: pages };
}

/** "Metformin.pdf — Page 6" for a citation (tooltips, chips). */
export function citationLabel(c: CitationDTO | undefined): string {
  if (!c) return "";
  const d = describeCitation(c);
  return d.detail ? `${d.title} — ${d.detail}` : d.title;
}

/** Very short inline label for a citation marker: "p. 6", "p. 6–7", or the web page path. */
export function shortCitationLabel(c: CitationDTO | undefined): string {
  if (!c) return "";
  if (c.pageStart !== null) return c.pageEnd !== null && c.pageEnd !== c.pageStart ? `p. ${c.pageStart}–${c.pageEnd}` : `p. ${c.pageStart}`;
  const d = describeCitation(c);
  return (d.kind === "website" ? d.detail : d.title)?.slice(0, 24) ?? "";
}

const ICONS: Record<SourceKind, LucideIcon> = { website: Globe, google_drive: HardDrive, onedrive: Cloud, attachment: Paperclip, document: FileText };

/** Compact, clickable source reference used under a section. */
export function SourceChip({ citation, onClick }: { citation: CitationDTO; onClick: () => void }) {
  const d = describeCitation(citation);
  const Icon = ICONS[d.kind];
  const label = d.detail ? `${d.title} — ${d.detail}` : d.title;
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-navy-600 bg-navy-800 px-2.5 py-1 text-xs text-slate-300 transition-colors hover:border-orange-400/60 hover:text-orange-100 focus-visible:outline-2 focus-visible:outline-orange-400"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The answer's source cards (grouped by document/page), inside the same response. */
export function ResponseSources({ sources, citations, onCite }: { sources: AISource[]; citations: CitationDTO[]; onCite: (n: number) => void }) {
  if (sources.length === 0) return null;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {sources.map((s) => {
        const first = citations.find((c) => c.index === s.citationIndexes[0]);
        const d = first
          ? describeCitation(first)
          : describeCitation({ filename: s.documentName, pageStart: s.pageStart, pageEnd: s.pageEnd, source: s.origin });
        const Icon = ICONS[d.kind];
        return (
          <li key={`${s.documentId ?? s.documentName}-${s.pageStart}-${s.pageEnd}`} className="min-w-0">
            <button
              type="button"
              onClick={() => onCite(s.citationIndexes[0]!)}
              className="h-full w-full rounded-xl border border-navy-700 bg-navy-850 px-3 py-2.5 text-left transition-colors hover:border-orange-400/50 hover:bg-navy-800 focus-visible:outline-2 focus-visible:outline-orange-400"
            >
              <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                <Icon className="h-4 w-4 shrink-0 text-orange-300" aria-hidden />
                <span className="truncate">{d.title}</span>
              </p>
              {d.detail && <p className="mt-0.5 truncate text-xs text-slate-400">{d.detail}</p>}
              {s.excerpt && <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-slate-400 italic">“{s.excerpt}”</p>}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
