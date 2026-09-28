import "server-only";
import JSZip from "jszip";
import { ExtractionError } from "./types";

// Office Open XML (DOCX/XLSX/PPTX) files are ZIP archives of XML parts.

/** Refuse archives that would expand to more than this (protects against "zip bombs"). */
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * Opens an OOXML archive and confirms it really is the expected format by checking for its
 * main part (e.g. xl/workbook.xml), so a renamed ZIP or a different Office type is rejected.
 */
export async function openOoxml(buffer: Buffer, requiredPart: string, formatName: string): Promise<JSZip> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new ExtractionError(`Could not open this file as a ${formatName}. It may be corrupted.`);
  }
  if (!zip.file(requiredPart)) {
    throw new ExtractionError(`This file is not a valid ${formatName}.`);
  }

  let total = 0;
  zip.forEach((_path, entry) => {
    // `_data` is JSZip's (untyped) record of the central directory sizes.
    total += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
  });
  if (total > MAX_UNCOMPRESSED_BYTES) {
    throw new ExtractionError(`This ${formatName} is too large to process once uncompressed.`);
  }
  return zip;
}

export async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  return entry ? entry.async("string") : null;
}

export function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, "&");
}

function safeCodePoint(cp: number): string {
  return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
}

export function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : null;
}

/** Concatenates every <t>…</t> (or <a:t>…</a:t>) text run inside an XML fragment. */
export function textRuns(xml: string, tag = "t"): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let out = "";
  for (const m of xml.matchAll(re)) out += decodeXml(m[1]!);
  return out;
}
