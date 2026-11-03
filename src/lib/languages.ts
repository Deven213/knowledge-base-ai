// Answer languages offered in chat. To add one, append an entry: the code is stored with
// answers, `promptName` is what the model is asked to write in, and `notFound` is shown when
// nothing relevant is retrieved (no model call is made in that case, so it can't be generated).

/** Fixed labels inside an answer card, shown in the answer's language (the content itself comes from the model). */
export interface AnswerUIText {
  overview: string;
  sources: string;
  source: string;
  callouts: { info: string; important: string; warning: string; critical: string; quote: string };
  /** The clinical-note layout (see lib/clinical-note.ts). */
  note: {
    clinicalSummary: string;
    keyPoints: string;
    /** Heading of the box that holds warnings, contraindications and red flags. */
    caution: string;
    reference: string;
    moreDetails: string;
    hideDetails: string;
    /** Shown instead of the answer when the documents don't contain it. */
    notEstablished: string;
    /** Shown when an answer cites nothing, so it is not presented as source-backed. */
    noSourceCited: string;
    sourcePassages: string;
    /** One line at the foot of every answer. */
    disclaimer: string;
  };
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
  /** Italic reads well in Latin script; Devanagari and Gujarati have no italic (browsers only slant them), so they stay upright. */
  italic: boolean;
  /** The writing system of the language: a translation is checked to really be written in it (not in another language's script). */
  script: "latin" | "devanagari" | "gujarati";
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
      note: {
        clinicalSummary: "Clinical summary",
        keyPoints: "Key points",
        caution: "Important / Caution",
        reference: "Reference",
        moreDetails: "More details",
        hideDetails: "Hide details",
        notEstablished: "Not established by your documents",
        noSourceCited: "No source is cited for this answer. Verify it before relying on it.",
        sourcePassages: "Source passages",
        disclaimer: "AI-generated from your documents. Check it against the reference and use clinical judgment.",
      },
    },
    italic: true,
    script: "latin",
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
      note: {
        clinicalSummary: "नैदानिक सारांश",
        keyPoints: "मुख्य बिंदु",
        caution: "महत्वपूर्ण / सावधानी",
        reference: "संदर्भ",
        moreDetails: "अधिक विवरण",
        hideDetails: "विवरण छिपाएँ",
        notEstablished: "आपके दस्तावेज़ों में यह स्थापित नहीं है",
        noSourceCited: "इस उत्तर में कोई स्रोत उद्धृत नहीं है। भरोसा करने से पहले इसकी पुष्टि करें।",
        sourcePassages: "स्रोत अंश",
        disclaimer: "आपके दस्तावेज़ों से AI द्वारा तैयार। संदर्भ से मिलान करें और नैदानिक विवेक का उपयोग करें।",
      },
    },
    italic: false,
    script: "devanagari",
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
      note: {
        clinicalSummary: "ક્લિનિકલ સારાંશ",
        keyPoints: "મુખ્ય મુદ્દાઓ",
        caution: "મહત્વપૂર્ણ / સાવચેતી",
        reference: "સંદર્ભ",
        moreDetails: "વધુ વિગતો",
        hideDetails: "વિગતો છુપાવો",
        notEstablished: "તમારા દસ્તાવેજોમાં આ સ્થાપિત નથી",
        noSourceCited: "આ જવાબમાં કોઈ સ્રોત ટાંકેલ નથી. આધાર રાખતા પહેલાં તેની ચકાસણી કરો.",
        sourcePassages: "સ્રોત ફકરા",
        disclaimer: "તમારા દસ્તાવેજોમાંથી AI દ્વારા તૈયાર. સંદર્ભ સાથે ચકાસો અને ક્લિનિકલ વિવેકનો ઉપયોગ કરો.",
      },
    },
    italic: false,
    script: "gujarati",
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
