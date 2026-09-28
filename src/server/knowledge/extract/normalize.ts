/**
 * Cleans extracted text while keeping paragraph structure:
 * unifies newlines, strips control characters, collapses runs of spaces,
 * re-joins words hyphenated across line breaks, and limits blank lines to one.
 */
export function normalizeText(input: string): string {
  return input
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/(\w)-\n(\w)/g, "$1$2")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
