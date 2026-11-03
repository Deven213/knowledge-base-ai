import type { AIResponse } from "./ai-response";

// What "Listen" reads aloud: the answer itself (title, summary, sections, callouts) in the
// response's current language — never the user's question, source numbers or markup.

/** Removes [n] source markers, **emphasis**, `code` ticks and leftover markdown symbols. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const sentence = (s: string) => {
  const t = cleanForSpeech(s);
  return t && !/[.!?।:]$/.test(t) ? `${t}.` : t;
};

/** Speech text for an answer: structured parts in reading order, or the plain answer text. */
export function speechTextForAnswer(structured: AIResponse | null, plainText: string): string {
  if (!structured) {
    // Drop "Sources: [1][2]" lines that only make sense on screen.
    return cleanForSpeech(plainText.replace(/^\s*Sources?:.*$/gim, ""));
  }
  const parts: string[] = [];
  if (structured.title) parts.push(sentence(structured.title));
  if (structured.summary) parts.push(sentence(structured.summary));
  for (const s of structured.sections) {
    parts.push(sentence(s.title));
    if (s.content) parts.push(sentence(s.content));
    for (const b of s.bullets ?? []) parts.push(sentence(b));
    if (s.table) {
      for (const row of s.table.rows) parts.push(sentence(row.map((cell, i) => `${s.table!.headers[i] ?? ""} ${cell}`.trim()).join(", ")));
    }
    if (s.callout) parts.push(sentence(s.callout.text));
  }
  return parts.filter(Boolean).join("\n");
}
