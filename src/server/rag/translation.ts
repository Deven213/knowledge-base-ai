import "server-only";
import { createHash } from "node:crypto";
import type { AIResponse } from "@/lib/ai-response";
import type { AnswerLanguage } from "@/lib/languages";
import type { LLMProvider, ResponseFormat } from "../llm/types";
import { textContent } from "../llm/types";
import { parseModelJson } from "./structured";

// Changing the language of an answer that already exists is TRANSLATING it, not answering the question again.
// Only the text a person reads is sent (no source passages, none of the answering rules), as a flat list of strings,
// and the same number of strings comes back. Everything that is not text (section kinds, numbered steps, callout
// types, source numbers, the sources themselves) stays exactly as it was because it never leaves the server, and every
// translated string is checked before it is used: its [n] source markers, **bold** markers and numbers must match the
// original, so a dose or a citation cannot be changed by the model without being noticed.

/**
 * Part of every saved translation. Raise it when the prompt, the checks or the way text is extracted change in a way
 * that makes earlier translations worth redoing: saved versions with another number are translated again.
 */
export const TRANSLATION_VERSION = 1;

/** The only output shape asked for: {"t": ["...", "..."]}. Portable across the providers' structured-output features. */
export const TRANSLATION_FORMAT: ResponseFormat = {
  name: "translated_strings",
  description: "The translation of each string, in the same order",
  schema: { type: "object", additionalProperties: false, required: ["t"], properties: { t: { type: "array", items: { type: "string" } } } },
};

/** Compact on purpose: everything the model needs to translate faithfully, and nothing about answering questions. */
export function translationSystemPrompt(languageName: string): string {
  return `You translate a clinical reference note into ${languageName}. The user message is a JSON array of strings (a title, a summary, headings, bullet points, table cells, notes). Return JSON {"t": [...]} with exactly the same number of strings, in the same order: string i is the translation of string i.

Rules:
- Translate only what is written. Never add, remove, soften or strengthen a fact, warning, contraindication, dose, value or condition.
- Keep every source marker such as [1] or [2, 3] exactly as written, next to the words it followed.
- Keep **double asterisks** around the translation of the words they surrounded.
- Keep all numbers written with Western digits (0-9). Keep units, symbols (< > ≥ ≤ % /), abbreviations (for example eGFR, ALT) and drug names exactly as written. Use the language's standard medical term; if none is in common use, keep the English term.
- Write in the language's own script (Devanagari for Hindi, Gujarati script for Gujarati): never in another language's script, and never as Latin transliteration.
- Keep it short and plain, like the original. No explanations and no extra text.`;
}

// ── The text of an answer ──

type Visit = (text: string) => string;

/** Strings with no letters ("≥ 60", "30–44", "") have nothing to translate and are left alone. */
const translatable = (s: string) => /\p{L}/u.test(s);

/**
 * Applies `f` to every piece of text of the answer a person reads, in a fixed order: title, summary, then each section's
 * title, tab, paragraph, bullets, table (headers then rows) and callout (label then text). Everything else is copied.
 */
function mapText(answer: AIResponse, f: Visit): AIResponse {
  const t = (s: string) => (translatable(s) ? f(s) : s);
  const o = (s: string | undefined) => (s === undefined ? undefined : t(s));
  return {
    ...answer,
    title: o(answer.title),
    summary: o(answer.summary),
    sections: answer.sections.map((s) => ({
      ...s,
      title: t(s.title),
      tab: o(s.tab),
      content: o(s.content),
      bullets: s.bullets?.map(t),
      table: s.table ? { headers: s.table.headers.map(t), rows: s.table.rows.map((row) => row.map(t)) } : undefined,
      callout: s.callout ? { ...s.callout, label: o(s.callout.label), text: t(s.callout.text) } : undefined,
    })),
  };
}

/** The strings to translate, in order. */
export function extractText(answer: AIResponse): string[] {
  const out: string[] = [];
  mapText(answer, (s) => (out.push(s), s));
  return out;
}

/** The same answer with its text replaced by `translated` (as many strings as `extractText` gave), in `language`. */
export function applyText(answer: AIResponse, translated: string[], language: string): AIResponse {
  let i = 0;
  const next = mapText(answer, () => translated[i++]!);
  if (i !== translated.length) throw new Error("The translation does not fit the answer.");
  return { ...next, language };
}

// ── Checking a translation ──

const MARKER = /\[\d+(?:\s*[,–-]\s*\d+)*\]/g;

/** Devanagari and Gujarati digits to 0-9, so a value written in them is still the same value. */
export function normalizeDigits(s: string): string {
  return s.replace(/[०-९૦-૯]/g, (d) => String(d.charCodeAt(0) - (d.charCodeAt(0) >= 0x0ae6 ? 0x0ae6 : 0x0966)));
}

const markersOf = (s: string) => (s.match(MARKER) ?? []).map((m) => m.replace(/\s+/g, "")).sort();
const numbersOf = (s: string) => (s.replace(MARKER, "").match(/\d+/g) ?? []).sort();
const boldCount = (s: string) => (s.match(/\*\*/g) ?? []).length;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export type Checked = { ok: true; strings: string[] } | { ok: false; reason: string };

// ── The script a translation is written in ──
// "Translate to Gujarati" has been answered with Hindi (the same kind of letters nearby, and Hindi was what the model had
// just seen). Numbers and markers can't show that, so the letters themselves are counted.

