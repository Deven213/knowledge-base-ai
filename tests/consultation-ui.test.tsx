// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_TEXT, CONSENT_VERSION } from "@/lib/consultation-consent";
import { consultationApi as apiMock, detail, LIMITS, noteContent, noteDto, summary, transcriptDto } from "./consultation-ui-fixtures";
import { installFakeMedia } from "./fake-media";

// jsdom has no media pipeline: the screens that hold the recording's player get a controllable stand-in for the element.
const fakeMedia = installFakeMedia();

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock("@/lib/api", async () => ({ api: (await import("./consultation-ui-fixtures")).consultationApi }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/consultations", useSearchParams: () => new URLSearchParams() }));
// The recorder panel is covered in its own file: here it is a marker, so these tests are about the screen around it.
vi.mock("@/components/consultations/RecorderPanel", () => ({ RecorderPanel: ({ maxMinutes }: { maxMinutes: number }) => <div data-testid="recorder">recorder, {maxMinutes} minutes</div> }));

import { ConsultationDetail } from "@/components/consultations/ConsultationDetail";
import { ConsultationsPage } from "@/components/consultations/ConsultationsPage";
import { NewConsultationDialog } from "@/components/consultations/NewConsultationDialog";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  fakeMedia.reset();
  apiMock.consultations.mockResolvedValue({ consultations: [], limits: LIMITS, consentVersion: CONSENT_VERSION });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
afterAll(fakeMedia.restore);

// ── the consent step ─────────────────────────────────────────────────────────

describe("starting a consultation: consent first", () => {
  const open = () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<NewConsultationDialog onClose={onClose} onCreated={onCreated} />);
    return { onCreated, onClose };
  };
  const startButton = () => screen.getByRole("button", { name: /Start consultation/ }) as HTMLButtonElement;
  const fill = {
    patient: () => fireEvent.change(screen.getByLabelText(/Patient \(name or record number\)/), { target: { value: "  Asha Patel  " } }),
    who: () => fireEvent.click(screen.getByLabelText("The patient")),
    how: () => fireEvent.click(screen.getByLabelText(/Verbal: I read this to them/)),
    confirm: () => fireEvent.click(screen.getByLabelText(/I have explained this to the patient/)),
  };

  it("can't be started until there is a patient, someone who agreed, how they agreed, and the doctor's confirmation: each one matters", () => {
    open();
    expect(startButton().disabled).toBe(true);
    const steps = ["patient", "who", "how", "confirm"] as const;
    for (const skipped of steps) {
      cleanup();
      open();
      for (const step of steps) if (step !== skipped) fill[step]();
      expect(startButton().disabled, `without "${skipped}"`).toBe(true);
    }
    cleanup();
    open();
    for (const step of steps) fill[step]();
    expect(startButton().disabled).toBe(false);
  });

  it("shows exactly what the patient is told, in English, Hindi or Gujarati, and says the wording is a draft", () => {
    open();
    expect(screen.getByText(CONSENT_TEXT.en.title)).toBeTruthy();
    for (const statement of CONSENT_TEXT.en.statements) expect(screen.getByText(statement)).toBeTruthy();
    expect(screen.getByText(/This wording is a draft/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "हिन्दी" }));
    expect(screen.getByText(CONSENT_TEXT.hi.title)).toBeTruthy();
    expect(screen.queryByText(CONSENT_TEXT.en.title)).toBeNull();
    expect(screen.getByText(CONSENT_TEXT.hi.title).closest("[lang]")!.getAttribute("lang")).toBe("hi");

    fireEvent.click(screen.getByRole("radio", { name: "ગુજરાતી" }));
    for (const statement of CONSENT_TEXT.gu.statements) expect(screen.getByText(statement)).toBeTruthy();
    expect(screen.getByText(CONSENT_TEXT.gu.title).closest("[lang]")!.getAttribute("lang")).toBe("gu");
  });

  it("sends the patient, the language, and the consent with its wording version, in the language it was read in", async () => {
    const { onCreated } = open();
    apiMock.createConsultation.mockResolvedValue(detail());
    fill.patient();
    fireEvent.change(screen.getByLabelText(/Language of the conversation/), { target: { value: "gu" } });
    fireEvent.click(screen.getByRole("radio", { name: "ગુજરાતી" }));
    fireEvent.click(screen.getByLabelText("The patient's parent or legal guardian"));
    fireEvent.click(screen.getByLabelText(/Written: they signed/));
    fill.confirm();
    fireEvent.click(startButton());
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(apiMock.createConsultation).toHaveBeenCalledWith({
      patientLabel: "Asha Patel",
      languageHint: "gu",
      consent: { version: CONSENT_VERSION, language: "gu", givenBy: "guardian", method: "written", confirmed: true },
    });
  });

  it("shows the server's refusal and lets the doctor try again, without losing what was typed", async () => {
    const { onCreated } = open();
    apiMock.createConsultation.mockRejectedValueOnce(new Error("The consent wording was updated. Reload the page and confirm consent again."));
    for (const step of ["patient", "who", "how", "confirm"] as const) fill[step]();
    fireEvent.click(startButton());
    expect(await screen.findByText(/The consent wording was updated/)).toBeTruthy();
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/Patient \(name or record number\)/) as HTMLInputElement).value).toBe("  Asha Patel  ");
    expect(startButton().disabled).toBe(false);
  });

  it("can be cancelled, and sends nothing", () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
    expect(apiMock.createConsultation).not.toHaveBeenCalled();
  });
});

