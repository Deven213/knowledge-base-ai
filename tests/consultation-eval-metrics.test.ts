import { describe, expect, it } from "vitest";
import { charErrorRate, editDistance, normalize, numberRecall, numbersIn, scriptDrift, scriptMix, termRecall, tokens, wordErrorRate } from "./consultation-eval-metrics";

describe("preparing text for comparison", () => {
  it("ignores case, punctuation and spacing, but keeps every letter and vowel sign of Gujarati and Hindi", () => {
    expect(normalize("  Paracetamol, 650 MG!  ")).toBe("paracetamol 650 mg");
    expect(normalize("ડૉક્ટર સાહેબ, ત્રણ દિવસથી.")).toBe("ડૉક્ટર સાહેબ ત્રણ દિવસથી");
    expect(normalize("मुझे sugar की दवा है।")).toBe("मुझे sugar की दवा है");
    expect(tokens("")).toEqual([]);
  });

  it("reads Gujarati and Devanagari digits as the same numbers, and keeps BP and decimals whole", () => {
    expect(normalize("૫૦૦ mg, ५०० mg")).toBe("500 mg 500 mg");
    expect(numbersIn("BP 120/80, dose 2.5 mg, ૧૦૧ fever, 10 days.")).toEqual(["120/80", "2.5", "101", "10"]);
  });
});

describe("how far a transcript is from the reference", () => {
  it("is zero for the same words and counts wrong, missing and extra words", () => {
    expect(wordErrorRate("take one tablet daily", "Take one tablet daily.")).toBe(0);
    expect(wordErrorRate("take one tablet daily", "take two tablet daily")).toBeCloseTo(0.25);
    expect(wordErrorRate("take one tablet daily", "take tablet")).toBeCloseTo(0.5);
    expect(wordErrorRate("take one tablet daily", "please take one tablet daily now")).toBeCloseTo(0.5);
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("", "something")).toBe(1);
  });

  it("judges Indic text by its letters: a changed vowel sign is a small error, a different word a larger one", () => {
    const reference = "ત્રણ દિવસથી તાવ છે";
    expect(charErrorRate(reference, reference)).toBe(0);
    expect(charErrorRate(reference, "ત્રણ દિવસથી તાવ છે.")).toBe(0);
    const small = charErrorRate(reference, "ત્રણ દિવસથી તવ છે");
    const big = charErrorRate(reference, "બે અઠવાડિયાથી ખાંસી છે");
    expect(small).toBeGreaterThan(0);
    expect(small).toBeLessThan(0.2);
    expect(big).toBeGreaterThan(small * 3);
  });

  it("computes the edit distance of any sequence, in any order of arguments", () => {
    expect(editDistance([..."kitten"], [..."sitting"])).toBe(3);
    expect(editDistance([..."sitting"], [..."kitten"])).toBe(3);
    expect(editDistance([], [1, 2])).toBe(2);
    expect(editDistance([1, 2, 3], [])).toBe(3);
  });

  it("copes with a long consultation without running out of memory", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `word${i % 97}`).join(" ");
    expect(wordErrorRate(words, words)).toBe(0);
  });
});

describe("script: did each language come back in its own script?", () => {
  it("measures the share of Gujarati, Devanagari and Latin letters", () => {
    const mix = scriptMix("ત્રણ दिन fever");
    expect(mix.gujarati).toBeGreaterThan(0);
    expect(mix.devanagari).toBeGreaterThan(0);
    expect(mix.latin).toBe(5);
    expect(mix.share.gujarati + mix.share.devanagari + mix.share.latin).toBeCloseTo(1);
    expect(scriptMix("123 !!").share).toEqual({ gujarati: 0, devanagari: 0, latin: 0 });
  });

  it("is quiet when the scripts match and loud when a language is written in the wrong one", () => {
    const reference = "મને ત્રણ દિવસથી તાવ છે અને metformin 500 mg લઉં છું";
    expect(scriptDrift(reference, reference)).toBe(0);
    expect(scriptDrift(reference, "મને ત્રણ દિવસથી તાવ છે અને metformin 500 mg લઉં છું.")).toBe(0);
    expect(scriptDrift(reference, "मुझे तीन दिन से बुखार है और metformin 500 mg लेता हूं")).toBeGreaterThan(40); // Gujarati returned as Hindi
    expect(scriptDrift(reference, "mane tran divas thi taav chhe ane metformin 500 mg lau chhu")).toBeGreaterThan(40); // ...or as Latin letters
  });
});

describe("numbers and terms: the errors that matter in a clinical note", () => {
  it("reports which numbers were lost or changed", () => {
    const reference = "Paracetamol 650 mg twice a day, BP 120/80, temperature 101, five days";
    expect(numberRecall(reference, "paracetamol 650 mg twice a day BP 120/80 temperature 101")).toEqual({ recall: 1, missing: [], total: 3 });
    const wrong = numberRecall(reference, "paracetamol 550 mg, BP 120/80, temperature 101");
    expect(wrong.missing).toEqual(["650"]);
    expect(wrong.recall).toBeCloseTo(2 / 3);
  });

  it("counts a number once per time it was said", () => {
    expect(numberRecall("take 2 then 2 more", "take 2").missing).toEqual(["2"]);
    expect(numberRecall("no numbers here", "anything").recall).toBe(1);
  });

  it("finds named terms whatever the case or punctuation, and not inside other words", () => {
    const hypothesis = "Metformin, 500 mg. And amlodipine5mg too";
    const result = termRecall(["metformin", "500 mg", "Amlodipine 5 mg", "glimepiride"], hypothesis);
    expect(result.missing).toEqual(["Amlodipine 5 mg", "glimepiride"]);
    expect(result.recall).toBeCloseTo(0.5);
    expect(termRecall(["met"], "metformin").missing).toEqual(["met"]);
    expect(termRecall([], "x").recall).toBe(1);
  });
});
