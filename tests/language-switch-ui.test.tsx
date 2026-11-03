// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIResponse } from "@/lib/ai-response";
import type { MessageDTO } from "@/lib/types";

const apiMock = vi.hoisted(() => ({ setMessageLanguage: vi.fn(), speech: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { StructuredAIResponse } from "@/components/chat/answer/StructuredAIResponse";

const structured = (title: string, language: string): AIResponse => ({
  found: true,
  title,
  summary: `${title} summary`,
  sections: [{ title: "Key points", bullets: [`${title} point`], citations: [1] }],
  sources: [{ documentId: "d1", documentName: "Guide.pdf", pageStart: 6, pageEnd: 6, citationIndexes: [1], origin: "knowledge_base", excerpt: "x" }],
  language,
});
const message = (language = "en", title = "Original answer"): MessageDTO => ({
  id: "m1",
  role: "assistant",
  content: title,
  citations: [{ index: 1, documentId: "d1", filename: "Guide.pdf", pageStart: 6, pageEnd: 6, excerpt: "x", score: 0.8, cited: true }],
  attachments: [],
  structured: structured(title, language),
  language,
  provider: "gemini",
  model: "g",
  noContext: false,
  createdAt: "2026-10-14T10:00:00.000Z",
});

/** Requests the page made, each held until the test settles it (like a slow translation). */
interface Held {
  id: string;
  language: string;
  signal: AbortSignal | undefined;
  resolve: (m: MessageDTO) => void;
  reject: (e: Error) => void;
}
let held: Held[];
let chosen: string[];
let updates: MessageDTO[];

/** Holds the message in state like the chat page does. */
function Page({ initial }: { initial: MessageDTO }) {
  const [m, setM] = useState(initial);
  return (
    <StructuredAIResponse
      message={m}
      onMessageUpdate={(u) => {
        updates.push(u);
        setM(u);
      }}
      onLanguageChosen={(code) => chosen.push(code)}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  held = [];
  chosen = [];
  updates = [];
  Element.prototype.scrollIntoView = vi.fn();
  apiMock.setMessageLanguage.mockImplementation(
    (id: string, language: string, signal?: AbortSignal) =>
      new Promise<MessageDTO>((resolve, reject) => {
        held.push({ id, language, signal, resolve, reject });
      }),
  );
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true });
});
afterEach(cleanup);

const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLButtonElement;
const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
  });
};
const aborted = (h: Held) => h.signal?.aborted === true;