// ── the list ─────────────────────────────────────────────────────────────────

describe("the list of consultations", () => {
  it("shows the doctor's consultations with their status, each linking to its own page", async () => {
    apiMock.consultations.mockResolvedValue({
      consultations: [
        summary({ id: ID, patientLabel: "Asha Patel", status: "needs_review" }),
        summary({ id: "22222222-2222-4222-8222-222222222222", patientLabel: "Ravi Shah", status: "approved" }),
        summary({ id: "33333333-3333-4333-8333-333333333333", patientLabel: "Meena", status: "failed" }),
      ],
      limits: LIMITS,
      consentVersion: CONSENT_VERSION,
    });
    render(<ConsultationsPage />);
    const asha = await screen.findByRole("link", { name: /Asha Patel/ });
    expect(asha.getAttribute("href")).toBe(`/admin/consultations/${ID}`);
    expect(within(asha).getByText("Ready for your review")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Ravi Shah/ })).getByText("Approved")).toBeTruthy();
    expect(within(screen.getByRole("link", { name: /Meena/ })).getByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/Only you can open your consultations/)).toBeTruthy();
  });

  it("explains an empty list, and shows an error instead of an empty page when the server refuses", async () => {
    render(<ConsultationsPage />);
    expect(await screen.findByText("No consultations yet")).toBeTruthy();
    cleanup();
    apiMock.consultations.mockRejectedValue(new Error("You don't have permission to do that."));
    render(<ConsultationsPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/don't have permission/)).toBeTruthy();
  });

  it("opens the new-consultation dialog, and goes to the new consultation once it exists", async () => {
    apiMock.createConsultation.mockResolvedValue(detail({ id: ID }));
    render(<ConsultationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: /New consultation/ }));
    expect(await screen.findByRole("dialog", { name: "New consultation" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Patient \(name or record number\)/), { target: { value: "Asha" } });
    fireEvent.click(screen.getByLabelText("The patient"));
    fireEvent.click(screen.getByLabelText(/Verbal: I read this to them/));
    fireEvent.click(screen.getByLabelText(/I have explained this to the patient/));
    fireEvent.click(screen.getByRole("button", { name: /Start consultation/ }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/admin/consultations/${ID}`));
  });
});

// ── one consultation ─────────────────────────────────────────────────────────

describe("one consultation, by status", () => {
  const show = async (d = detail()) => {
    apiMock.consultation.mockResolvedValue(d);
    render(<ConsultationDetail id={ID} />);
    await screen.findByText(d.patientLabel);
  };

  it("ready: shows who agreed to what, and the recorder with the server's length limit", async () => {
    await show();
    expect(screen.getByText(/Consent given by the patient, verbally/)).toBeTruthy();
    expect(await screen.findByTestId("recorder")).toHaveProperty("textContent", "recorder, 45 minutes");
  });

  it("uploading (an interrupted upload): says the recording is gone from the page and offers to discard and start again", async () => {
    await show(detail({ status: "uploading", receivedParts: [1, 2] }));
    expect(screen.getByText(/upload of this recording was interrupted/)).toBeTruthy();
    expect(screen.queryByTestId("recorder")).toBeNull();
    apiMock.deleteRecordingAudio.mockResolvedValue(undefined);
    apiMock.consultation.mockResolvedValue(detail({ status: "ready" }));
    fireEvent.click(screen.getByRole("button", { name: /Discard and record again/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(apiMock.deleteRecordingAudio).toHaveBeenCalledWith(ID));
    expect(await screen.findByTestId("recorder")).toBeTruthy();
  });

  it("processing, waiting for approval to use the AI: reassures that the recording is saved, and shows no configuration detail", async () => {
    await show(detail({ status: "processing", stage: "waiting", waitingReason: "Your recording is stored safely. AI processing hasn't been approved for this workspace yet, so nothing has been sent anywhere." }));
    expect(screen.getByText(/Your recording is saved/)).toBeTruthy();
    expect(screen.getByText(/hasn't been approved for this workspace yet/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/CONSULTATIONS_|GEMINI|\.env/);
  });

  it("processing: says what is happening, and looks again every few seconds until the note is ready, then shows it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiMock.consultation.mockResolvedValue(detail({ status: "processing", stage: "transcribing" }));
    render(<ConsultationDetail id={ID} />);
    expect(await screen.findByText(/Turning the recording into text/)).toBeTruthy();
    expect(screen.getByText(/You can leave this page/)).toBeTruthy();
    const before = apiMock.consultation.mock.calls.length;

    apiMock.consultation.mockResolvedValue(detail({ status: "processing", stage: "drafting" }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(apiMock.consultation.mock.calls.length).toBeGreaterThan(before);
    expect(await screen.findByText(/Drafting the clinical note/)).toBeTruthy();

    apiMock.consultation.mockResolvedValue(detail({ status: "needs_review", stage: "done", noteVersion: 1 }));
    apiMock.consultationNote.mockResolvedValue(noteDto());
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto());
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    expect(await screen.findByRole("region", { name: "Clinical note" })).toBeTruthy();
    const calls = apiMock.consultation.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(10_000)));
    expect(apiMock.consultation.mock.calls.length).toBe(calls); // it stops looking once there is nothing left to wait for
  });

  it("failed: shows what went wrong and offers a retry while the recording is still stored", async () => {
    await show(detail({ status: "failed", stage: "failed", failureMessage: "Transcription is busy right now and will be retried automatically.", recording: { status: "stored", durationMs: 60_000, sizeBytes: 1000 } }));
    expect(screen.getByRole("alert").textContent).toMatch(/busy right now/);
    apiMock.retryConsultation.mockResolvedValue(detail({ status: "processing", stage: "transcribing" }));
    apiMock.consultation.mockResolvedValue(detail({ status: "processing", stage: "transcribing" }));
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(apiMock.retryConsultation).toHaveBeenCalledWith(ID));
    expect(await screen.findByText(/Turning the recording into text/)).toBeTruthy();
  });

  it("failed with the recording deleted: no retry, and it says to record again in a new consultation", async () => {
    await show(detail({ status: "failed", stage: "failed", failureMessage: "The recording was deleted before it was processed, so no note could be prepared.", recording: { status: "deleted", durationMs: 60_000, sizeBytes: null } }));
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(screen.getByText(/Start a new consultation to record again/)).toBeTruthy();
  });

  it("needs review: shows the note with the transcript and the recording beside it, and the transcript is loaded once (the server records each time it is read)", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto());
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto());
    await show(detail({ status: "needs_review", stage: "done", noteVersion: 1, hasTranscript: true, recording: { status: "stored", durationMs: 60_000, sizeBytes: 1000 } }));
    expect(await screen.findByRole("region", { name: "Clinical note" })).toBeTruthy();
    const panel = await screen.findByRole("region", { name: "Transcript" });
    expect(within(panel).getByText(/ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે/)).toBeTruthy(); // the original, in its own script
    expect(panel.querySelector("audio")!.getAttribute("src")).toBe(`/api/consultations/${ID}/audio`);
    expect(within(panel).getByRole("group", { name: "Recording player" })).toBeTruthy();
    expect(within(panel).getByText("00:00 / 01:00")).toBeTruthy(); // the length stored with the recording, until the browser learns the real one
    expect(apiMock.consultationTranscript).toHaveBeenCalledTimes(1);
  });

  it("says when the transcript could not be loaded, and loads it again when asked, with the player still there", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto());
    apiMock.consultationTranscript.mockRejectedValueOnce(new Error("The transcript could not be opened. Try again."));
    await show(detail({ status: "needs_review", stage: "done", noteVersion: 1, hasTranscript: true, recording: { status: "stored", durationMs: 60_000, sizeBytes: 1000 } }));
    const panel = await screen.findByRole("region", { name: "Transcript" });
    expect(await within(panel).findByText(/transcript could not be opened/)).toBeTruthy();
    const audioBefore = panel.querySelector("audio");
    expect(audioBefore).toBeTruthy(); // the recording is still there to listen to
    apiMock.consultationTranscript.mockResolvedValueOnce(transcriptDto());
    fireEvent.click(within(panel).getByRole("button", { name: "Try again" }));
    expect(await within(panel).findByText(/ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે/)).toBeTruthy();
    expect(panel.querySelector("audio")).toBe(audioBefore); // the same player: it was not rebuilt when the transcript arrived
  });

  it("clicking a line's source brings that line of the transcript into view and highlights it", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto());
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto());
    await show(detail({ status: "needs_review", stage: "done", noteVersion: 1, hasTranscript: true }));
    const note = await screen.findByRole("region", { name: "Clinical note" });
    const group = within(note).getByRole("group", { name: "Plan and follow-up" });
    const panel = await screen.findByRole("region", { name: "Transcript" });
    await within(panel).findByText(/Paracetamol 650 mg/);
    fireEvent.click(within(group).getByRole("button", { name: "Show transcript line 5" }));
    const line = panel.querySelector("#segment-5")!;
    expect(line.textContent).toMatch(/Paracetamol 650 mg/);
    expect(line.className).toMatch(/ring-yellow/); // highlighted
    expect(panel.querySelector("#segment-4")!.className).not.toMatch(/ring-yellow/);
  });

  it("deleting the recording and deleting the consultation each need an explicit confirmation, and the second needs the word 'delete'", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto());
    await show(detail({ status: "needs_review", stage: "done", noteVersion: 1, recording: { status: "stored", durationMs: 60_000, sizeBytes: 1000 } }));
    fireEvent.click(await screen.findByRole("button", { name: /Delete the recording/ }));
    const audioDialog = await screen.findByRole("dialog", { name: "Delete the recording?" });
    expect(within(audioDialog).getByText(/transcript and the note are kept/)).toBeTruthy();
    fireEvent.click(within(audioDialog).getByRole("button", { name: "Cancel" }));
    expect(apiMock.deleteRecordingAudio).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Delete this consultation/ }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this consultation?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete consultation" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); // nothing typed yet
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "delete" } });
    expect(confirm.disabled).toBe(false);
    apiMock.deleteConsultation.mockResolvedValue(undefined);
    fireEvent.click(confirm);
    await waitFor(() => expect(apiMock.deleteConsultation).toHaveBeenCalledWith(ID));
    expect(router.push).toHaveBeenCalledWith("/admin/consultations");
  });

  it("warns that an approved note is being deleted", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto({ approvedAt: "2026-10-20T10:00:00.000Z", content: noteContent({ flags: [] }) }));
    await show(detail({ status: "approved", stage: "done", noteVersion: 1 }));
    fireEvent.click(await screen.findByRole("button", { name: /Delete this consultation/ }));
    expect((await screen.findByRole("dialog")).textContent).toMatch(/The note has been approved: check that you are allowed to delete it/);
  });

  it("shows the server's refusal when the consultation can't be opened (someone else's, or gone)", async () => {
    apiMock.consultation.mockRejectedValue(new Error("That consultation was not found."));
    render(<ConsultationDetail id={ID} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/not found/);
  });
});
