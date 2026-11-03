import { describe, expect, it } from "vitest";
import type { AIResponse, AIResponseSection } from "@/lib/ai-response";
import { buildClinicalNote, MAX_KEY_POINTS, visibleWordCount } from "@/lib/clinical-note";
import { LANGUAGES } from "@/lib/languages";
import { buildSystemPrompt } from "@/server/rag/prompt";

// The clinical-note view only ARRANGES a structured answer: what a clinician sees in 10-15 seconds, and what waits behind
// "More details". Cautions are never collapsed, ordered steps are never cut, and no text is ever dropped or rewritten.

const answer = (sections: AIResponseSection[], over: Partial<AIResponse> = {}): AIResponse => ({ found: true, title: "T", summary: "Headline.", sections, sources: [], language: "en", ...over });
const texts = (s: AIResponseSection): string[] => [s.title, s.content, ...(s.bullets ?? []), ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : []), s.callout?.text].filter((t): t is string => !!t);

/** Every string of the note (visible and collapsed): used to prove nothing was lost. */
function everyText(note: ReturnType<typeof buildClinicalNote>): string[] {
  return [
    note.summary,
    ...note.keyPoints,
    ...(note.keyPointsTable ? [...note.keyPointsTable.headers, ...note.keyPointsTable.rows.flat()] : []),
    ...note.cautions.flatMap((c) => [c.title, c.text, ...(c.bullets ?? []), ...(c.table ? [...c.table.headers, ...c.table.rows.flat()] : [])]),
    ...note.details.flatMap(texts),
  ].filter((t): t is string => !!t);
}

describe("how an answer becomes a clinical note", () => {
  it("summary -> clinical summary; the first plain section's bullets -> key points; warnings -> caution; the rest -> details", () => {
    const note = buildClinicalNote(
      answer([
        { title: "Key points", bullets: ["Contraindicated if **eGFR < 30** [1]", "Review dose if eGFR 30–45", "Stop before contrast"], citations: [1] },
        { title: "Lactic acidosis", kind: "warning", content: "Withhold during dehydration.", citations: [1] },
        { title: "Monitoring", content: "Check eGFR yearly.", callout: { type: "info", text: "Applies to adults." } },
      ]),
    );

    expect(note.summary).toBe("Headline.");
    expect(note.keyPoints).toEqual(["Contraindicated if **eGFR < 30** [1]", "Review dose if eGFR 30–45", "Stop before contrast"]);
    expect(note.cautions).toEqual([{ level: "warning", title: "Lactic acidosis", text: "Withhold during dehydration.", bullets: undefined, table: undefined, citations: [1] }]);
    expect(note.details.map((d) => d.title)).toEqual(["Monitoring"]);
    expect(note.details[0]).toMatchObject({ content: "Check eGFR yearly.", callout: { type: "info", text: "Applies to adults." } });
  });

  it("shows only the first five bullets as key points; the others follow under More details, in order", () => {
    const bullets = ["one", "two", "three", "four", "five", "six", "seven"];
    const note = buildClinicalNote(answer([{ title: "Points", bullets }]));
    expect(note.keyPoints).toEqual(bullets.slice(0, MAX_KEY_POINTS));
    expect(note.details).toEqual([{ title: "Points", bullets: ["six", "seven"] }]);
  });

  it("never cuts a procedure: ordered steps are all shown, numbered", () => {
    const steps = ["a", "b", "c", "d", "e", "f", "g"];
    const note = buildClinicalNote(answer([{ title: "Steps", kind: "instruction", numbered: true, bullets: steps }]));
    expect(note.keyPoints).toEqual(steps);
    expect(note.keyPointsNumbered).toBe(true);
    expect(note.details).toEqual([]);
  });

  it("a section that is only a paragraph becomes a single key point, so the answer is never hidden", () => {
    const note = buildClinicalNote(answer([{ title: "Dose", content: "500 mg twice daily with meals." }], { summary: undefined }));
    expect(note.keyPoints).toEqual(["500 mg twice daily with meals."]);
    expect(note.summary).toBeUndefined();
    expect(note.details).toEqual([]);
  });

  it("keeps the paragraph that elaborates on bullets, under More details", () => {
    const note = buildClinicalNote(answer([{ title: "Points", content: "Longer explanation.", bullets: ["a", "b", "c"] }]));
    expect(note.keyPoints).toEqual(["a", "b", "c"]);
    expect(note.details).toEqual([{ title: "Points", content: "Longer explanation." }]);
  });

  it("a dose table in the key-points section stays with the key points", () => {
    const table = { headers: ["Group", "Dose"], rows: [["Adults", "500 mg"]] };
    const note = buildClinicalNote(answer([{ title: "Dose", table }]));
    expect(note.keyPointsTable).toEqual(table);
    expect(note.details).toEqual([]);
    const later = buildClinicalNote(answer([{ title: "Points", bullets: ["a"] }, { title: "Doses", table }]));
    expect(later.keyPointsTable).toBeUndefined();
    expect(later.details[0]!.table).toEqual(table); // a later section's table is detail
  });
});

