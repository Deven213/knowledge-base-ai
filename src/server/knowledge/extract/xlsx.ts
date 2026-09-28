import "server-only";
import { normalizeText } from "./normalize";
import { attr, decodeXml, openOoxml, readPart, textRuns } from "./ooxml";
import { ExtractionError, type ExtractedDocument, type ExtractedPage } from "./types";

const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLUMNS = 200;
const MAX_CHARS = 2_000_000;

/** Column letters ("A", "AB") → zero-based index. */
function columnIndex(ref: string | null): number | null {
  const letters = ref ? /^([A-Z]+)/.exec(ref)?.[1] : undefined;
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]!));
}

function cellValue(attrs: string, inner: string, shared: string[]): string {
  const type = attr(attrs, "t");
  if (type === "inlineStr") return textRuns(inner);
  const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return "";
  const value = decodeXml(raw);
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  return value; // numbers, formula results ("str"), errors ("e")
}

function sheetText(xml: string, shared: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    if (lines.length >= MAX_ROWS_PER_SHEET) break;
    const cells: string[] = [];
    let next = 0;
    for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = columnIndex(attr(c[1]!, "r")) ?? next;
      if (col >= MAX_COLUMNS) break;
      while (cells.length < col) cells.push("");
      cells[col] = cellValue(c[1]!, c[2] ?? "", shared).replace(/\s+/g, " ").trim();
      next = col + 1;
    }
    if (cells.some((v) => v !== "")) lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

/** Excel workbook → one text block per sheet ("Sheet: Name" followed by pipe-separated rows). */
export async function extractXlsx(buffer: Buffer): Promise<ExtractedDocument> {
  const zip = await openOoxml(buffer, "xl/workbook.xml", "Excel workbook");
  const shared = parseSharedStrings(await readPart(zip, "xl/sharedStrings.xml"));
  const workbook = (await readPart(zip, "xl/workbook.xml")) ?? "";
  const rels = (await readPart(zip, "xl/_rels/workbook.xml.rels")) ?? "";

  const targets = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }

  const pages: ExtractedPage[] = [];
  let chars = 0;
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], "name") ?? `Sheet ${pages.length + 1}`;
    const path = targets.get(attr(m[0], "r:id") ?? "");
    const xml = path ? await readPart(zip, path) : null;
    if (!xml) continue;
    const text = normalizeText(sheetText(xml, shared));
    if (!text) continue;
    pages.push({ pageNumber: null, text: `Sheet: ${name}\n${text}` });
    chars += text.length;
    if (chars > MAX_CHARS) break;
  }

  if (pages.length === 0) throw new ExtractionError("This Excel workbook contains no text or numbers.");
  return {
    kind: "xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pageCount: null,
    pages,
  };
}
