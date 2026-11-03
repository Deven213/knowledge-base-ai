import { describe, expect, it, vi } from "vitest";
import type { AIResponse } from "@/lib/ai-response";
import { IdentityRepository } from "@/server/auth/identity";
import { ConversationRepository, type AnswerVariant } from "@/server/db/repositories";
import { toMessageDTO } from "@/server/dto";
import { ProviderConfigService } from "@/server/llm/resolve";
import { LLMError, type LLMProvider, type LLMRequest } from "@/server/llm/types";
import { MessageNotFoundError, setAnswerLanguage } from "@/server/rag/answer-language";
import { applyText, checkTranslation, extractText, normalizeDigits, scriptProblem, sourceHash, TRANSLATION_FORMAT, TRANSLATION_VERSION, translationSystemPrompt } from "@/server/rag/translation";
import { memoryDb, SCRIPT_TAG, TEST_ORG, testConfig, testUserId } from "./helpers";

// The translation of an existing answer: what is extracted and checked, how it is cached and invalidated, what happens
// when several requests overlap, and that nothing crosses between users or organizations.

const answer: AIResponse = {
  found: true,
  title: "Examplamine in renal impairment",
  summary: "Avoid **examplamine** when **eGFR is below 30 mL/min/1.73 m²** [1].",
  sections: [
    { title: "Key points", tab: "Key points", kind: "info", bullets: ["**Contraindicated** if **eGFR < 30** [1]", "Review the dose at eGFR 30–44 [1][2]"], citations: [1, 2] },
    { title: "Lactic acidosis", kind: "warning", content: "Withhold during **dehydration** [1].", citations: [1] },
    { title: "Steps", kind: "instruction", numbered: true, bullets: ["Stop 48 h before contrast [2]", "Restart after re-check"], callout: { type: "important", label: "Note", text: "Check eGFR yearly [2]." }, citations: [2] },
    { title: "Doses", table: { headers: ["eGFR", "Action"], rows: [["≥ 60", "Continue"], ["30–44", "Reduce dose"]] }, citations: [2] },
  ],
  sources: [
    { documentId: "d1", documentName: "Examplamine.pdf", pageStart: 6, pageEnd: 6, citationIndexes: [1], origin: "knowledge_base", excerpt: "x" },
    { documentId: "d1", documentName: "Examplamine.pdf", pageStart: 9, pageEnd: 9, citationIndexes: [2], origin: "knowledge_base", excerpt: "y" },
  ],
  language: "en",
};
const ENGLISH_STRINGS = [
  "Examplamine in renal impairment",
  "Avoid **examplamine** when **eGFR is below 30 mL/min/1.73 m²** [1].",
  "Key points",
  "Key points",
  "**Contraindicated** if **eGFR < 30** [1]",
  "Review the dose at eGFR 30–44 [1][2]",
  "Lactic acidosis",
  "Withhold during **dehydration** [1].",
  "Steps",
  "Stop 48 h before contrast [2]",
  "Restart after re-check",
  "Note",
  "Check eGFR yearly [2].",
  "Doses",
  "eGFR",
  "Action",
  "Continue",
  "Reduce dose",
];

