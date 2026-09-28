import { describe, expect, it } from "vitest";
import { parseAIResponse } from "@/lib/ai-response";
import { LANGUAGES } from "@/lib/languages";
import { buildSystemPrompt } from "@/server/rag/prompt";
import { normalizeModelAnswer, RESPONSE_JSON_SCHEMA, structuredToText } from "@/server/rag/structured";

// The counselling-style answer card: tabs, section kinds, lists, tables and callouts come from the
// model's structured output, normalized strictly. Content is never invented by the app.

const section = (over: Record<string, unknown> = {}) => ({
  title: "Most common adverse reactions",
  tab: "Side effects",
  kind: "info",
  content: "Diarrhea and nausea are the most common [1].",
  bullets: [],
  numbered: false,
  table: { headers: [], rows: [] },
  callout: { type: "none", label: "", text: "" },
  citations: [1],
  ...over,
});

describe("layout fields in the provider schema", () => {
  it("requires every field (OpenAI strict mode) and offers the new callout types", () => {
    const item = RESPONSE_JSON_SCHEMA.properties.sections.items;
    expect(item.required).toEqual(["title", "tab", "kind", "content", "bullets", "numbered", "table", "callout", "citations"]);
    expect(item.properties.callout.properties.type.enum).toEqual(["none", "info", "important", "warning", "critical", "quote"]);
    expect(item.properties.kind.enum).toEqual(["info", "instruction", "warning", "critical"]);
  });

  it("tells the model to choose tabs from the sources and never invent warnings", () => {
    const prompt = buildSystemPrompt({ structured: true, languageName: "English" });
    expect(prompt).toMatch(/never from a fixed list/);
    expect(prompt).toMatch(/Never invent warnings, doses, contraindications, red flags or advice/);
    expect(prompt).toMatch(/"critical" only for urgent/);
    expect(buildSystemPrompt({ structured: true, languageName: "Hindi" })).toMatch(/section titles, tabs, content/);
  });
});

describe("normalizing layout fields", () => {
  it("keeps tab, kind, numbered steps, tables and labelled callouts", () => {
    const out = normalizeModelAnswer(
      {
        found: true,
        title: "Adverse reactions",
        summary: "",
        sections: [
          section({
            kind: "instruction",
            bullets: ["Start with a low dose [1]", "Increase slowly [1]"],
            numbered: true,
            table: { headers: ["Group", "Dose"], rows: [["Adults", "500 mg"], ["Children"]] },
            callout: { type: "quote", label: "What to say", text: "Take it with food." },
          }),
          section({ tab: "Red flags", kind: "critical", callout: { type: "critical", label: "", text: "Seek urgent help if …" } }),
        ],
      },
      3,
      "not found",
    )!;
    expect(out.sections[0]).toMatchObject({
      tab: "Side effects",
      kind: "instruction",
      numbered: true,
      table: { headers: ["Group", "Dose"], rows: [["Adults", "500 mg"], ["Children", ""]] },
      callout: { type: "quote", label: "What to say", text: "Take it with food." },
    });
    expect(out.sections[1]).toMatchObject({ tab: "Red flags", kind: "critical", callout: { type: "critical", text: "Seek urgent help if …" } });
    expect(out.sections[1]!.callout).not.toHaveProperty("label"); // "" = use the default label
    expect(parseAIResponse({ ...out, sources: [], language: "en" })).not.toBeNull();
  });

  it("drops empty or invalid layout values instead of guessing", () => {
    const out = normalizeModelAnswer(
      { found: true, title: "t", sections: [section({ tab: "  ", kind: "emergency", numbered: true, bullets: ["only one"], callout: { type: "shout", text: "x" } })] },
      1,
      "nf",
    )!;
    const s = out.sections[0]!;
    expect(s).not.toHaveProperty("tab");
    expect(s).not.toHaveProperty("kind"); // unknown kind → normal information
    expect(s).not.toHaveProperty("numbered"); // a single bullet is not a list of steps
    expect(s).not.toHaveProperty("table"); // empty headers/rows
    expect(s.callout).toBeUndefined();
  });

  it("older stored answers (no tab/kind/table) still validate", () => {
    const old = { found: true, title: "t", sections: [{ title: "s", content: "c", citations: [1] }], sources: [], language: "en" };
    expect(parseAIResponse(old)).not.toBeNull();
    expect(parseAIResponse({ ...old, sections: [{ title: "s", callout: { type: "warning", text: "w" } }] })).not.toBeNull();
  });

  it("plain-text version includes steps, table rows and callout labels", () => {
    const text = structuredToText({
      found: true,
      title: "T",
      sections: [
        {
          title: "Steps",
          bullets: ["a", "b"],
          numbered: true,
          table: { headers: ["H1", "H2"], rows: [["x", "y"]] },
          callout: { type: "quote", label: "What to say", text: "Hello" },
          citations: [1],
        },
      ],
    });
    expect(text).toContain("1. a\n2. b");
    expect(text).toContain("H1 | H2\nx | y");
    expect(text).toContain("WHAT TO SAY: Hello");
  });
});

describe("fixed card labels per language", () => {
  it("every language has a short switch label and translated card labels", () => {
    for (const l of LANGUAGES) {
      expect(l.shortLabel).toBeTruthy();
      expect(Object.values(l.ui.callouts).every(Boolean)).toBe(true);
      expect(l.ui.overview && l.ui.sources && l.ui.source).toBeTruthy();
    }
    expect(LANGUAGES.map((l) => l.shortLabel)).toEqual(["EN", "हिन्दी", "ગુજરાતી"]);
  });
});