export type ScriptName = "latin" | "devanagari" | "gujarati";
const SCRIPT_LETTERS: Record<ScriptName, RegExp> = {
  latin: /[A-Za-z\u00C0-\u024F]/g,
  devanagari: /[\u0900-\u0963\u0966-\u097F]/g, // without the danda (। ॥), which Gujarati text may use too
  gujarati: /[\u0A80-\u0AFF]/g,
};
const SCRIPT_LABEL: Record<ScriptName, string> = { latin: "Latin (English)", devanagari: "Devanagari (Hindi)", gujarati: "Gujarati" };
const lettersOf = (text: string, script: ScriptName) => (text.match(SCRIPT_LETTERS[script]) ?? []).length;

/**
 * Null when `strings` are written in `target`'s script, otherwise what is wrong. Technical terms, drug names and
 * abbreviations may stay in Latin letters, so the test is not "all of it" but: no letters of another Indian script, most
 * letters in the target script (for Indian scripts at least a quarter, since terms stay in Latin; for English at least 60 %),
 * and every sentence-sized string (15+ Latin letters in the original) has real text in the target script.
 */
export function scriptProblem(strings: string[], target: ScriptName, original?: string[]): string | null {
  const others = (Object.keys(SCRIPT_LETTERS) as ScriptName[]).filter((s) => s !== target && s !== "latin");
  const total = (Object.keys(SCRIPT_LETTERS) as ScriptName[]).reduce((n, s) => n + strings.reduce((m, t) => m + lettersOf(t, s), 0), 0);
  if (total === 0) return null; // nothing but numbers and symbols
  for (const other of target === "latin" ? (["devanagari", "gujarati"] as const) : others) {
    const wrong = strings.reduce((n, t) => n + lettersOf(t, other), 0);
    if (wrong / total > 0.01) return `it contains ${SCRIPT_LABEL[other]} letters, but must be written in ${SCRIPT_LABEL[target]} script`;
  }
  const mine = strings.reduce((n, t) => n + lettersOf(t, target), 0);
  if (mine / total < (target === "latin" ? 0.6 : 0.25)) return `most of it is not written in ${SCRIPT_LABEL[target]} script`;
  if (target !== "latin" && original) {
    const i = strings.findIndex((t, k) => lettersOf(original[k] ?? "", "latin") >= 15 && lettersOf(t, target) < 3);
    if (i >= 0) return `string ${i + 1} is not written in ${SCRIPT_LABEL[target]} script`;
  }
  return null;
}

/**
 * A translation is usable only if it has one non-empty string for every original, with the same source markers, the same
 * bold markers and the same numbers (digits are normalized first). The reason names the first problem, for the retry.
 */
export function checkTranslation(original: string[], translated: unknown, script?: ScriptName): Checked {
  if (!Array.isArray(translated) || translated.some((t) => typeof t !== "string")) return { ok: false, reason: 'the reply must be {"t": [strings]}' };
  if (translated.length !== original.length) return { ok: false, reason: `it has ${translated.length} strings but ${original.length} were given` };
  const strings: string[] = [];
  for (let i = 0; i < original.length; i++) {
    const src = original[i]!;
    const out = normalizeDigits((translated[i] as string).trim());
    if (!out) return { ok: false, reason: `string ${i + 1} is empty` };
    if (!same(markersOf(src), markersOf(out))) return { ok: false, reason: `string ${i + 1} must keep the source markers ${markersOf(src).join(" ") || "(none)"} exactly` };
    if (boldCount(src) !== boldCount(out)) return { ok: false, reason: `string ${i + 1} must keep the ** markers` };
    if (!same(numbersOf(src), numbersOf(out))) return { ok: false, reason: `string ${i + 1} must keep exactly the numbers ${numbersOf(src).join(", ") || "(none)"}` };
    strings.push(out);
  }
  const wrongScript = script ? scriptProblem(strings, script, original) : null;
  if (wrongScript) return { ok: false, reason: wrongScript };
  return { ok: true, strings };
}

/** Identifies the original text. A saved translation is reused only while this hash and TRANSLATION_VERSION both still match. */
export function sourceHash(strings: string[]): string {
  return createHash("sha256").update(JSON.stringify(strings)).digest("hex").slice(0, 24);
}

// ── Calling the provider ──

/** The model's output could not be used even after one correction (the caller then re-answers the old, slower way). */
export class TranslationRejectedError extends Error {}

/**
 * Translates the strings with the active provider: one call, a second only if the first reply fails the checks.
 * Provider errors (rate limit, timeout, cancelled…) are thrown as they are.
 */
export async function translateStrings(
  provider: LLMProvider,
  auth: { model: string; apiKey: string },
  language: AnswerLanguage,
  strings: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  let correction = "";
  let lastReason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text } = await provider.generate({
      system: translationSystemPrompt(language.promptName) + correction,
      content: textContent(JSON.stringify(strings)),
      model: auth.model,
      apiKey: auth.apiKey,
      signal,
      responseFormat: TRANSLATION_FORMAT,
      reasoning: "minimal", // translating needs no reasoning, and reasoning is most of the waiting time (see minimalThinking in llm/gemini.ts)
    });
    const parsed = parseModelJson(text) as { t?: unknown } | null;
    const checked = checkTranslation(strings, parsed?.t, language.script);
    if (checked.ok) return checked.strings;
    lastReason = checked.reason;
    correction = `\n\nYour previous reply was rejected because ${checked.reason}. Return the complete array again with that fixed.`;
  }
  throw new TranslationRejectedError(`The AI did not return a reliable ${language.label} translation (${lastReason}). Your answer is unchanged: please try again.`);
}
