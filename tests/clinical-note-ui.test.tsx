// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIResponse } from "@/lib/ai-response";
import type { CitationDTO, MessageDTO } from "@/lib/types";

const apiMock = vi.hoisted(() => ({ setMessageLanguage: vi.fn(), speech: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { InlineText } from "@/components/chat/Markdown";
import { AssistantBubble, FailedAssistantBubble, PendingAssistantBubble } from "@/components/chat/MessageBubble";
import { StructuredAIResponse } from "@/components/chat/answer/StructuredAIResponse";

const citation = (index: number, over: Partial<CitationDTO> = {}): CitationDTO => ({
  index,
  source: "knowledge_base",
  documentId: `d${index}`,
  filename: "Metformin.pdf",
  pageStart: index === 1 ? 6 : 9,
  pageEnd: index === 1 ? 6 : 9,
  excerpt: index === 1 ? "Metformin is contraindicated when eGFR is below 30 mL/min/1.73 m²." : "Withhold metformin before iodinated contrast media.",
  score: 0.81,
  cited: true,
  ...over,
});

const routine = (over: Partial<AIResponse> = {}): AIResponse => ({
  found: true,
  title: "Metformin in renal impairment",
  summary: "Avoid **metformin** when **eGFR is below 30 mL/min/1.73 m²** [1].",
  sections: [
    { title: "Key points", kind: "info", bullets: ["**Contraindicated** if **eGFR < 30** [1]", "Review the dose if **eGFR 30–44** [1]", "Stop **before iodinated contrast** [2]"], citations: [1, 2] },
    { title: "Lactic acidosis", kind: "warning", content: "Withhold during acute illness with **dehydration** [1].", citations: [1] },
    {
      title: "Monitoring schedule",
      kind: "info",
      content: "Check eGFR yearly; every 3–6 months if at risk.",
      table: { headers: ["eGFR", "Action"], rows: [["≥ 60", "Continue"], ["30–44", "Reduce dose"]] },
      callout: { type: "info", text: "Applies to adults." },
      citations: [2],
    },
  ],
  sources: [
    { documentId: "d1", documentName: "Metformin.pdf", pageStart: 6, pageEnd: 6, citationIndexes: [1], origin: "knowledge_base", excerpt: "x" },
    { documentId: "d2", documentName: "Metformin.pdf", pageStart: 9, pageEnd: 9, citationIndexes: [2], origin: "knowledge_base", excerpt: "y" },
  ],
  language: "en",
  ...over,
});

const message = (structured: AIResponse | null, over: Partial<MessageDTO> = {}): MessageDTO => ({
  id: "m1",
  role: "assistant",
  content: "Plain text of the answer [1].",
  citations: [citation(1), citation(2)],
  attachments: [],
  structured,
  language: "en",
  provider: "openai",
  model: "gpt-test",
  noContext: false,
  createdAt: "2026-10-14T10:00:00.000Z",
  ...over,
});

const show = (m: MessageDTO) => render(<StructuredAIResponse message={m} onMessageUpdate={vi.fn()} />);
/** Inside a collapsed "More details" the content is in the page but hidden. */
const hiddenBehindDetails = (el: Element) => el.closest("[hidden]") !== null;
const details = () => document.getElementById("resp-m1-details")!;
const toggle = () => screen.getByRole("button", { name: /^(More details|Hide details|Source passages)/ });

let clipboard: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
});
afterEach(cleanup);

describe("the clinical note layout", () => {
  it("shows a compact header, an italic clinical summary, key points, the reference and a More details control", () => {
    show(message(routine()));

    expect(screen.getByRole("heading", { name: "Metformin in renal impairment" })).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Clinical summary" });
    const sentence = within(summary).getByText(/Avoid/, { selector: "p" });
    expect(sentence.className).toMatch(/\bitalic\b/);
    const points = screen.getByRole("region", { name: "Key points" });
    const items = within(points).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    for (const item of items) expect(item.className).toMatch(/\bitalic\b/);
    expect(screen.getByRole("region", { name: "Reference" })).toBeTruthy();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // The four blocks come in the order a clinician reads them.
    const order = ["Clinical summary", "Key points", "Important / Caution", "Reference"].map((name) => screen.getByRole("region", { name }));
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps values, drug names and warnings in upright bold inside the italic text, so they stand out", () => {
    show(message(routine()));
    const summary = screen.getByRole("region", { name: "Clinical summary" });
    const strong = within(summary).getByText("eGFR is below 30 mL/min/1.73 m²");
    expect(strong.tagName).toBe("STRONG");
    expect(strong.className).toMatch(/font-semibold/);
    expect(strong.className).toMatch(/not-italic/);
    expect(within(screen.getByRole("region", { name: "Key points" })).getByText("Contraindicated").tagName).toBe("STRONG");
  });

  it("shows the caution box without opening anything, with a text label and icon (not colour alone)", () => {
    show(message(routine()));

    const caution = screen.getByRole("region", { name: "Important / Caution" });
    expect(hiddenBehindDetails(caution)).toBe(false);
    expect(within(caution).getByText("Warning")).toBeTruthy(); // the level's own word
    expect(within(caution).getByText("Lactic acidosis", { exact: false })).toBeTruthy();
    expect(within(caution).getByText(/Withhold during acute illness/)).toBeTruthy();
    expect(caution.querySelector("svg")).toBeTruthy();
    expect(caution.getAttribute("data-level")).toBe("warning");
    expect(toggle().getAttribute("aria-expanded")).toBe("false"); // and it is shown while the details are collapsed
  });

  it("orders cautions strongest first and marks the box by its strongest level", () => {
    const response = routine({
      sections: [
        { title: "Key points", bullets: ["a"], callout: { type: "important", text: "Take with food." } },
        { title: "Red flags", kind: "critical", content: "Stop and seek **urgent help** if jaundice appears." },
        { title: "Pregnancy", kind: "warning", content: "Avoid in pregnancy." },
      ],
    });
    show(message(response));

    const caution = screen.getByRole("region", { name: "Important / Caution" });
    expect(caution.getAttribute("data-level")).toBe("critical");
    expect(within(caution).getAllByRole("listitem").map((li) => li.getAttribute("data-level"))).toEqual(["critical", "warning", "important"]);
  });

  it("doesn't repeat the level's own word as the heading, but keeps a heading that adds something", () => {
    show(
      message(
        routine({
          sections: [
            { title: "Key points", bullets: ["a"] },
            { title: "Red flags", kind: "critical", bullets: ["Jaundice"] },
            { title: "Pregnancy", kind: "warning", content: "Avoid." },
          ],
        }),
      ),
    );
    const items = within(screen.getByRole("region", { name: "Important / Caution" })).getAllByRole("listitem").filter((li) => li.hasAttribute("data-level"));
    expect(items.map((li) => li.querySelector("p")!.textContent)).toEqual(["Red flag", "Warning — Pregnancy"]);
  });

  it("has no caution box when the sources state none (a simple answer shows no empty sections)", () => {
    show(message(routine({ sections: [{ title: "Key points", bullets: ["500 mg twice daily with meals [1]", "Titrate every 1–2 weeks [1]"], citations: [1] }] }), { citations: [citation(1)] }));
    expect(screen.queryByRole("region", { name: "Important / Caution" })).toBeNull();
    expect(screen.getByRole("region", { name: "Key points" })).toBeTruthy();
  });

  it("omits the clinical summary when the model gave none", () => {
    show(message(routine({ summary: undefined })));
    expect(screen.queryByRole("region", { name: "Clinical summary" })).toBeNull();
  });
});

describe("More details", () => {
  it("is collapsed at first and holds the further sections, a table and the retrieved passages", () => {
    show(message(routine()));

    expect(details().hidden).toBe(true);
    expect(within(details()).getByText("Monitoring schedule")).toBeTruthy();
    expect(within(details()).getByText("Reduce dose")).toBeTruthy(); // the table
    expect(within(details()).getByText("Applies to adults.")).toBeTruthy(); // an info note
    expect(within(details()).getByText(/Metformin is contraindicated when eGFR/)).toBeTruthy(); // the passage behind the first source
    expect(hiddenBehindDetails(within(details()).getByText("Reduce dose"))).toBe(true);
  });

  it("expands and collapses, and says so to assistive technology", () => {
    show(message(routine()));
    const button = toggle();
    expect(button.getAttribute("aria-controls")).toBe("resp-m1-details");

    fireEvent.click(button);
    expect(details().hidden).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.textContent).toBe("Hide details");

    fireEvent.click(button);
    expect(details().hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toBe("More details");
  });

  it("is not offered when there is nothing more to show", () => {
    show(message(routine({ sections: [{ title: "Key points", bullets: ["a", "b", "c"] }] }), { citations: [] }));
    expect(screen.queryByRole("button", { name: /More details|Hide details|Source passages/ })).toBeNull();
  });

  it("with nothing but evidence, offers the source passages", () => {
    show(message(routine({ sections: [{ title: "Key points", bullets: ["a", "b", "c"] }] })));
    expect(toggle().textContent).toBe("Source passages (2)");
  });
});

describe("references and citations stay clickable", () => {
  it("lists each source as a chip with document and page, always visible", () => {
    show(message(routine()));
    const reference = screen.getByRole("region", { name: "Reference" });
    expect(hiddenBehindDetails(reference)).toBe(false);
    const chips = within(reference).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Metformin.pdf — Page 6", "Metformin.pdf — Page 9"]);
  });

  it("a reference chip opens More details at that passage and highlights it", () => {
    show(message(routine()));
    fireEvent.click(within(screen.getByRole("region", { name: "Reference" })).getByRole("button", { name: /Page 9/ }));

    expect(details().hidden).toBe(false);
    expect(document.getElementById("src-m1-2")!.className).toMatch(/border-brand-600/);
    return waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("an inline [n] marker in the summary opens the same passage, labelled with its page", () => {
    show(message(routine()));
    const marker = within(screen.getByRole("region", { name: "Clinical summary" })).getByRole("button", { name: /Source 1: Metformin.pdf — Page 6/ });
    expect(marker.textContent).toBe("p. 6");

    fireEvent.click(marker);

    expect(details().hidden).toBe(false);
    expect(document.getElementById("src-m1-1")!.className).toMatch(/border-brand-600/);
  });

  it("shows the whole passage list with page, cited marker and similarity when expanded", () => {
    show(message(routine()));
    fireEvent.click(toggle());
    const passage = document.getElementById("src-m1-1")!;
    expect(within(passage).getByText("Page 6")).toBeTruthy();
    expect(passage.textContent).toMatch(/cited · 0\.81/);
  });
});

describe("source-backed or not", () => {
  it("an answer that cites nothing says so instead of looking source-backed", () => {
    show(message(routine({ sources: [] }), { citations: [] }));
    expect(screen.queryByRole("region", { name: "Reference" })).toBeNull();
    expect(screen.getByText(/No source is cited for this answer/)).toBeTruthy();
  });

  it("an answer the documents don't establish is shown as such, in a neutral box with no sections", () => {
    show(message({ found: false, title: "Dosing in pregnancy", summary: "I couldn't find this information in the available documents.", sections: [], sources: [], language: "en" }, { citations: [] }));

    const note = screen.getByRole("note");
    expect(within(note).getByText("Not established by your documents")).toBeTruthy();
    expect(within(note).getByText(/couldn't find this information/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Key points" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Reference" })).toBeNull();
    expect(screen.queryByText(/No source is cited/)).toBeNull(); // nothing to cite is not a missing citation
  });

  it("a plain-text answer (older or unstructured) keeps its text, with its references, in the same card", () => {
    show(message(null, { content: "Metformin is **contraindicated** below eGFR 30 [1].\n- Stop before contrast [2]" }));
    expect(screen.getByText("contraindicated").tagName).toBe("STRONG");
    expect(screen.getByText(/Stop before contrast/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Reference" })).getAllByRole("button")).toHaveLength(2);
    expect(screen.queryByRole("region", { name: "Clinical summary" })).toBeNull();
  });

  it("a plain 'nothing found' message is shown the same way as a structured one", () => {
    show(message(null, { noContext: true, content: "I couldn't find this information in the available documents.", citations: [] }));
    expect(within(screen.getByRole("note")).getByText("Not established by your documents")).toBeTruthy();
  });
});

describe("languages and typography", () => {
  const hindi = routine({
    title: "रीनल कमी में मेटफॉर्मिन",
    summary: "eGFR 30 से कम होने पर मेटफॉर्मिन से बचें [1]।",
    language: "hi",
  });

  it("uses the labels of the response language and does not slant Devanagari or Gujarati text", () => {
    show(message(hindi, { language: "hi" }));

    const summary = screen.getByRole("region", { name: "नैदानिक सारांश" });
    expect(within(summary).getByText(/eGFR 30/, { selector: "p" }).className).not.toMatch(/\bitalic\b/);
    expect(screen.getByRole("region", { name: "मुख्य बिंदु" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "महत्वपूर्ण / सावधानी" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "संदर्भ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /अधिक विवरण/ })).toBeTruthy();
    for (const item of within(screen.getByRole("region", { name: "मुख्य बिंदु" })).getAllByRole("listitem")) expect(item.className).not.toMatch(/\bitalic\b/);
  });

  it("keeps the spaced-out small headings normal in Devanagari and Gujarati (letter-spacing breaks their joined letters)", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    expect(css).toMatch(/:lang\(hi\) \.tracking-wide,\s*:lang\(gu\) \.tracking-wide\s*\{\s*letter-spacing: normal;/);
  });

  it("the content block carries the response language, for correct fonts and screen readers", () => {
    show(message(hindi, { language: "hi" }));
    expect(screen.getByRole("region", { name: "नैदानिक सारांश" }).closest("[lang]")!.getAttribute("lang")).toBe("hi");
  });

  it("changing the response language still goes through the same menu, updating this message in place", async () => {
    const updated = message(hindi, { language: "hi" });
    apiMock.setMessageLanguage.mockResolvedValue(updated);
    const onMessageUpdate = vi.fn();
    render(<StructuredAIResponse message={message(routine())} onMessageUpdate={onMessageUpdate} onLanguageChosen={vi.fn()} />);

    expect(screen.getAllByRole("radio")).toHaveLength(3);
    fireEvent.click(screen.getByRole("radio", { name: "Hindi" }));

    await waitFor(() => expect(onMessageUpdate).toHaveBeenCalledWith(updated));
    expect(apiMock.setMessageLanguage).toHaveBeenCalledWith("m1", "hi", expect.any(AbortSignal));
  });

  it("*italic* and **bold** markdown render as emphasis and bold; stray asterisks stay as typed", () => {
    const { container } = render(<InlineText text="Use *only* with food: **500 mg** [1]; 5 * 3 * 2 stays" maxCitation={1} onCite={vi.fn()} />);
    expect(container.querySelector("em")!.textContent).toBe("only");
    expect(container.querySelector("strong")!.textContent).toBe("500 mg");
    expect(container.textContent).toContain("5 * 3 * 2 stays");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("inside the italic note, emphasis goes upright (the usual rule), so it still stands out", () => {
    const { container } = render(<InlineText text="Take *with food*" maxCitation={0} onCite={vi.fn()} italicContext />);
    expect(container.querySelector("em")!.className).toMatch(/not-italic/);
  });
});

describe("copy answer", () => {
  it("copies the whole note as plain text in reading order: summary, key points, cautions, details, reference", async () => {
    show(message(routine()));
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));

    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    const text = clipboard.mock.calls[0]![0] as string;
    expect(text).toContain("Metformin in renal impairment");
    expect(text).toContain("Clinical summary: Avoid metformin when eGFR is below 30 mL/min/1.73 m².");
    expect(text).toMatch(/Key points:\n- Contraindicated if eGFR < 30\n- Review the dose if eGFR 30–44\n- Stop before iodinated contrast/);
    expect(text).toMatch(/Important \/ Caution:\n- Warning — Lactic acidosis: Withhold during acute illness with dehydration\./);
    expect(text).toMatch(/More details:\nMonitoring schedule\nCheck eGFR yearly; every 3–6 months if at risk\.\neGFR \| Action\n≥ 60 \| Continue\n30–44 \| Reduce dose\nNote: Applies to adults\./);
    expect(text).toContain("Reference: Metformin.pdf — Page 6; Metformin.pdf — Page 9");
    expect(text).not.toMatch(/\*\*|\[\d\]/); // display markers are gone
    expect(text.indexOf("Clinical summary")).toBeLessThan(text.indexOf("Key points"));
    expect(text.indexOf("Key points")).toBeLessThan(text.indexOf("Important / Caution"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("copies a not-established answer as one honest line, and a plain answer as its own text", async () => {
    show(message({ found: false, summary: "Not in the documents.", sections: [], sources: [], language: "en" }, { citations: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(clipboard).toHaveBeenCalledWith("Not established by your documents: Not in the documents."));

    cleanup();
    show(message(null, { content: "Plain answer [1]." }));
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith("Plain answer [1]."));
  });
});

describe("the card around the note", () => {
  it("carries a one-line reminder to check the reference and use clinical judgment", () => {
    show(message(routine()));
    expect(screen.getByText(/AI-generated from your documents\. Check it against the reference and use clinical judgment\./)).toBeTruthy();
  });

  it("keeps the provider, model and time in the footer", () => {
    show(message(routine()));
    expect(screen.getByText(/OpenAI · gpt-test/)).toBeTruthy();
  });

  it("is one article per answer, within a readable column", () => {
    const { container } = show(message(routine()));
    const article = container.querySelector("article")!;
    expect(article.getAttribute("aria-label")).toBe("AI response");
    expect(article.className).toMatch(/max-w-3xl/);
    expect(container.querySelectorAll("article")).toHaveLength(1);
  });

  it("has no dark theme leftovers: it uses the light palette of the rest of the chat", () => {
    const { container } = show(message(routine()));
    expect(container.innerHTML).not.toMatch(/navy-|text-slate-(100|200|300)\b|text-orange-(100|200|300)\b|bg-orange-(400|500)\b/); // light-on-dark text and accents from the old navy card
  });

  it("shows a skeleton shaped like the note while an answer is prepared, and a plain error with Try again", () => {
    render(<PendingAssistantBubble />);
    expect(screen.getByRole("article", { name: "AI is preparing your answer" }).getAttribute("aria-busy")).toBe("true");
    cleanup();

    const retry = vi.fn();
    render(<FailedAssistantBubble message="The provider is unavailable." onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("The provider is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(retry).toHaveBeenCalled();
  });

  it("AssistantBubble renders the same note", () => {
    render(<AssistantBubble message={message(routine())} onMessageUpdate={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Key points" })).toBeTruthy();
  });
});
