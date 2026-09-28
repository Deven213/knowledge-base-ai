import "server-only";
import type { LLMProvider } from "../llm/types";

// The embedding model (bge-small-en) only understands English, so a question typed in Hindi or
// Gujarati would not match English document chunks. Before retrieval, such questions are turned
// into an English search query. Retrieval itself is unchanged; the answer is still written in the
// selected language, and the model still sees the user's original question.

/**
 * True when a meaningful share of the words are written in a non-Latin script (e.g. Devanagari,
 * Gujarati), including mixed questions like "metformin क्या है". Counted per word because Indic
 * vowel signs are not letters, which would under-count those scripts.
 */
export function needsEnglishSearchQuery(text: string): boolean {
  const words = text.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length === 0) return false;
  const nonLatin = words.filter((w) => /[\p{L}\p{M}]/u.test(w.replace(/[\p{Script=Latin}\p{N}\p{P}\p{S}]/gu, ""))).length;
  return nonLatin / words.length >= 0.3;
}

const SYSTEM = `You convert a user's question into a short English search query for an English document index.
Translate the meaning faithfully. Keep drug names, product names, codes and numbers exactly.
Output only the English query text, nothing else.`;

/** English search query for retrieval; falls back to the original question if anything goes wrong. */
export async function toEnglishSearchQuery(
  provider: LLMProvider,
  opts: { model: string; apiKey: string; signal?: AbortSignal },
  question: string,
): Promise<string> {
  try {
    const { text } = await provider.generate({ system: SYSTEM, content: [{ type: "text", text: question }], ...opts });
    const query = text.split("\n").map((l) => l.trim()).find(Boolean)?.replace(/^["'“”]+|["'“”]+$/g, "");
    return query && query.length <= 500 ? query : question;
  } catch (err) {
    // Provider errors are already redacted by the adapter; the question itself is not logged.
    console.warn("[rag] English search query failed; retrieving with the original question:", err instanceof Error ? err.message : err);
    return question;
  }
}
