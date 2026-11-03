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

/** Compact, clickable source reference: icon, document and page. Opens the passage it came from. */
export function SourceChip({ citation, onClick }: { citation: CitationDTO; onClick: () => void }) {
  const d = describeCitation(citation);
  const Icon = ICONS[d.kind];
  const label = d.detail ? `${d.title} — ${d.detail}` : d.title;
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Show the passage: ${label}`}
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-[13px] text-slate-700 transition-colors hover:border-brand-600 hover:bg-brand-50 hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
      <span className="truncate">{label}</span>
    </button>
  );
}

/** The answer's references, one chip per document and page range, always visible. Built from retrieval, never from the model. */
export function ReferenceList({ sources, citations, onCite }: { sources: AISource[]; citations: CitationDTO[]; onCite: (n: number) => void }) {
  if (sources.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {sources.map((src) => {
        const first = citations.find((c) => c.index === src.citationIndexes[0]);
        const citation: CitationDTO = first ?? {
          index: src.citationIndexes[0] ?? 0,
          source: src.origin,
          documentId: src.documentId,
          filename: src.documentName,
          pageStart: src.pageStart,
          pageEnd: src.pageEnd,
          excerpt: src.excerpt ?? "",
          score: null,
          cited: true,
        };
        return (
          <li key={`${src.documentId ?? src.documentName}-${src.pageStart}-${src.pageEnd}`} className="min-w-0 max-w-full">
            <SourceChip citation={citation} onClick={() => onCite(src.citationIndexes[0]!)} />
          </li>
        );
      })}
    </ul>
  );
}
