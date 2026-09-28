// Answer languages offered in chat. To add one, append an entry: the code is stored with
// answers, `promptName` is what the model is asked to write in, and `notFound` is shown when
// nothing relevant is retrieved (no model call is made in that case, so it can't be generated).

/** Fixed labels inside an answer card, shown in the answer's language (the content itself comes from the model). */
export interface AnswerUIText {
  overview: string;
  sources: string;
  source: string;
  callouts: { info: string; important: string; warning: string; critical: string; quote: string };
}

export interface AnswerLanguage {
  code: string;
  /** Compact label for the per-response language switch (EN / हिन्दी / ગુજરાતી). */
  shortLabel: string;
  ui: AnswerUIText;
  /** English name, shown in the selector. */
  label: string;
  /** The language's own name, shown alongside the label. */
  nativeName: string;
  /** BCP-47 tag for the rendered answer (`lang` attribute: correct fonts, shaping, screen readers). */
  htmlLang: string;
  /** Name used in the model instruction. */
  promptName: string;
  notFound: string;
}

export const LANGUAGES: readonly AnswerLanguage[] = [
  {
    code: "en",
    shortLabel: "EN",
    ui: {
      overview: "Overview",
      sources: "Sources",
      source: "Source",
      callouts: { info: "Note", important: "Important", warning: "Warning", critical: "Red flag", quote: "What to say" },
    },
    label: "English",
    nativeName: "English",
    htmlLang: "en",
    promptName: "English",
    notFound: "I couldn't find this information in the available documents.",
  },
  {
    code: "hi",
    shortLabel: "हिन्दी",
    ui: {
      overview: "सारांश",
      sources: "स्रोत",
      source: "स्रोत",
      callouts: { info: "जानकारी", important: "महत्वपूर्ण", warning: "चेतावनी", critical: "गंभीर चेतावनी", quote: "क्या कहें" },
    },
    label: "Hindi",
    nativeName: "हिन्दी",
    htmlLang: "hi",
    promptName: "Hindi (हिन्दी, Devanagari script)",
    notFound: "मुझे यह जानकारी उपलब्ध दस्तावेज़ों में नहीं मिली।",
  },
  {
    code: "gu",
    shortLabel: "ગુજરાતી",
    ui: {
      overview: "સારાંશ",
      sources: "સ્રોતો",
      source: "સ્રોત",
      callouts: { info: "માહિતી", important: "મહત્વપૂર્ણ", warning: "ચેતવણી", critical: "ગંભીર ચેતવણી", quote: "શું કહેવું" },
    },
    label: "Gujarati",
    nativeName: "ગુજરાતી",
    htmlLang: "gu",
    promptName: "Gujarati (ગુજરાતી, Gujarati script)",
    notFound: "મને આ માહિતી ઉપલબ્ધ દસ્તાવેજોમાં મળી નથી.",
  },
];

export const DEFAULT_LANGUAGE = "en";
export const LANGUAGE_CODES = LANGUAGES.map((l) => l.code) as [string, ...string[]];

export function getLanguage(code: string | null | undefined): AnswerLanguage {
  return LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]!;
}
