import "server-only";
import type { AIResponse } from "@/lib/ai-response";
import { getLanguage, type AnswerLanguage } from "@/lib/languages";
import type { CitationDTO, MessageDTO, ProviderId } from "@/lib/types";
import type { AnswerVariant, ConversationRepository, MessageRow } from "../db/repositories";
import { toMessageDTO } from "../dto";
import type { ProviderConfigService } from "../llm/resolve";
import { LLMError, type LLMProvider } from "../llm/types";
import { generateGroundedAnswer, KNOWLEDGE_BASE_DISABLED_ANSWER, requireProviderAuth, type AnswerContext } from "./answer";
import type { SourceChunk } from "./citations";
import { buildSources, structuredToText } from "./structured";
import { applyText, extractText, scriptProblem, sourceHash, TRANSLATION_VERSION, translateStrings, TranslationRejectedError } from "./translation";

export interface AnswerLanguageDeps {
  conversations: ConversationRepository;
  providerConfig: Pick<ProviderConfigService, "resolve" | "activeProvider">;
  getProvider: (id: ProviderId) => LLMProvider;
}

export class MessageNotFoundError extends Error {}

function parse<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ── Several requests for one answer ──
// A person can pick another language while one is still being translated. The language chosen LAST is the one that may
// be shown: an older translation that finishes late is kept (it is saved, so switching to it later is instant) but never
// replaces a newer choice. (Recorded only after the caller's own lookup of the message succeeded, so nobody else can
// disturb it.)
const chosenLast = new Map<string, string>();

function choose(messageId: string, language: string): void {
  chosenLast.delete(messageId); // re-insert at the end, so the map stays in order of recent use
  chosenLast.set(messageId, language);
  if (chosenLast.size > 2000) chosenLast.delete(chosenLast.keys().next().value!); // bounded: the oldest entries are long finished
}

// The same translation asked for twice at once (a double click, two tabs) is made once. The model call is only cancelled
// when every request waiting for it has gone. Keys hold the message id, which is only reachable after the caller's own
// conversation lookup succeeded, so nothing is shared between users or organizations.
interface Flight {
  promise: Promise<AnswerVariant>;
  controller: AbortController;
  waiters: number;
}
const flights = new Map<string, Flight>();

