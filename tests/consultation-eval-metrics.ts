// Measuring a transcript against a human-checked reference, for the evaluation of real consented recordings (consultation-eval.live.test.ts).
// Nothing here talks to a provider. The measures are the ones that matter for a clinical record in Gujarati, Hindi and English:
//   - word and character error rate (how far the text is from what a person wrote down);
//   - the SCRIPT mix (a Gujarati sentence returned in Devanagari or in Latin letters is wrong even if it "sounds" right);
//   - recall of numbers and of named terms (doses, drug names): a missed or changed number is the dangerous error.

const DIGITS: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9", "૦": "0", "૧": "1", "૨": "2", "૩": "3", "૪": "4", "૫": "5", "૬": "6", "૭": "7", "૮": "8", "૯": "9" };

/** Lower-case, NFC, Devanagari/Gujarati digits as 0-9, punctuation removed (Indic combining marks kept), spaces collapsed. */
export function normalize(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[०-९૦-૯]/g, (d) => DIGITS[d]!)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s/.]/gu, " ")
    .replace(/(?<![\p{N}])[./]|[./](?![\p{N}])/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const tokens = (text: string): string[] => (normalize(text) ? normalize(text).split(" ") : []);

/** Levenshtein distance between two sequences (rolling rows, so a long consultation stays cheap in memory). */
export function editDistance<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = new Uint32Array(b.length + 1);
  let current = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

/** Share of the reference's words that are wrong, missing or extra (0 = identical; can exceed 1). */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = tokens(reference);
  return ref.length === 0 ? (tokens(hypothesis).length === 0 ? 0 : 1) : editDistance(ref, tokens(hypothesis)) / ref.length;
}

export function charErrorRate(reference: string, hypothesis: string): number {
  const ref = [...normalize(reference).replace(/ /g, "")];
  return ref.length === 0 ? 0 : editDistance(ref, [...normalize(hypothesis).replace(/ /g, "")]) / ref.length;
}

export interface ScriptMix {
  gujarati: number;
  devanagari: number;
  latin: number;
  /** Shares of the letters in the text, summing to 1 (or all 0 when there are no letters). */
  share: { gujarati: number; devanagari: number; latin: number };
}

export function scriptMix(text: string): ScriptMix {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  const gujarati = count(/[઀-૿]/g);
  const devanagari = count(/[ऀ-ॿ]/g);
  const latin = count(/[A-Za-zÀ-ɏ]/g);
  const total = gujarati + devanagari + latin;
  const share = (n: number) => (total === 0 ? 0 : n / total);
  return { gujarati, devanagari, latin, share: { gujarati: share(gujarati), devanagari: share(devanagari), latin: share(latin) } };
}

/** The largest difference, in percentage points, between the script shares of the reference and the transcript: big means a language came back in the wrong script. */
export function scriptDrift(reference: string, hypothesis: string): number {
  const r = scriptMix(reference).share;
  const h = scriptMix(hypothesis).share;
  return Math.round(Math.max(Math.abs(r.gujarati - h.gujarati), Math.abs(r.devanagari - h.devanagari), Math.abs(r.latin - h.latin)) * 100);
}

/** Every number in the text, as written with 0-9 (so "૫૦૦" and "500" are the same number). */
export const numbersIn = (text: string): string[] => normalize(text).match(/\d+(?:[./]\d+)*/g) ?? [];

/** How many of the reference's numbers appear in the transcript, and which do not. A missing or altered dose is the error that matters most. */
export function numberRecall(reference: string, hypothesis: string): { recall: number; missing: string[]; total: number } {
  const wanted = numbersIn(reference);
  const available = [...numbersIn(hypothesis)];
  const missing: string[] = [];
  for (const n of wanted) {
    const at = available.indexOf(n);
    if (at === -1) missing.push(n);
    else available.splice(at, 1);
  }
  return { recall: wanted.length === 0 ? 1 : (wanted.length - missing.length) / wanted.length, missing, total: wanted.length };
}

/** How many of the named terms (drug names, doses) appear in the transcript, ignoring case, spacing and punctuation. */
export function termRecall(terms: string[], hypothesis: string): { recall: number; missing: string[]; total: number } {
  const haystack = ` ${normalize(hypothesis)} `;
  const missing = terms.filter((t) => normalize(t) !== "" && !haystack.includes(` ${normalize(t)} `));
  const total = terms.filter((t) => normalize(t) !== "").length;
  return { recall: total === 0 ? 1 : (total - missing.length) / total, missing, total };
}

export const percent = (x: number) => `${(x * 100).toFixed(1)}%`;