describe("while a language is being prepared", () => {
  it("keeps the current answer readable, shows a small indicator, and swaps the answer in when it is ready", async () => {
    render(<Page initial={message()} />);

    fireEvent.click(radio("Hindi"));

    expect(await screen.findByText(/Translating to हिन्दी/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Translating to हिन्दी");
    expect(screen.getByRole("status").querySelector(".animate-spin")).toBeTruthy(); // a small spinner beside the words
    expect(document.querySelector("[class*='animate-[language-progress']")).toBeTruthy(); // and a thin progress bar above the answer
    expect(screen.getByText("Original answer summary")).toBeTruthy(); // still there
    expect(screen.getByRole("article").getAttribute("aria-busy")).toBe("true");
    expect(radio("Hindi").querySelector(".animate-spin")).toBeTruthy(); // the spinner sits on the language being prepared
    expect(radio("Gujarati").querySelector(".animate-spin")).toBeNull();
    expect(radio("English").getAttribute("aria-checked")).toBe("true"); // and the shown language doesn't move until it is ready
    expect(apiMock.setMessageLanguage).toHaveBeenCalledWith("m1", "hi", expect.any(AbortSignal));
    expect(updates).toEqual([]);

    await settle(() => held[0]!.resolve(message("hi", "हिन्दी उत्तर")));

    expect(screen.getByText("हिन्दी उत्तर summary")).toBeTruthy();
    expect(screen.queryByText("Original answer summary")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("[class*='animate-[language-progress']")).toBeNull(); // the indicator is gone
    expect(screen.getByRole("article").getAttribute("aria-busy")).toBe("false");
    expect(radio("Hindi").getAttribute("aria-checked")).toBe("true");
    expect(chosen).toEqual(["hi"]);
    expect(document.querySelector("div[lang='hi']")!.className).toMatch(/animate-\[fade-in/); // it fades in, not a hard swap
  });

  it("leaves the other languages usable: nothing is disabled", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");
    for (const name of ["English", "Hindi", "Gujarati"]) expect(radio(name).disabled).toBe(false);
  });
});

describe("clicking the same language again while it is being prepared", () => {
  it("sends it once: repeated clicks neither duplicate the request nor start it over", async () => {
    render(<Page initial={message()} />);

    for (let i = 0; i < 6; i++) fireEvent.click(radio("Gujarati"));
    await screen.findByRole("status");

    expect(held).toHaveLength(1);
    expect(aborted(held[0]!)).toBe(false);
    await settle(() => held[0]!.resolve(message("gu", "ગુજરાતી જવાબ")));
    expect(screen.getByText("ગુજરાતી જવાબ summary")).toBeTruthy();
    expect(held).toHaveLength(1);
    expect(updates.map((u) => u.language)).toEqual(["gu"]);
  });

  it("lets the same language be asked for again after it failed (Try again) or after another choice replaced it", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Gujarati"));
    await screen.findByRole("status");
    await settle(() => held[0]!.reject(new Error("The AI provider is busy.")));
    fireEvent.click(radio("Gujarati")); // after the failure it is a new request
    await waitFor(() => expect(held).toHaveLength(2));
    fireEvent.click(radio("Hindi"));
    await waitFor(() => expect(held).toHaveLength(3));
    fireEvent.click(radio("Gujarati")); // after Hindi replaced it, Gujarati is a new request again
    await waitFor(() => expect(held).toHaveLength(4));
    expect(aborted(held[1]!)).toBe(true);
    expect(aborted(held[3]!)).toBe(false);
  });
});

describe("choosing quickly, one language after another", () => {
  it("abandons the older request, never lets it overwrite the newer choice, and applies only the newest", async () => {
    render(<Page initial={message()} />);

    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");
    fireEvent.click(radio("Gujarati"));
    await waitFor(() => expect(held).toHaveLength(2));

    expect(aborted(held[0]!)).toBe(true); // the server is told to stop the Hindi translation
    expect(aborted(held[1]!)).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("ગુજરાતી");

    // The Hindi answer arrives anyway (it was already on its way): it must not be shown.
    await settle(() => held[0]!.resolve(message("hi", "हिन्दी उत्तर")));
    expect(screen.queryByText("हिन्दी उत्तर summary")).toBeNull();
    expect(screen.getByText("Original answer summary")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("ગુજરાતી"); // and it doesn't end the indicator of the newer request
    expect(updates).toEqual([]);

    await settle(() => held[1]!.resolve(message("gu", "ગુજરાતી જવાબ")));
    expect(screen.getByText("ગુજરાતી જવાબ summary")).toBeTruthy();
    expect(updates.map((u) => u.language)).toEqual(["gu"]);
    expect(chosen).toEqual(["gu"]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("applies the newest even when it finishes BEFORE the older one", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");
    fireEvent.click(radio("Gujarati"));
    await waitFor(() => expect(held).toHaveLength(2));

    await settle(() => held[1]!.resolve(message("gu", "ગુજરાતી જવાબ")));
    await settle(() => held[0]!.resolve(message("hi", "हिन्दी उत्तर"))); // late

    expect(screen.getByText("ગુજરાતી જવાબ summary")).toBeTruthy();
    expect(updates.map((u) => u.language)).toEqual(["gu"]);
  });

  it("choosing the language already shown cancels the pending one, with no request at all", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");

    fireEvent.click(radio("English")); // changed their mind

    expect(aborted(held[0]!)).toBe(true);
    expect(held).toHaveLength(1); // nothing new was requested
    expect(screen.queryByRole("status")).toBeNull();
    await settle(() => held[0]!.resolve(message("hi", "हिन्दी उत्तर"))); // arrives late
    expect(screen.getByText("Original answer summary")).toBeTruthy();
    expect(updates).toEqual([]);
    expect(chosen).toEqual([]);
  });

  it("many fast choices end with the last one only", async () => {
    render(<Page initial={message()} />);
    for (const name of ["Hindi", "Gujarati", "Hindi", "Gujarati", "Hindi"]) {
      fireEvent.click(radio(name));
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain(name === "Hindi" ? "हिन्दी" : "ગુજરાતી"));
    }
    expect(held.map((h) => h.language)).toEqual(["hi", "gu", "hi", "gu", "hi"]);
    expect(held.slice(0, 4).every(aborted)).toBe(true);
    expect(aborted(held[4]!)).toBe(false);

    for (const h of held.slice(0, 4)) await settle(() => h.resolve(message(h.language, `${h.language} old`)));
    expect(updates).toEqual([]);
    await settle(() => held[4]!.resolve(message("hi", "हिन्दी उत्तर")));
    expect(updates.map((u) => u.language)).toEqual(["hi"]);
    expect(screen.getByText("हिन्दी उत्तर summary")).toBeTruthy();
  });
});

describe("when it fails", () => {
  it("keeps the current answer, says why, and offers Try again", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");

    await settle(() => held[0]!.reject(new Error("The AI provider is busy. Try again in a moment.")));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Unable to generate the Hindi response.");
    expect(alert.textContent).toContain("The AI provider is busy.");
    expect(screen.getByText("Original answer summary")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(held).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(() => held[1]!.resolve(message("hi", "हिन्दी उत्तर")));
    expect(screen.getByText("हिन्दी उत्तर summary")).toBeTruthy();
  });

  it("ignores the failure (and the AbortError) of a request that was replaced", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");
    fireEvent.click(radio("Gujarati"));
    await waitFor(() => expect(held).toHaveLength(2));

    await settle(() => held[0]!.reject(new DOMException("aborted", "AbortError")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("ગુજરાતી");
    await settle(() => held[1]!.reject(new Error("The AI provider is busy.")));
    expect(screen.getByRole("alert").textContent).toContain("Gujarati");
  });

  it("an older failure never replaces the newer request's own outcome", async () => {
    render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");
    fireEvent.click(radio("Gujarati"));
    await waitFor(() => expect(held).toHaveLength(2));

    await settle(() => held[1]!.resolve(message("gu", "ગુજરાતી જવાબ")));
    await settle(() => held[0]!.reject(new Error("Hindi failed late")));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("ગુજરાતી જવાબ summary")).toBeTruthy();
  });
});

describe("leaving", () => {
  it("abandons a pending request when the answer leaves the screen", async () => {
    const view = render(<Page initial={message()} />);
    fireEvent.click(radio("Hindi"));
    await screen.findByRole("status");

    view.unmount();

    expect(aborted(held[0]!)).toBe(true);
    await settle(() => held[0]!.resolve(message("hi", "हिन्दी उत्तर")));
    expect(updates).toEqual([]);
  });
});
