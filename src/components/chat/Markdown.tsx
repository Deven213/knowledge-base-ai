"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe Markdown for model answers: paragraphs, bullet/numbered lists,
 * headings, **bold**, *italic*, `code`, and [n] citation markers. No raw HTML is ever rendered.
 */

// **bold** first, then *italic* (the asterisks must hug the text, so "5 * 3 * 2" stays as typed), code, and [n] markers.
const INLINE = /(\*\*[^*]+\*\*|\*(?!\s)[^*\n]+?(?<!\s)\*|`[^`]+`|\[\d+(?:\s*[,–-]\s*\d+)*\])/g;

function citationNumbers(marker: string, max: number): number[] {
  return marker
    .slice(1, -1)
    .split(/\s*,\s*/)
    .flatMap((part) => {
      const [a, b = a] = part.split(/\s*[–-]\s*/).map(Number);
      const out: number[] = [];
      for (let n = a!; n <= Math.min(b!, max); n++) if (n >= 1) out.push(n);
      return out;
    });
}

interface InlineOptions {
  titleFor?: (n: number) => string;
  /** Short visible label for a citation (e.g. "p. 6") instead of its number. */
  labelFor?: (n: number) => string;
  /**
   * The text sits in an italic block (the clinical note). Values and drug names in **bold** then stand upright, and
   * *emphasis* reverts to upright too (the usual typographic rule), so they stay easy to find.
   */
  italicContext?: boolean;
}

const CITATION_STYLE = "bg-brand-50 text-brand-700 ring-1 ring-brand-500/30 hover:bg-brand-100";

function renderInline(text: string, maxCitation: number, onCite: (n: number) => void, opts: InlineOptions = {}): ReactNode[] {
  const { titleFor, labelFor, italicContext = false } = opts;
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={i} className={italicContext ? "font-semibold text-slate-950 not-italic" : "font-semibold"}>
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*") && !part.startsWith("**")) {
      return (
        <em key={i} className={italicContext ? "font-medium not-italic" : undefined}>
          {part.slice(1, -1)}
        </em>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (/^\[\d/.test(part)) {
      const nums = citationNumbers(part, maxCitation);
      if (nums.length === 0) return <Fragment key={i}>{part}</Fragment>;
      return (
        <span key={i} className="whitespace-nowrap">
          {nums.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onCite(n)}
              title={titleFor?.(n)}
              aria-label={titleFor ? `Source ${n}: ${titleFor(n)}` : `Show source ${n}`}
              className={`mx-0.5 inline-flex h-[18px] min-w-[18px] -translate-y-px items-center justify-center rounded px-1 align-middle text-[11px] font-semibold whitespace-nowrap not-italic ${CITATION_STYLE}`}
            >
              {labelFor?.(n) || n}
            </button>
          ))}
        </span>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

type Block = { type: "p"; lines: string[] } | { type: "ul" | "ol"; items: string[] } | { type: "h"; text: string };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const last = blocks.at(-1);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);

    if (!line.trim()) {
      blocks.push({ type: "p", lines: [] }); // paragraph break
    } else if (heading) {
      blocks.push({ type: "h", text: heading[1]! });
    } else if (bullet) {
      if (last?.type === "ul") last.items.push(bullet[1]!);
      else blocks.push({ type: "ul", items: [bullet[1]!] });
    } else if (numbered) {
      if (last?.type === "ol") last.items.push(numbered[1]!);
      else blocks.push({ type: "ol", items: [numbered[1]!] });
    } else if ((last?.type === "ul" || last?.type === "ol") && /^\s{2,}/.test(raw)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`; // wrapped list item
    } else if (last?.type === "p" && last.lines.length > 0) {
      last.lines.push(line);
    } else {
      blocks.push({ type: "p", lines: [line] });
    }
  }
  return blocks.filter((b) => b.type !== "p" || b.lines.length > 0);
}

export function Markdown({ text, maxCitation, onCite }: { text: string; maxCitation: number; onCite: (n: number) => void }) {
  return (
    <div className="prose-answer text-[15px] leading-relaxed">
      {parseBlocks(text).map((block, i) => {
        switch (block.type) {
          case "h":
            return <h3 key={i}>{renderInline(block.text, maxCitation, onCite)}</h3>;
          case "ul":
          case "ol": {
            const List = block.type;
            return (
              <List key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{renderInline(item, maxCitation, onCite)}</li>
                ))}
              </List>
            );
          }
          case "p":
            return (
              <p key={i}>
                {block.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {renderInline(l, maxCitation, onCite)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}

/** One line/paragraph of model text with **bold**, `code` and clickable [n] citation badges. */
export function InlineText({
  text,
  maxCitation,
  onCite,
  ...opts
}: {
  text: string;
  maxCitation: number;
  onCite: (n: number) => void;
} & InlineOptions) {
  return <>{renderInline(text, maxCitation, onCite, opts)}</>;
}
