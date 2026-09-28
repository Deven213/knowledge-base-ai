import "server-only";
import { HTMLElement, NodeType, parse, type Node } from "node-html-parser";

// Readable text from an HTML page: the main content without navigation, scripts or boilerplate,
// with paragraphs, headings and list items kept on separate lines for good chunking.

const REMOVE = "script, style, noscript, template, svg, canvas, iframe, object, embed, form, button, select, [hidden], [aria-hidden=true]";
const BOILERPLATE = "nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]";
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dt", "dd",
  "table", "tr", "blockquote", "pre", "figure", "figcaption", "address", "hr", "br", "summary", "details",
]);

export interface ParsedPage {
  title: string;
  text: string;
  /** All link targets on the page (raw href values). */
  links: string[];
}

function toText(node: Node, out: string[]): void {
  if (node.nodeType === NodeType.TEXT_NODE) {
    out.push(node.text);
    return;
  }
  if (!(node instanceof HTMLElement)) return;
  const tag = node.tagName?.toLowerCase() ?? "";
  if (tag === "br") {
    out.push("\n");
    return;
  }
  const block = BLOCK.has(tag);
  if (block) out.push("\n");
  if (tag === "li") out.push("- ");
  if (/^h[1-6]$/.test(tag)) out.push("\n");
  for (const child of node.childNodes) toText(child, out);
  if (tag === "td" || tag === "th") out.push(" | ");
  if (block) out.push("\n");
}

export function parseHtmlPage(html: string): ParsedPage {
  const root = parse(html, { comment: false });
  const links = root.querySelectorAll("a[href]").map((a) => a.getAttribute("href") ?? "").filter(Boolean);

  const title =
    root.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    root.querySelector("title")?.text.trim() ||
    root.querySelector("h1")?.text.trim() ||
    "";

  for (const el of root.querySelectorAll(REMOVE)) el.remove();
  const main = root.querySelector("main") ?? root.querySelector("article") ?? root.querySelector("[role=main]") ?? root.querySelector("body") ?? root;
  // Boilerplate is dropped only when we fell back to the whole page (a <main> is already content).
  if (main.tagName?.toLowerCase() === "body" || main === root) for (const el of main.querySelectorAll(BOILERPLATE)) el.remove();

  const parts: string[] = [];
  toText(main, parts);
  const text = parts
    .join("")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { title: title.replace(/\s+/g, " ").slice(0, 200), text, links };
}