describe("cautions are never collapsed", () => {
  it("lifts important, warning and critical callouts out of ANY section, strongest first", () => {
    const note = buildClinicalNote(
      answer([
        { title: "Points", bullets: ["a"], callout: { type: "important", text: "Take with food." } },
        { title: "Later detail", content: "More.", callout: { type: "critical", label: "Seek help", text: "Stop and seek urgent help if jaundice appears." } },
        { title: "Another", content: "Even more.", callout: { type: "warning", text: "Avoid in pregnancy." } },
      ]),
    );
    expect(note.cautions.map((c) => [c.level, c.text])).toEqual([
      ["critical", "Stop and seek urgent help if jaundice appears."],
      ["warning", "Avoid in pregnancy."],
      ["important", "Take with food."],
    ]);
    expect(note.cautions[0]).toMatchObject({ label: "Seek help" });
    expect(note.details.flatMap((d) => (d.callout ? [d.callout.type] : []))).toEqual([]); // lifted, not repeated
  });

  it("warning and critical sections go to the caution box with their bullets and table, keeping their own heading", () => {
    const table = { headers: ["Sign", "Action"], rows: [["Jaundice", "Stop"]] };
    const note = buildClinicalNote(
      answer([
        { title: "Points", bullets: ["a"] },
        { title: "Red flags", kind: "critical", bullets: ["Jaundice", "Dark urine"], table, citations: [2] },
      ]),
    );
    expect(note.cautions).toEqual([{ level: "critical", title: "Red flags", text: undefined, bullets: ["Jaundice", "Dark urine"], table, citations: [2] }]);
    expect(note.details).toEqual([]);
  });

  it("a warning that opens the answer is not mistaken for the key points", () => {
    const note = buildClinicalNote(answer([{ title: "Warning", kind: "warning", content: "Do not crush." }, { title: "Use", bullets: ["Swallow whole"] }]));
    expect(note.keyPoints).toEqual(["Swallow whole"]);
    expect(note.cautions.map((c) => c.text)).toEqual(["Do not crush."]);
  });

  it("an answer made only of warnings has a caution box and no key points", () => {
    const note = buildClinicalNote(answer([{ title: "Warning", kind: "critical", content: "Contraindicated in pregnancy." }]));
    expect(note.keyPoints).toEqual([]);
    expect(note.cautions).toHaveLength(1);
  });

  it("shows a caution written twice (as a section and as a callout) once", () => {
    const note = buildClinicalNote(
      answer([
        { title: "Points", bullets: ["a"] },
        { title: "Warning", kind: "warning", content: "Avoid in **pregnancy** [1].", callout: { type: "warning", text: "Avoid in pregnancy." } },
      ]),
    );
    expect(note.cautions).toHaveLength(1);
  });

  it("info and quote callouts are notes, not cautions: they wait under More details", () => {
    const note = buildClinicalNote(answer([{ title: "Points", bullets: ["a"], callout: { type: "quote", label: "What to say", text: "Take it with food." } }]));
    expect(note.cautions).toEqual([]);
    expect(note.details[0]!.callout).toMatchObject({ type: "quote" });
  });

  it("an info callout inside a warning section is kept (under More details), not lost", () => {
    const note = buildClinicalNote(answer([{ title: "Points", bullets: ["a"] }, { title: "Warning", kind: "warning", content: "Avoid X.", callout: { type: "info", text: "Applies to adults." } }]));
    expect(note.cautions.map((c) => c.text)).toEqual(["Avoid X."]);
    expect(note.details).toEqual([{ title: "Warning", kind: "warning", callout: { type: "info", text: "Applies to adults." } }]);
  });
});

describe("answers the documents don't establish", () => {
  it("have only a summary: no key points, cautions or details", () => {
    const note = buildClinicalNote({ found: false, summary: "Not found in the available documents.", sections: [], sources: [], language: "en" });
    expect(note).toMatchObject({ found: false, summary: "Not found in the available documents.", keyPoints: [], cautions: [], details: [] });
  });
});

