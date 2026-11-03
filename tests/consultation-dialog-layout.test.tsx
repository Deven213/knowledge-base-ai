// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONSENT_GIVEN_BY, CONSENT_LANGUAGES, CONSENT_METHODS, CONSENT_TEXT } from "@/lib/consultation-consent";

vi.mock("@/lib/api", async () => ({ api: (await import("./consultation-ui-fixtures")).consultationApi }));

import { NewConsultationDialog } from "@/components/consultations/NewConsultationDialog";

// The New consultation dialog is the tallest in the app (a consent text in three languages, three groups of options and a confirmation),
// and it was cut off at the top and bottom on ordinary laptop screens. The layout rules live in the shared Modal (tests/modal-ui.test.tsx);
// these tests check that THIS dialog uses them properly: everything the doctor has to read or answer is inside the part that scrolls,
// the buttons that act on it are outside, in every language, and the consent rules are exactly as strict as before.

afterEach(cleanup);

const open = () => {
  render(<NewConsultationDialog onClose={() => undefined} onCreated={() => undefined} />);
  const dialog = screen.getByRole("dialog", { name: "New consultation" });
  const [header, body, footer] = [...dialog.children] as HTMLElement[];
  return { dialog, header: header!, body: body!, footer: footer! };
};

describe("the New consultation dialog fits the screen", () => {
  it("is the wide (560px) dialog, with a header, a scrolling body and a footer", () => {
    const { dialog, header, body, footer } = open();
    expect(dialog.className).toMatch(/\bmax-w-\[560px\]/);
    expect(dialog.className).toMatch(/\bmodal-panel\b/);
    expect(within(header).getByRole("heading", { name: "New consultation" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Close" })).toBeTruthy();
    expect(body.className).toMatch(/\boverflow-y-auto\b/);
    expect(body.className).toMatch(/\bmin-h-0\b/);
    expect(footer).toBeTruthy();
  });

  it("keeps Cancel and Start consultation in the footer, outside the scrolling part", () => {
    const { body, footer } = open();
    const cancel = within(footer).getByRole("button", { name: "Cancel" });
    const start = within(footer).getByRole("button", { name: /Start consultation/ });
    expect(body.contains(cancel)).toBe(false);
    expect(body.contains(start)).toBe(false);
    expect([...footer.querySelectorAll("button")]).toHaveLength(2);
  });

  it.each(CONSENT_LANGUAGES)("keeps everything the doctor must read or answer reachable inside the scrolling part, with the consent in %s", (language) => {
    const { body, footer } = open();
    fireEvent.click(screen.getByRole("radio", { name: { en: "English", hi: "हिन्दी", gu: "ગુજરાતી" }[language] }));

    const mustBeInBody = [
      screen.getByLabelText(/Patient \(name or record number\)/),
      screen.getByLabelText(/Language of the conversation/),
      screen.getByRole("radiogroup", { name: "Language to read the consent in" }),
      screen.getByText(CONSENT_TEXT[language].title),
      ...CONSENT_TEXT[language].statements.map((s) => screen.getByText(s)),
      screen.getByText(/This wording is a draft/),
      screen.getByRole("radiogroup", { name: "Who agreed" }),
      screen.getByRole("radiogroup", { name: "How consent was given" }),
      ...CONSENT_GIVEN_BY.map((g) => screen.getByLabelText(g.label)),
      ...CONSENT_METHODS.map((m) => screen.getByLabelText(m.label)),
      screen.getByLabelText(/I have explained this to the patient/),
    ];
    for (const element of mustBeInBody) {
      expect(body.contains(element), `${element.textContent?.slice(0, 40) || element.getAttribute("aria-label") || element.tagName} is in the scrolling part`).toBe(true);
      expect(footer.contains(element)).toBe(false);
    }
    // The text is marked with the language it is in, so screen readers and fonts pick the right voice and script.
    expect(screen.getByText(CONSENT_TEXT[language].title).closest("[lang]")!.getAttribute("lang")).toBe(language);
  });

  it("has every control in one Tab order that starts at Close and ends at the footer, none of them skipped", () => {
    const { dialog } = open();
    const controls = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])")];
    // Close, patient, conversation language, three consent languages, three "who agreed", two "how", the confirmation, Cancel.
    // (Start consultation is disabled until the form is complete, so it is not a Tab stop yet.)
    expect(controls).toHaveLength(1 + 1 + 1 + 3 + 3 + 2 + 1 + 1);
    expect(controls[0]).toBe(screen.getByRole("button", { name: "Close" }));
    expect(controls.at(-1)).toBe(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("the consent rules are as strict as before", () => {
  const start = () => screen.getByRole("button", { name: /Start consultation/ }) as HTMLButtonElement;
  const steps = {
    patient: () => fireEvent.change(screen.getByLabelText(/Patient \(name or record number\)/), { target: { value: "Test patient" } }),
    who: () => fireEvent.click(screen.getByLabelText("The patient")),
    how: () => fireEvent.click(screen.getByLabelText(/Verbal: I read this to them/)),
    confirm: () => fireEvent.click(screen.getByLabelText(/I have explained this to the patient/)),
  } as const;

  it("cannot start with any one of the four requirements missing, in any consent language, and can with all four", () => {
    for (const language of CONSENT_LANGUAGES) {
      for (const skipped of [...Object.keys(steps), null] as (keyof typeof steps | null)[]) {
        cleanup();
        open();
        fireEvent.click(screen.getByRole("radio", { name: { en: "English", hi: "हिन्दी", gu: "ગુજરાતી" }[language] }));
        for (const [name, fill] of Object.entries(steps)) if (name !== skipped) fill();
        expect(start().disabled, `${language}, skipping ${skipped}`).toBe(skipped !== null);
      }
    }
  });

  it("treats a patient label of only spaces as missing", () => {
    open();
    steps.who();
    steps.how();
    steps.confirm();
    fireEvent.change(screen.getByLabelText(/Patient \(name or record number\)/), { target: { value: "    " } });
    expect(start().disabled).toBe(true);
  });

  it("goes back to disabled the moment the confirmation is withdrawn", () => {
    open();
    for (const fill of Object.values(steps)) fill();
    expect(start().disabled).toBe(false);
    steps.confirm();
    expect(start().disabled).toBe(true);
  });

  it("does not start from the keyboard (Enter in the patient field) until the requirements are met", () => {
    const onCreated = vi.fn();
    render(<NewConsultationDialog onClose={() => undefined} onCreated={onCreated} />);
    const patient = screen.getByLabelText(/Patient \(name or record number\)/);
    fireEvent.change(patient, { target: { value: "Test patient" } });
    fireEvent.submit(patient.closest("form")!);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("is still named for screen readers, and the consent wording is untouched (the version stored with each consent still matches)", () => {
    open();
    expect(screen.getByRole("dialog", { name: "New consultation" })).toBeTruthy();
    expect(screen.getByText(CONSENT_TEXT.en.title)).toBeTruthy();
    for (const statement of CONSENT_TEXT.en.statements) expect(screen.getByText(statement)).toBeTruthy();
  });
});