function coalesced(key: string, make: (signal: AbortSignal) => Promise<AnswerVariant>, signal?: AbortSignal): Promise<AnswerVariant> {
  let flight = flights.get(key);
  if (!flight || flight.controller.signal.aborted) {
    const controller = new AbortController();
    const created: Flight = { controller, waiters: 0, promise: undefined as unknown as Promise<AnswerVariant> };
    created.promise = make(controller.signal).finally(() => {
      if (flights.get(key) === created) flights.delete(key);
    });
    created.promise.catch(() => undefined); // each waiter handles the outcome itself; this only keeps a flight nobody waits for from being "unhandled"
    flights.set(key, created);
    flight = created;
  }
  const mine = flight;
  mine.waiters++;
  return new Promise<AnswerVariant>((resolve, reject) => {
    const leave = () => {
      if (--mine.waiters === 0) mine.controller.abort();
    };
    const onAbort = () => {
      leave();
      reject(new LLMError("cancelled", "The request was cancelled."));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    mine.promise.then(
      (variant) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(variant);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ── The answer being translated ──

/** The language the answer was FIRST given in: it is the one translations are made from, so they never compound. */
function originalLanguage(variants: Record<string, AnswerVariant>, shown: string): string {
  return Object.entries(variants).find(([, v]) => v.meta?.method === "original")?.[0] ?? Object.keys(variants)[0] ?? shown;
}

/**
 * A saved version is reused only if it is really the language it is filed under (its text is written in that language's
 * script: a "Gujarati" version that is Hindi is not reused) and it is still what it was made from (same original text, same
 * translation logic).
 */
function stillValid(variant: AnswerVariant | undefined, hash: string, language: AnswerLanguage): variant is AnswerVariant {
  if (!variant) return false;
  if (scriptProblem(variant.structured ? extractText(variant.structured) : [variant.content], language.script)) return false;
  const meta = variant.meta;
  if (!meta || meta.method === "original" || meta.method === "fixed") return true; // saved before meta existed, or never derived from text
  return meta.version === TRANSLATION_VERSION && meta.sourceHash === hash;
}

/** The text a translation starts from: the structured answer, or the plain text of an older or unstructured one. */
const textOf = (original: AnswerVariant): string[] => (original.structured ? extractText(original.structured) : [original.content]);

/**
 * The grounding for an answer. Messages saved before snapshots existed fall back to their stored
 * citation excerpts (shorter, but still the same passages) and the preceding user question.
 */
function contextOf(deps: AnswerLanguageDeps, row: MessageRow, citations: CitationDTO[]): AnswerContext {
  const saved = parse<AnswerContext>(row.context_json);
  if (saved?.question && Array.isArray(saved.sources)) return saved;
  const sources: SourceChunk[] = citations.map((c) => ({
    source: c.source ?? "knowledge_base",
    documentId: c.documentId,
    filename: c.filename,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    content: c.excerpt,
    score: c.score,
  }));
  return { question: deps.conversations.questionFor(row)?.content ?? "", sources, imageNames: [] };
}

/**
 * Shows an assistant answer in another language, updating the SAME message in place.
 * - Nothing is retrieved or searched, and the question is not answered again: the existing answer is TRANSLATED (only its
 *   text goes to the model, as a short list of strings, which is checked before use). Sources, source numbers and the
 *   structure of the answer (sections, kinds, callout types, steps) are never sent and never change.
 * - Translations are always made from the original answer, never from another translation.
 * - Every version is saved with what it was made from, so switching back (or to a language done before) is instant and
 *   free, and a version is redone only if the original text or the translation logic changed.
 * - Only the language chosen last decides what is shown; an older one that finishes late is just saved.
 */
export async function setAnswerLanguage(deps: AnswerLanguageDeps, messageId: string, languageCode: string, signal?: AbortSignal): Promise<MessageDTO> {
  if (signal?.aborted) throw new LLMError("cancelled", "The request was cancelled.");
  const row = deps.conversations.getMessage(messageId); // scoped to the caller's own conversations
  if (!row || row.role !== "assistant") throw new MessageNotFoundError("Message not found.");

  const target = getLanguage(languageCode);
  choose(messageId, target.code); // even choosing the language already shown ends an older request's right to change it
  const current = toMessageDTO(row);
  if (current.language === target.code) return current;

  const saved = parse<Record<string, AnswerVariant>>(row.variants_json) ?? {};
  const originalCode = originalLanguage(saved, current.language);
  const original: AnswerVariant = saved[originalCode] ?? { content: row.content, structured: current.structured, provider: row.provider, model: row.model };
  const now = new Date().toISOString();
  if (!saved[originalCode]) deps.conversations.saveVariants(messageId, { [originalCode]: { ...original, meta: { method: "original", at: now } } }, "add-missing");

  // Answers where nothing was found (no model call was made) have a fixed message per language.
  const strings = row.no_context === 1 ? [] : textOf(original);
  const hash = sourceHash(strings);
  if (!stillValid(saved[target.code], hash, target)) {
    const variant =
      row.no_context === 1
        ? fixedVariant(row, target, now)
        : await coalesced(`${messageId}:${target.code}:${hash}`, (flightSignal) => produce(deps, row, current, original, target, strings, hash, flightSignal), signal);
    deps.conversations.saveVariants(messageId, { [target.code]: variant });
  }

  if (chosenLast.get(messageId) !== target.code) return toMessageDTO(deps.conversations.getMessage(messageId)!); // another language was chosen meanwhile
  return toMessageDTO(deps.conversations.selectVariant(messageId, target.code));
}

function fixedVariant(row: MessageRow, language: AnswerLanguage, at: string): AnswerVariant {
  const content = row.content === KNOWLEDGE_BASE_DISABLED_ANSWER ? KNOWLEDGE_BASE_DISABLED_ANSWER : language.notFound;
  const structured: AIResponse = { found: false, summary: content, sections: [], sources: [], language: language.code };
  return { content, structured, provider: row.provider, model: row.model, meta: { method: "fixed", at } };
}

/** One translation: a single short model call. Only if the model's output fails the checks twice is the answer re-made the old, slower way. */
async function produce(
  deps: AnswerLanguageDeps,
  row: MessageRow,
  current: MessageDTO,
  original: AnswerVariant,
  target: AnswerLanguage,
  strings: string[],
  hash: string,
  signal: AbortSignal,
): Promise<AnswerVariant> {
  const providerId = deps.providerConfig.activeProvider();
  const auth = requireProviderAuth(deps, providerId);
  const at = new Date().toISOString();
  const meta = (method: "translation" | "regeneration") => ({ method, version: TRANSLATION_VERSION, sourceHash: hash, at });

  try {
    const translated = await translateStrings(deps.getProvider(providerId), auth, target, strings, signal);
    if (!original.structured) return { content: translated[0]!, structured: null, provider: providerId, model: auth.model, meta: meta("translation") };
    const structured = applyText(original.structured, translated, target.code); // sources and structure are the original's, untouched
    return { content: structuredToText(structured), structured, provider: providerId, model: auth.model, meta: meta("translation") };
  } catch (err) {
    if (!(err instanceof TranslationRejectedError)) throw err;
  }

  // Fallback: re-answer from the exact passages the answer was grounded in, with the original as the reference.
  const context = contextOf(deps, row, current.citations);
  const reference = original.structured ? JSON.stringify({ title: original.structured.title, summary: original.structured.summary, sections: original.structured.sections }) : original.content;
  const generated = await generateGroundedAnswer(deps.getProvider(providerId), auth, {
    question: context.question,
    sources: context.sources,
    imageNames: context.imageNames,
    language: target,
    reference,
    signal,
  });
  const structured = generated.structured ? { ...generated.structured, sources: generated.structured.found ? buildSources(current.citations) : [] } : null;
  const wrongScript = scriptProblem(structured ? extractText(structured) : [generated.answer], target.script);
  if (wrongScript) throw new TranslationRejectedError(`The AI did not return a reliable ${target.label} translation (${wrongScript}). Your answer is unchanged: please try again.`);
  return { content: generated.answer, structured, provider: providerId, model: auth.model, meta: meta("regeneration") };
}