describe("nothing is dropped or rewritten", () => {
  it("every string the model wrote is somewhere in the note, exactly once", () => {
    const sections: AIResponseSection[] = [
      { title: "Points", content: "Elaboration.", bullets: ["b1", "b2", "b3", "b4", "b5", "b6"], callout: { type: "quote", text: "Say this." } },
      { title: "Warn", kind: "warning", content: "W text.", bullets: ["w1"], callout: { type: "important", text: "I text." } },
      { title: "Extra", kind: "instruction", numbered: true, bullets: ["s1", "s2"], table: { headers: ["H"], rows: [["r"]] }, callout: { type: "critical", text: "C text." } },
    ];
    const note = buildClinicalNote(answer(sections));
    const shown = everyText(note);
    const expected = [...sections.flatMap(texts), "Headline."];
    for (const text of expected) expect(shown.filter((t) => t === text).length, text).toBe(1);
    expect(shown.length).toBe(expected.length);
  });

  it("older answers (no kind, tab or table) arrange the same way", () => {
    const note = buildClinicalNote({ found: true, title: "t", sections: [{ title: "s", content: "c", citations: [1] }], sources: [], language: "en" });
    expect(note.keyPoints).toEqual(["c"]);
    expect(note.cautions).toEqual([]);
  });
});

describe("the 10-15 second goal", () => {
  it("a routine answer written to the prompt's shape reads in about 40-70 words without opening anything", () => {
    const note = buildClinicalNote(
      answer(
        [
          {
            title: "Key points",
            bullets: ["**Contraindicated** if **eGFR < 30 mL/min/1.73 m²** [1]", "If **eGFR 30–44**, review the dose; do not start new patients [1]", "Stop **before iodinated contrast** and restart after 48 h with stable renal function [2]"],
            citations: [1, 2],
          },
          { title: "Lactic acidosis", kind: "warning", content: "Withhold during acute illness with dehydration, sepsis or hypoxia [1].", citations: [1] },
          { title: "Monitoring", content: "Check eGFR at least yearly, and every 3-6 months in patients at risk.", table: { headers: ["eGFR", "Action"], rows: [["≥ 60", "Continue"]] } },
        ],
        { summary: "Avoid **metformin** when **eGFR is below 30 mL/min/1.73 m²** [1]." },
      ),
    );
    const words = visibleWordCount(note);
    expect(words).toBeGreaterThanOrEqual(40);
    expect(words).toBeLessThanOrEqual(70);
    expect(note.details.map((d) => d.title)).toEqual(["Monitoring"]); // the long material waits
  });

  it("counts only what is visible: markers and ** are not words, collapsed details are not counted", () => {
    const note = buildClinicalNote(answer([{ title: "P", bullets: ["one **two** [1]"] }, { title: "D", content: "many many many many many" }], { summary: "Three words here [1]." }));
    expect(visibleWordCount(note)).toBe(3 + 2);
  });
});

describe("the instructions given to the model match this layout", () => {
  const prompt = buildSystemPrompt({ structured: true, languageName: "English" });

  it("asks for a one-sentence clinical summary, 3-5 short key points, cautions in the caution box and detail only when useful", () => {
    expect(prompt).toMatch(/ONE short sentence/);
    expect(prompt).toMatch(/3 to 5 short bullets/);
    expect(prompt).toMatch(/"Important \/ Caution" box/);
    expect(prompt).toMatch(/collapsed under "More details"/);
    expect(prompt).toMatch(/about 40-70 words/);
  });

  it("removes the chat filler, and never trades a warning or a unit for brevity", () => {
    expect(prompt).toMatch(/no greetings, introductions, background, repeated points, closing remarks/);
    expect(prompt).toMatch(/Never shorten or drop a warning, contraindication, dose, unit, value or condition/);
  });

  it("keeps the grounding and no-invention rules, and says what to do when the sources only partly answer", () => {
    expect(prompt).toMatch(/Answer using ONLY the numbered sources/);
    expect(prompt).toMatch(/Never invent warnings, doses, contraindications, red flags or advice/);
    expect(prompt).toMatch(/say plainly[^.]*what they do not establish/);
    expect(prompt).toMatch(/Never fill the answer with general knowledge/);
  });

  it("does not change the schema or the retrieval prompt: only the output rules differ", () => {
    expect(buildSystemPrompt({ structured: false, languageName: "English" })).not.toMatch(/Important \/ Caution/);
  });
});

describe("language labels for the note", () => {
  it("every language has every label, and only Latin-script languages are italic", () => {
    for (const l of LANGUAGES) {
      expect(Object.values(l.ui.note).every((v) => typeof v === "string" && v.length > 0), l.code).toBe(true);
    }
    expect(LANGUAGES.map((l) => [l.code, l.italic])).toEqual([["en", true], ["hi", false], ["gu", false]]);
    expect(LANGUAGES.map((l) => [l.code, l.script])).toEqual([["en", "latin"], ["hi", "devanagari"], ["gu", "gujarati"]]); // checked against every translation
    expect(LANGUAGES[0]!.ui.note).toMatchObject({ clinicalSummary: "Clinical summary", keyPoints: "Key points", caution: "Important / Caution", reference: "Reference", moreDetails: "More details" });
  });
});