describe("the text of an answer", () => {
  it("is extracted in a fixed order, leaving out text with no letters (numbers, symbols, blanks)", () => {
    expect(extractText(answer)).toEqual(ENGLISH_STRINGS);
    const noisy: AIResponse = { ...answer, summary: "", sections: [{ title: "T", table: { headers: ["x"], rows: [["≥ 60", "", "30–44"]] } }] };
    expect(extractText(noisy)).toEqual(["Examplamine in renal impairment", "T", "x"]);
  });

  it("is put back in the same places, in the new language, with everything that isn't text untouched", () => {
    const translated = ENGLISH_STRINGS.map((s) => `HI:${s}`);
    const out = applyText(answer, translated, "hi");

    expect(extractText(out)).toEqual(translated);
    expect(out.language).toBe("hi");
    expect(out.sources).toEqual(answer.sources); // the sources are never touched
    expect(out.found).toBe(true);
    expect(out.sections.map((s) => [s.kind, s.numbered, s.citations, s.callout?.type])).toEqual(answer.sections.map((s) => [s.kind, s.numbered, s.citations, s.callout?.type]));
    expect(out.sections[3]!.table!.rows[0]![0]).toBe("≥ 60"); // a cell with no letters stays as it was
    expect(out.sections[2]!.callout).toEqual({ type: "important", label: "HI:Note", text: "HI:Check eGFR yearly [2]." });
    expect(answer.title).toBe("Examplamine in renal impairment"); // the original object is not modified
  });

  it("refuses a list that doesn't fit the answer", () => {
    expect(() => applyText(answer, ["only one"], "hi")).toThrow(/does not fit/);
    expect(() => applyText(answer, [...ENGLISH_STRINGS, "extra"], "hi")).toThrow(/does not fit/);
  });

  it("is identified by a hash of the text: any change to the answer changes it", () => {
    const hash = sourceHash(ENGLISH_STRINGS);
    expect(sourceHash([...ENGLISH_STRINGS])).toBe(hash);
    expect(sourceHash(ENGLISH_STRINGS.map((s, i) => (i === 1 ? s.replace("30", "20") : s)))).not.toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("checking a translation", () => {
  const original = ["Avoid **examplamine** if eGFR < 30 [1][2].", "Stop 48 h before contrast", "Note"];
  const good = ["**एग्ज़ैम्पलामाइन** से बचें, eGFR < 30 हो तो [1][2]।", "कंट्रास्ट से 48 h पहले रोकें", "नोट"];
  const reason = (translated: unknown, source = original) => {
    const r = checkTranslation(source, translated);
    return r.ok ? null : r.reason;
  };

  it("accepts a faithful one, trimmed", () => {
    expect(checkTranslation(original, good)).toEqual({ ok: true, strings: good });
    expect(checkTranslation(original, good.map((s) => `  ${s} \n`))).toEqual({ ok: true, strings: good });
  });

  it("refuses the wrong shape, the wrong count and empty strings", () => {
    expect(reason(undefined)).toMatch(/must be/);
    expect(reason([1, 2, 3])).toMatch(/must be/);
    expect(reason(good.slice(0, 2))).toMatch(/2 strings but 3 were given/);
    expect(reason([good[0], "  ", good[2]])).toMatch(/string 2 is empty/);
  });

  it("refuses a changed, dropped or added source marker (a citation must stay where it was)", () => {
    expect(reason(["x **y** [1].", good[1], good[2]])).toMatch(/string 1 must keep the source markers \[1\] \[2\]/);
    expect(reason(["**x** [1][2][3].", good[1], good[2]])).toMatch(/string 1 must keep the source markers/);
    expect(reason(["**x** eGFR < 30 [2][1].", good[1], good[2]])).toBeNull(); // the same markers in another order are fine
    expect(reason(["**x** [1, 2].", "a 48", "b"], ["**x** [1,2].", "a 48", "b"])).toBeNull(); // spaces inside a marker don't matter
  });

  it("refuses a lost or added bold marker", () => {
    expect(reason(["x [1][2] 30", good[1], good[2]], ["**x** [1][2] 30", "Stop 48 h", "Note"])).toMatch(/\*\* markers/);
  });

  it("refuses a changed, dropped or invented number (a dose or a threshold must not move)", () => {
    expect(reason(["**x** eGFR < 3 [1][2]", good[1], good[2]])).toMatch(/string 1 must keep exactly the numbers 30/);
    expect(reason([good[0], "रोकें 24 h", good[2]])).toMatch(/string 2 must keep exactly the numbers 48/);
    expect(reason([good[0], "रोकें", good[2]])).toMatch(/string 2 must keep exactly the numbers 48/);
    expect(reason([good[0], "रोकें 48 h 2", good[2]])).toMatch(/string 2/);
    expect(reason([good[0], good[1], "नोट 5"])).toMatch(/string 3 must keep exactly the numbers \(none\)/);
  });

  it("writes Devanagari and Gujarati digits as 0-9, so the value is the same value", () => {
    expect(normalizeDigits("३० mg, ૪૮ h, ०૧")).toBe("30 mg, 48 h, 01");
    const checked = checkTranslation(original, [good[0]!.replace("30", "३०"), good[1]!.replace("48", "૪૮"), good[2]]);
    expect(checked).toMatchObject({ ok: true });
    expect(checked.ok && checked.strings[0]).toContain("30");
    expect(checked.ok && checked.strings[1]).toContain("48");
  });
});

describe("the script a translation is written in", () => {
  const sentence = "Metformin is the first-line treatment for type 2 diabetes";
  const hindi = "मेटफॉर्मिन टाइप 2 मधुमेह के लिए पहली पंक्ति का उपचार है";
  const gujarati = "મેટફોર્મિન ટાઇપ 2 ડાયાબિટીસ માટે પ્રથમ પસંદગીની સારવાર છે";

  it("accepts Gujarati for Gujarati and Hindi for Hindi, with drug names, units and abbreviations left in Latin letters", () => {
    expect(scriptProblem([gujarati, "eGFR 30 mg ના કરતાં ઓછું"], "gujarati", [sentence, "eGFR below 30 mg"])).toBeNull();
    expect(scriptProblem([hindi, "eGFR 30 mg से कम"], "devanagari", [sentence, "eGFR below 30 mg"])).toBeNull();
    expect(scriptProblem(["Metformin is the first-line treatment"], "latin")).toBeNull();
  });

  it("refuses Hindi when Gujarati was asked for, and the other way round (the report: Gujarati came back as Hindi)", () => {
    expect(scriptProblem([hindi], "gujarati")).toMatch(/contains Devanagari \(Hindi\) letters, but must be written in Gujarati script/);
    expect(scriptProblem([gujarati], "devanagari")).toMatch(/contains Gujarati letters, but must be written in Devanagari \(Hindi\) script/);
    expect(scriptProblem([gujarati, hindi], "gujarati")).toMatch(/Devanagari/); // a single Hindi sentence among Gujarati ones is enough
  });

  it("refuses English left untranslated, and Latin transliteration of Hindi or Gujarati", () => {
    expect(scriptProblem([sentence], "gujarati", [sentence])).toMatch(/most of it is not written in Gujarati script/);
    expect(scriptProblem(["Metaformin taip 2 madhumeh ke liye pehli pankti ka upchar hai"], "devanagari")).toMatch(/most of it is not written in Devanagari/);
  });

  it("refuses a sentence-sized string left in English even if the rest is translated", () => {
    const original = ["Heading", sentence, "Note"];
    const problem = scriptProblem(["મુખ્ય મુદ્દાઓ અને વધુ વિગતો", sentence, "નોંધ સાથે વધુ માહિતી અહીં"], "gujarati", original);
    expect(problem).toMatch(/string 2 is not written in Gujarati script/);
  });

  it("refuses Indian-script text when English was asked for", () => {
    expect(scriptProblem([hindi], "latin")).toMatch(/Devanagari/);
    expect(scriptProblem([`${sentence} ${gujarati}`], "latin")).toMatch(/Gujarati/);
  });

  it("tolerates the danda (।), which Gujarati text may use, and has nothing to say about numbers and symbols", () => {
    expect(scriptProblem([`${gujarati}।`], "gujarati")).toBeNull();
    expect(scriptProblem(["≥ 60", "30–44", "500"], "gujarati")).toBeNull();
  });

  it("is part of checking a translation, together with the markers and numbers", () => {
    const original = ["Avoid examplamine if eGFR < 30 [1]."];
    expect(checkTranslation(original, ["એક્ઝામ્પલામાઇન ટાળો જ્યારે eGFR < 30 [1]."], "gujarati")).toMatchObject({ ok: true });
    expect(checkTranslation(original, ["एग्ज़ैम्पलामाइन से बचें जब eGFR < 30 [1]."], "gujarati")).toMatchObject({ ok: false, reason: expect.stringMatching(/Devanagari/) });
    expect(checkTranslation(original, ["એક્ઝામ્પલામાઇન ટાળો જ્યારે eGFR < 20 [1]."], "gujarati")).toMatchObject({ ok: false, reason: expect.stringMatching(/numbers 30/) });
  });

  it("is told to the model: the language's own script, never another language's, never transliteration", () => {
    expect(translationSystemPrompt("Gujarati (ગુજરાતી, Gujarati script)")).toMatch(/own script \(Devanagari for Hindi, Gujarati script for Gujarati\): never in another language's script, and never as Latin transliteration/);
  });
});

describe("the instructions sent to the model", () => {
  it("are short, name the language, and carry the rules that protect meaning, numbers and citations", () => {
    const prompt = translationSystemPrompt("Hindi (हिन्दी, Devanagari script)");
    expect(prompt.length).toBeLessThan(1500);
    expect(prompt).toContain("into Hindi (हिन्दी, Devanagari script)");
    expect(prompt).toMatch(/exactly the same number of strings/);
    expect(prompt).toMatch(/Never add, remove, soften or strengthen a fact, warning, contraindication, dose/);
    expect(prompt).toMatch(/Keep every source marker/);
    expect(prompt).toMatch(/Western digits/);
    expect(prompt).toMatch(/drug names exactly as written/);
    expect(prompt).not.toMatch(/Answer using ONLY|sources/i); // it knows nothing about answering questions
  });

  it("asks for a flat list in every provider's structured-output format", () => {
    expect(TRANSLATION_FORMAT.name).toBe("translated_strings");
    expect(TRANSLATION_FORMAT.schema).toEqual({ type: "object", additionalProperties: false, required: ["t"], properties: { t: { type: "array", items: { type: "string" } } } });
  });
});

// ── The service ──

function world() {
  const db = memoryDb();
  const providerConfig = new ProviderConfigService(db, testConfig({ GEMINI_API_KEY: "AIza-test-key-12345678", GEMINI_MODEL: "g", DEFAULT_AI_PROVIDER: "gemini" }));
  const conversations = new ConversationRepository(db, TEST_ORG, testUserId(db));
  const requests: { language: string; strings: string[]; system: string; signal: AbortSignal | undefined; finish: (reply?: (s: string) => string) => void; fail: (e: Error) => void }[] = [];
  /** A model whose replies are held until the test releases them, so overlapping requests can be staged. */
  const manual = vi.fn(
    (req: LLMRequest) =>
      new Promise<{ text: string }>((resolve, reject) => {
        const language = /into (\w+)/.exec(req.system)![1]!;
        const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
        req.signal?.addEventListener("abort", () => reject(new LLMError("cancelled", "cancelled")), { once: true });
        requests.push({
          language,
          strings,
          system: req.system,
          signal: req.signal,
          finish: (reply = (s) => `${SCRIPT_TAG[language]}~${s}`) => resolve({ text: JSON.stringify({ t: strings.map(reply) }) }),
          fail: reject,
        });
      }),
  );
  const generate = vi.fn(async (req: LLMRequest) => {
    const language = /into (\w+)/.exec(req.system)![1]!;
    const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
    return { text: JSON.stringify({ t: strings.map((s) => `${SCRIPT_TAG[language]}~${s}`) }) };
  });
  const make = (g: (req: LLMRequest) => Promise<{ text: string }>) => ({ conversations, providerConfig, getProvider: () => ({ id: "gemini", generate: g }) as LLMProvider });
  const addAnswer = (structured: AIResponse | null = answer, over: { content?: string; language?: string } = {}) => {
    const id = conversations.create("chat");
    const [, assistant] = conversations.addMessages(id, [
      { role: "user", content: "Examplamine in renal impairment?" },
      {
        role: "assistant",
        content: over.content ?? "Original answer [1].",
        citations: [{ index: 1, documentId: "d1", filename: "Examplamine.pdf", pageStart: 6, pageEnd: 6, excerpt: "x", score: 0.8, cited: true }],
        structured,
        language: over.language ?? "en",
        context: { question: "Examplamine in renal impairment?", sources: [{ source: "knowledge_base", documentId: "d1", filename: "Examplamine.pdf", pageStart: 6, pageEnd: 6, content: "PASSAGE-TEXT", score: 0.8 }], imageNames: [] },
        provider: "gemini",
        model: "g",
        noContext: false,
      },
    ]);
    return assistant!.id;
  };
  const row = (id: string) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as { language: string; variants_json: string | null };
  const variants = (id: string) => JSON.parse(row(id).variants_json ?? "{}") as Record<string, AnswerVariant>;
  return { db, conversations, providerConfig, deps: make(generate), manualDeps: make(manual), generate, manual, requests, addAnswer, row, variants, make };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("caching translations", () => {
  it("saves the original and each translation with what it was made from, and shows the first translation once", async () => {
    const w = world();
    const id = w.addAnswer();

    const hi = await setAnswerLanguage(w.deps, id, "hi");

    expect(w.generate).toHaveBeenCalledTimes(1);
    expect(Object.keys(w.variants(id))).toEqual(["en", "hi"]); // the original is first
    expect(w.variants(id).en!.meta).toMatchObject({ method: "original" });
    expect(w.variants(id).hi!.meta).toMatchObject({ method: "translation", version: TRANSLATION_VERSION, sourceHash: sourceHash(ENGLISH_STRINGS) });
    expect(w.variants(id).en!.structured).toEqual(answer); // the original answer is kept exactly
    expect(hi.language).toBe("hi");
  });

  it("switches between saved languages without any model call, in any order, as often as asked", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    await setAnswerLanguage(w.deps, id, "gu");
    expect(w.generate).toHaveBeenCalledTimes(2);

    for (const code of ["en", "hi", "gu", "en", "gu", "hi", "en"]) {
      const shown = await setAnswerLanguage(w.deps, id, code);
      expect(shown.language).toBe(code);
    }
    expect(w.generate).toHaveBeenCalledTimes(2);
    expect(toMessageDTO(w.conversations.getMessage(id)!).structured).toEqual(answer); // back to the original, intact
  });

  it("always translates from the ORIGINAL answer, never from another translation", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    await setAnswerLanguage(w.deps, id, "gu"); // asked while the Hindi version is shown

    const strings = JSON.parse((w.generate.mock.calls[1]![0].content[0] as { text: string }).text);
    expect(strings).toEqual(ENGLISH_STRINGS);
    expect(w.variants(id).gu!.structured?.title).toBe("ગુજરાતી~Examplamine in renal impairment");
  });

  it("translates again when the original text changed (the saved version no longer matches it)", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    await setAnswerLanguage(w.deps, id, "en");

    const saved = w.variants(id);
    saved.en!.structured = { ...answer, summary: "Avoid **examplamine** when **eGFR is below 15 mL/min/1.73 m²** [1]." };
    w.db.prepare("UPDATE messages SET variants_json = ? WHERE id = ?").run(JSON.stringify(saved), id);

    const hi = await setAnswerLanguage(w.deps, id, "hi");

    expect(w.generate).toHaveBeenCalledTimes(2);
    expect(hi.structured?.summary).toContain("15 mL/min");
    expect(w.variants(id).hi!.meta?.sourceHash).toBe(sourceHash(extractText(saved.en!.structured!)));
  });

  it("translates again when the translation logic was versioned up, and keeps versions that have no meta (saved earlier)", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    await setAnswerLanguage(w.deps, id, "gu");
    await setAnswerLanguage(w.deps, id, "en");
    const saved = w.variants(id);
    saved.hi!.meta = { ...saved.hi!.meta!, version: TRANSLATION_VERSION - 1 }; // made by older logic
    delete saved.gu!.meta; // saved before meta existed
    w.db.prepare("UPDATE messages SET variants_json = ? WHERE id = ?").run(JSON.stringify(saved), id);
    const calls = w.generate.mock.calls.length;

    await setAnswerLanguage(w.deps, id, "gu");
    expect(w.generate.mock.calls.length).toBe(calls); // reused: it can't be told to be wrong, and re-doing it would cost
    await setAnswerLanguage(w.deps, id, "hi");
    expect(w.generate.mock.calls.length).toBe(calls + 1); // redone
    expect(w.variants(id).hi!.meta?.version).toBe(TRANSLATION_VERSION);
  });

  it("keeps working for an answer saved before language versions existed: the shown answer is the original", async () => {
    const w = world();
    const id = w.addAnswer();
    w.db.prepare("UPDATE messages SET variants_json = NULL, context_json = NULL WHERE id = ?").run(id);
    await setAnswerLanguage(w.deps, id, "gu");
    expect(Object.keys(w.variants(id))).toEqual(["en", "gu"]);
    expect((await setAnswerLanguage(w.deps, id, "en")).structured).toEqual(answer);
  });

  it("works for a plain-text answer too (older or unstructured), translating its text", async () => {
    const w = world();
    const id = w.addAnswer(null, { content: "Avoid examplamine below eGFR 30 [1]." });
    const hindi = "एग्ज़ैम्पलामाइन से बचें जब eGFR 30 से कम हो [1].";
    const g = vi.fn(async () => ({ text: JSON.stringify({ t: [hindi] }) }));

    const hi = await setAnswerLanguage(w.make(g), id, "hi");

    expect(hi.structured).toBeNull();
    expect(hi.content).toBe(hindi);
    expect((await setAnswerLanguage(w.make(g), id, "en")).content).toBe("Avoid examplamine below eGFR 30 [1].");
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("when the model's translation is not good enough", () => {
  it("asks once more, naming what was wrong, and uses the corrected one", async () => {
    const w = world();
    const id = w.addAnswer();
    let call = 0;
    const g = vi.fn(async (req: LLMRequest) => {
      const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
      call++;
      // The first reply changes a number in the summary; the second is faithful.
      return { text: JSON.stringify({ t: strings.map((s, i) => (call === 1 && i === 1 ? s.replace("30", "20") : `हिन्दी~${s}`)) }) };
    });

    const hi = await setAnswerLanguage(w.make(g), id, "hi");

    expect(g).toHaveBeenCalledTimes(2);
    expect(g.mock.calls[1]![0].system).toMatch(/Your previous reply was rejected because string 2 must keep exactly the numbers/);
    expect(hi.structured?.summary).toContain("30 mL/min");
    expect(hi.structured?.summary).not.toContain("20 mL/min");
    expect(w.variants(id).hi!.meta?.method).toBe("translation");
  });

  it("falls back to re-answering from the stored passages, with the original as reference, if the second try fails too", async () => {
    const w = world();
    const id = w.addAnswer();
    const requests: LLMRequest[] = [];
    const g = vi.fn(async (req: LLMRequest) => {
      requests.push(req);
      if (/^You translate/.test(req.system)) return { text: JSON.stringify({ t: ["too", "few"] }) };
      return { text: JSON.stringify({ found: true, title: "हिन्दी", summary: "s", sections: [] }) };
    });

    const hi = await setAnswerLanguage(w.make(g), id, "hi");

    expect(g).toHaveBeenCalledTimes(3); // two translations, then one regeneration
    expect(requests[0]!.reasoning).toBe("minimal");
    expect(requests[2]!.reasoning).toBeUndefined(); // re-answering is real work: it keeps the provider's default
    expect(requests[2]!.system).toContain("Response language: Hindi");
    expect(requests.at(-1)!.content.map((p) => (p.type === "text" ? p.text : "")).join("")).toMatch(/PASSAGE-TEXT[\s\S]*<reference_answer>[\s\S]*Examplamine in renal impairment/);
    expect(hi.structured?.title).toBe("हिन्दी");
    expect(hi.structured?.sources).toEqual(toMessageDTO(w.conversations.getMessage(id)!).structured?.sources);
    expect(w.variants(id).hi!.meta?.method).toBe("regeneration");
  });

  it("does not fall back for a provider failure (rate limit, timeout…): the answer stays as it is and the error is passed on", async () => {
    const w = world();
    const id = w.addAnswer();
    const g = vi.fn(async () => {
      throw new LLMError("rate_limit", "Rate limited.");
    });
    await expect(setAnswerLanguage(w.make(g), id, "hi")).rejects.toMatchObject({ kind: "rate_limit" });
    expect(g).toHaveBeenCalledTimes(1);
    expect(w.row(id).language).toBe("en");
    expect(toMessageDTO(w.conversations.getMessage(id)!).structured).toEqual(answer);
    expect(Object.keys(w.variants(id))).toEqual(["en"]); // only the original was recorded
  });
});

describe("several requests for one answer", () => {
  it("make one translation when the same one is asked for twice at once", async () => {
    const w = world();
    const id = w.addAnswer();

    const a = setAnswerLanguage(w.manualDeps, id, "hi");
    const b = setAnswerLanguage(w.manualDeps, id, "hi");
    await tick();
    expect(w.manual).toHaveBeenCalledTimes(1);
    w.requests[0]!.finish();

    const [first, second] = await Promise.all([a, b]);
    expect(first.language).toBe("hi");
    expect(second.language).toBe("hi");
    expect(w.manual).toHaveBeenCalledTimes(1);
  });

  it("only the newest choice decides what is shown: an older translation that finishes late is saved, not shown", async () => {
    const w = world();
    const id = w.addAnswer();

    const hindi = setAnswerLanguage(w.manualDeps, id, "hi");
    await tick();
    const gujarati = setAnswerLanguage(w.manualDeps, id, "gu");
    await tick();
    expect(w.requests.map((r) => r.language)).toEqual(["Hindi", "Gujarati"]);

    w.requests[1]!.finish(); // the newer one is ready first
    expect((await gujarati).language).toBe("gu");
    w.requests[0]!.finish(); // the older one arrives late
    const late = await hindi;

    expect(late.language).toBe("gu"); // what is shown did not change
    expect(w.row(id).language).toBe("gu");
    const calls = w.manual.mock.calls.length;
    expect((await setAnswerLanguage(w.manualDeps, id, "hi")).language).toBe("hi"); // and Hindi is there, free
    expect(w.manual.mock.calls.length).toBe(calls);
  });

  it("choosing the language already shown ends an older request's right to change it", async () => {
    const w = world();
    const id = w.addAnswer();
    const hindi = setAnswerLanguage(w.manualDeps, id, "hi");
    await tick();

    const back = await setAnswerLanguage(w.manualDeps, id, "en"); // changed their mind: English is shown
    w.requests[0]!.finish();
    await hindi;

    expect(back.language).toBe("en");
    expect(w.row(id).language).toBe("en");
    expect(Object.keys(w.variants(id))).toEqual(["en", "hi"]); // Hindi was still saved
  });

  it("a request nobody is waiting for any more is cancelled at the model, but not while someone still waits", async () => {
    const w = world();
    const id = w.addAnswer();
    const one = new AbortController();
    const two = new AbortController();

    const a = setAnswerLanguage(w.manualDeps, id, "hi", one.signal);
    const b = setAnswerLanguage(w.manualDeps, id, "hi", two.signal);
    await tick();
    one.abort();
    await expect(a).rejects.toMatchObject({ kind: "cancelled" });
    expect(w.requests[0]!.signal!.aborted).toBe(false); // the second request still needs it
    two.abort();
    await expect(b).rejects.toMatchObject({ kind: "cancelled" });
    expect(w.requests[0]!.signal!.aborted).toBe(true);
    expect(w.row(id).language).toBe("en");
  });

  it("an abandoned request leaves nothing half-done, and a later request starts a fresh translation", async () => {
    const w = world();
    const id = w.addAnswer();
    const controller = new AbortController();
    const first = setAnswerLanguage(w.manualDeps, id, "hi", controller.signal);
    await tick();
    controller.abort();
    await expect(first).rejects.toBeDefined();

    const again = setAnswerLanguage(w.manualDeps, id, "hi");
    await tick();
    expect(w.manual).toHaveBeenCalledTimes(2);
    w.requests[1]!.finish();
    expect((await again).language).toBe("hi");
  });

  it("a request already cancelled when it arrives does nothing", async () => {
    const w = world();
    const id = w.addAnswer();
    const controller = new AbortController();
    controller.abort();
    await expect(setAnswerLanguage(w.manualDeps, id, "hi", controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
    await tick();
    expect(w.row(id).language).toBe("en");
  });
});

describe("whose answer it is", () => {
  function twoPeople() {
    const w = world();
    const identity = new IdentityRepository(w.db);
    const otherOrg = identity.createOrganization("Other Co").id;
    const intruder = identity.createUser({ email: "intruder@other.test", passwordHash: "x" });
    identity.addMember(otherOrg, intruder.id, "owner");
    const sameOrgColleague = identity.createUser({ email: "colleague@acme.test", passwordHash: "x" });
    identity.addMember(TEST_ORG, sameOrgColleague.id, "member");
    const depsFor = (conversations: ConversationRepository) => ({ conversations, providerConfig: w.providerConfig, getProvider: () => ({ id: "gemini", generate: w.generate }) as LLMProvider });
    return { ...w, other: depsFor(new ConversationRepository(w.db, otherOrg, intruder.id)), colleague: depsFor(new ConversationRepository(w.db, TEST_ORG, sameOrgColleague.id)) };
  }

  it("is not reachable by another organization or by a colleague: not found, no model call, nothing written", async () => {
    const w = twoPeople();
    const id = w.addAnswer();
    const before = JSON.stringify(w.row(id));

    await expect(setAnswerLanguage(w.other, id, "hi")).rejects.toThrow(MessageNotFoundError);
    await expect(setAnswerLanguage(w.colleague, id, "hi")).rejects.toThrow(MessageNotFoundError);

    expect(w.generate).not.toHaveBeenCalled();
    expect(JSON.stringify(w.row(id))).toBe(before);
  });

  it("is not shared while a translation is under way: the other person can't join, see or cancel it", async () => {
    const w = twoPeople();
    const id = w.addAnswer();
    const mine = setAnswerLanguage(w.manualDeps, id, "hi");
    await tick();

    await expect(setAnswerLanguage(w.other, id, "hi")).rejects.toThrow(MessageNotFoundError);
    const abort = new AbortController();
    const colleague = setAnswerLanguage(w.colleague, id, "hi", abort.signal);
    abort.abort();
    await expect(colleague).rejects.toThrow(MessageNotFoundError);
    // A refused request for ANOTHER language must not count as a choice either: it is not theirs to make.
    await expect(setAnswerLanguage(w.other, id, "gu")).rejects.toThrow(MessageNotFoundError);
    await expect(setAnswerLanguage(w.colleague, id, "en")).rejects.toThrow(MessageNotFoundError);
    expect(w.requests[0]!.signal!.aborted).toBe(false);
    w.requests[0]!.finish();
    expect((await mine).language).toBe("hi");
  });

  it("keeps each person's translations in their own message: two identical answers don't share saved versions", async () => {
    const w = twoPeople();
    const own = w.addAnswer();
    const identity = new IdentityRepository(w.db);
    const theirOrg = identity.createOrganization("Third Co").id;
    const person = identity.createUser({ email: "third@third.test", passwordHash: "x" });
    identity.addMember(theirOrg, person.id, "owner");
    const theirs = new ConversationRepository(w.db, theirOrg, person.id);
    const chat = theirs.create("their chat");
    const [, theirAnswer] = theirs.addMessages(chat, [
      { role: "user", content: "same question" },
      { role: "assistant", content: "Original answer [1].", citations: [], structured: answer, language: "en", provider: "gemini", model: "g", noContext: false },
    ]);

    await setAnswerLanguage(w.deps, own, "hi");

    expect(Object.keys(w.variants(own))).toEqual(["en", "hi"]);
    expect(Object.keys(JSON.parse(w.row(theirAnswer!.id).variants_json!))).toEqual(["en"]); // the other person's identical answer has no translation and nothing was written to it
    expect(w.row(theirAnswer!.id).language).toBe("en");
  });
});

describe("Hindi text filed as Gujarati (the reported bug)", () => {
  const hindiTitle = "मेटफॉर्मिन के बारे में मुख्य जानकारी";
  const wrongScript = (req: LLMRequest) => {
    const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
    return { text: JSON.stringify({ t: strings.map((s) => `${hindiTitle} ${s}`) }) };
  };

  it("is not accepted: asked again with the reason, then re-answered, and if that is Hindi too the answer stays as it is with a clear error", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    const calls: LLMRequest[] = [];
    const g = vi.fn(async (req: LLMRequest) => {
      calls.push(req);
      if (/^You translate/.test(req.system)) return wrongScript(req);
      return { text: JSON.stringify({ found: true, title: hindiTitle, summary: hindiTitle, sections: [] }) }; // the old way is wrong too
    });

    await expect(setAnswerLanguage(w.make(g), id, "gu")).rejects.toMatchObject({ message: expect.stringMatching(/did not return a reliable Gujarati translation \(it contains Devanagari \(Hindi\) letters/) });

    expect(g).toHaveBeenCalledTimes(3); // translation, corrected translation, re-answer
    expect(calls[1]!.system).toMatch(/rejected because it contains Devanagari \(Hindi\) letters, but must be written in Gujarati script/);
    expect(w.row(id).language).toBe("hi"); // the Hindi answer is still shown
    expect(Object.keys(w.variants(id))).toEqual(["en", "hi"]); // and nothing wrong was saved as Gujarati
  });

  it("is told apart from a translation that is fine: the next try (correct Gujarati) is accepted and shown", async () => {
    const w = world();
    const id = w.addAnswer();
    let attempt = 0;
    const g = vi.fn(async (req: LLMRequest) => {
      attempt++;
      const strings = JSON.parse((req.content[0] as { text: string }).text) as string[];
      return attempt === 1 ? wrongScript(req) : { text: JSON.stringify({ t: strings.map((s) => `${SCRIPT_TAG.Gujarati}~${s}`) }) };
    });

    const gu = await setAnswerLanguage(w.make(g), id, "gu");

    expect(g).toHaveBeenCalledTimes(2);
    expect(gu.language).toBe("gu");
    expect(gu.structured?.title).toBe("ગુજરાતી~Examplamine in renal impairment");
    expect(w.variants(id).gu!.meta?.method).toBe("translation");
  });

  it("is not reused when it was saved earlier: a 'Gujarati' version that is really Hindi is translated again", async () => {
    const w = world();
    const id = w.addAnswer();
    await setAnswerLanguage(w.deps, id, "hi");
    await setAnswerLanguage(w.deps, id, "en");
    const saved = w.variants(id);
    saved.gu = { ...saved.hi! }; // the Hindi version, filed under "gu"; no meta, like versions saved before meta existed
    delete saved.gu.meta;
    w.db.prepare("UPDATE messages SET variants_json = ? WHERE id = ?").run(JSON.stringify(saved), id);
    const calls = w.generate.mock.calls.length;

    const gu = await setAnswerLanguage(w.deps, id, "gu");

    expect(w.generate.mock.calls.length).toBe(calls + 1);
    expect(gu.structured?.title).toBe("ગુજરાતી~Examplamine in renal impairment");
    expect(w.variants(id).hi!.structured?.title).toBe("हिन्दी~Examplamine in renal impairment"); // Hindi is untouched
  });

  it("keeps each language under its own key: English, Hindi and Gujarati never answer for one another", async () => {
    const w = world();
    const id = w.addAnswer();
    const titles: Record<string, string | undefined> = {};
    for (const code of ["hi", "gu", "en", "hi", "gu", "en"]) titles[code] = (await setAnswerLanguage(w.deps, id, code)).structured?.title;
    expect(titles).toEqual({ hi: "हिन्दी~Examplamine in renal impairment", gu: "ગુજરાતી~Examplamine in renal impairment", en: "Examplamine in renal impairment" });
    expect(w.generate).toHaveBeenCalledTimes(2); // one translation per new language, nothing for the repeats
  });
});

describe("saved versions", () => {
  const variant = (content: string): AnswerVariant => ({ content, structured: null, provider: "gemini", model: "g" });

  it("are added without touching the ones already there, and the first one stays first (it is the original)", () => {
    const w = world();
    const id = w.addAnswer();
    w.conversations.saveVariants(id, { hi: variant("hindi") });
    w.conversations.saveVariants(id, { en: variant("SHOULD NOT REPLACE"), gu: variant("gujarati") }, "add-missing");

    const saved = w.variants(id);
    expect(Object.keys(saved)).toEqual(["en", "hi", "gu"]);
    expect(saved.en!.content).toBe("Original answer [1].");
    expect(saved.gu!.content).toBe("gujarati");

    w.conversations.saveVariants(id, { hi: variant("redone") }); // replacing is the default (a stale version being redone)
    expect(w.variants(id).hi!.content).toBe("redone");
    expect(Object.keys(w.variants(id))).toEqual(["en", "hi", "gu"]);
  });

  it("are saved and selected only inside the caller's own conversations", () => {
    const w = world();
    const id = w.addAnswer();
    const identity = new IdentityRepository(w.db);
    const org = identity.createOrganization("Other Co").id;
    const person = identity.createUser({ email: "p@other.test", passwordHash: "x" });
    identity.addMember(org, person.id, "owner");
    const theirs = new ConversationRepository(w.db, org, person.id);
    const before = JSON.stringify(w.row(id));

    expect(() => theirs.saveVariants(id, { hi: variant("injected") })).toThrow("Message not found.");
    expect(() => theirs.selectVariant(id, "en")).toThrow("Message not found.");
    expect(JSON.stringify(w.row(id))).toBe(before);
    expect(() => w.conversations.selectVariant(id, "hi")).toThrow("Message not found."); // a version that isn't saved can't be shown
  });
});

describe("chat history", () => {
  it("is unchanged by translating: same messages, order, question and other answers", async () => {
    const w = world();
    const id = w.addAnswer();
    const other = w.addAnswer();
    const before = w.db.prepare("SELECT id, role, content, language FROM messages ORDER BY rowid").all();

    await setAnswerLanguage(w.deps, id, "gu");

    const after = w.db.prepare("SELECT id, role, content, language FROM messages ORDER BY rowid").all() as { id: string; language: string }[];
    expect(after.map((m) => m.id)).toEqual((before as { id: string }[]).map((m) => m.id));
    expect(after.find((m) => m.id === other)).toEqual((before as { id: string }[]).find((m) => m.id === other));
    expect(after.find((m) => m.id === id)!.language).toBe("gu");
  });
});
