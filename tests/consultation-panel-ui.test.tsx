// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consultationApi as apiMock, detail, noteContent, noteDto } from "./consultation-ui-fixtures";
import { fakeMicrophone } from "./fake-microphone";

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock("@/lib/api", async () => ({ api: (await import("./consultation-ui-fixtures")).consultationApi }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/consultations/x", useSearchParams: () => new URLSearchParams() }));

import { NoteEditor } from "@/components/consultations/NoteEditor";
import { RecorderPanel } from "@/components/consultations/RecorderPanel";
import { NOTE_GROUPS, NOTE_SECTION_KEYS, NOTE_SECTIONS } from "@/lib/consultations";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── the recorder panel ───────────────────────────────────────────────────────

describe("the recorder panel", () => {
  const mount = (mic = fakeMicrophone()) => {
    const onUploaded = vi.fn();
    render(<RecorderPanel consultationId={ID} maxMinutes={45} bitsPerSecond={48_000} onUploaded={onUploaded} env={mic.env} />);
    return { mic, onUploaded };
  };
  const startRecording = async (mic: ReturnType<typeof fakeMicrophone>) => {
    fireEvent.click(screen.getByRole("button", { name: /Start recording/ }));
    await screen.findByRole("timer");
    expect(mic.recorders).toHaveLength(1);
  };
  const serverAcceptsUploads = () => {
    apiMock.startRecordingUpload.mockResolvedValue({ recordingId: "r1", partBytes: 1000, receivedParts: [] });
    apiMock.uploadRecordingPart.mockResolvedValue({ received: 1 });
    apiMock.completeRecording.mockResolvedValue(detail({ status: "processing" }));
  };

  it("starts idle, says how long a recording can be, and asks for the microphone only when Start is pressed", async () => {
    const { mic } = mount();
    expect(screen.getByText("Ready to record")).toBeTruthy();
    expect(screen.getByText(/stops by itself after 45 minutes/)).toBeTruthy();
    expect(mic.getUserMedia).not.toHaveBeenCalled();
    await startRecording(mic);
    expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("shows that it is recording, with a clock, and offers Pause, Stop and Discard", async () => {
    const { mic } = mount();
    await startRecording(mic);
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(screen.getByRole("timer", { name: "Time recorded" }).textContent).toBe("00:00");
    expect(screen.getByRole("button", { name: /Pause/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stop and save/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Discard/ })).toBeTruthy();
    expect(screen.getByRole("meter", { name: "Microphone level" })).toBeTruthy();
  });

  it("pauses and resumes", async () => {
    const { mic } = mount();
    await startRecording(mic);
    fireEvent.click(screen.getByRole("button", { name: /Pause/ }));
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(mic.recorders[0]!.state).toBe("paused");
    expect(screen.queryByRole("button", { name: /^Pause/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));
    expect(screen.getByText("Recording")).toBeTruthy();
    expect(mic.recorders[0]!.state).toBe("recording");
  });

  it("stopping saves the recording to the server by itself: in parts, with a checksum, and the doctor is told when it is safe", async () => {
    serverAcceptsUploads();
    const { mic, onUploaded } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(1500);
    mic.recorders[0]!.emit(1000);
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(apiMock.startRecordingUpload).toHaveBeenCalledWith(ID, "audio/webm");
    expect(apiMock.uploadRecordingPart.mock.calls.map((c) => [c[1], (c[2] as Blob).size])).toEqual([[1, 1000], [2, 1000], [3, 500]]);
    const info = apiMock.completeRecording.mock.calls[0]![1];
    expect(info).toMatchObject({ totalBytes: 2500, partCount: 3 });
    expect(info.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.durationMs).toBeGreaterThanOrEqual(0);
    expect(screen.getByText(/Saved securely/)).toBeTruthy();
    expect(mic.track.stop).toHaveBeenCalled(); // the microphone is off
  });

  it("shows progress while it sends, and never sends the recording twice", async () => {
    let finish!: () => void;
    apiMock.startRecordingUpload.mockResolvedValue({ recordingId: "r1", partBytes: 1000, receivedParts: [] });
    apiMock.uploadRecordingPart.mockResolvedValue({ received: 1 });
    apiMock.completeRecording.mockImplementation(() => new Promise<unknown>((resolve) => (finish = () => resolve(detail()))));
    const { mic, onUploaded } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(2500);
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));
    expect(await screen.findByText(/Sending the recording securely/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Upload progress" })).toBeTruthy();
    expect(screen.getByText(/Keep this page open/)).toBeTruthy();
    await waitFor(() => expect(apiMock.completeRecording).toHaveBeenCalledTimes(1));
    await act(async () => finish());
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(apiMock.startRecordingUpload).toHaveBeenCalledTimes(1);
    expect(apiMock.completeRecording).toHaveBeenCalledTimes(1);
  });

  it("when the server refuses the recording, keeps it on the page, says so, and sends it again when asked", async () => {
    serverAcceptsUploads();
    apiMock.uploadRecordingPart.mockRejectedValueOnce(Object.assign(new Error("This recording is larger than the limit. Please keep consultations shorter."), { status: 413, code: "recording_too_large" }));
    const { mic, onUploaded } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(1200);
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/larger than the limit/);
    expect(screen.getByText(/Your recording is still here, on this page/)).toBeTruthy();
    expect(onUploaded).not.toHaveBeenCalled();
    expect(apiMock.completeRecording).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1));
    expect(apiMock.completeRecording).toHaveBeenCalledTimes(1);
  });

  it("a brief network failure is retried by itself and the doctor sees nothing but success", async () => {
    serverAcceptsUploads();
    apiMock.uploadRecordingPart.mockRejectedValueOnce(new Error("Could not reach the server.")).mockResolvedValue({ received: 1 });
    const { mic, onUploaded } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(900);
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledTimes(1), { timeout: 4000 }); // the retry waits one second
    expect(screen.queryByRole("alert")).toBeNull();
    expect(apiMock.uploadRecordingPart).toHaveBeenCalledTimes(2);
  });

  it("explains a blocked microphone and lets the doctor try again", async () => {
    const mic = fakeMicrophone({ deny: "NotAllowedError" });
    mount(mic);
    fireEvent.click(screen.getByRole("button", { name: /Start recording/ }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Microphone access was blocked/);
    expect(screen.getByRole("button", { name: /Try again/ })).toBeTruthy();
    expect(apiMock.startRecordingUpload).not.toHaveBeenCalled();
  });

  it("discarding a recording whose upload had failed also tells the server to throw away the parts it received, so the next recording starts clean", async () => {
    serverAcceptsUploads();
    apiMock.deleteRecordingAudio.mockResolvedValue(undefined);
    apiMock.uploadRecordingPart.mockRejectedValue(Object.assign(new Error("This recording is larger than the limit."), { status: 413, code: "recording_too_large" }));
    const { mic } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(1200);
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /Discard the recording/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard recording" }));
    await screen.findByText("Ready to record");
    await waitFor(() => expect(apiMock.deleteRecordingAudio).toHaveBeenCalledWith(ID));
  });

  it("discarding while still recording (nothing was ever sent) doesn't bother the server", async () => {
    const { mic } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(900);
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard recording" }));
    await screen.findByText("Ready to record");
    expect(apiMock.deleteRecordingAudio).not.toHaveBeenCalled();
  });

  it("discarding asks first, then throws the recording away with the microphone off and nothing sent", async () => {
    const { mic } = mount();
    await startRecording(mic);
    mic.recorders[0]!.emit(900);
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    const dialog = await screen.findByRole("dialog", { name: "Discard this recording?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Recording")).toBeTruthy(); // still recording
    fireEvent.click(screen.getByRole("button", { name: /Discard/ }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Discard recording" }));
    await screen.findByText("Ready to record");
    expect(mic.track.stop).toHaveBeenCalled();
    expect(apiMock.startRecordingUpload).not.toHaveBeenCalled();
  });

  describe("leaving the page by accident", () => {
    /**
     * A link elsewhere in the app, as in the sidebar. The guard stops a refused click from travelling any further, so a listener on the window
     * only hears about clicks that were LEFT TO PROCEED: `outcome.followed` says whether the page would have followed the link.
     */
    const sidebarLink = (href = "/settings/team", attributes: Record<string, string> = {}) => {
      const link = document.createElement("a");
      link.href = href;
      Object.entries(attributes).forEach(([k, v]) => link.setAttribute(k, v));
      link.textContent = "A link";
      document.body.appendChild(link);
      const outcome = { followed: false };
      const spy = (e: Event) => {
        outcome.followed = true;
        e.preventDefault(); // so jsdom doesn't try to navigate
      };
      window.addEventListener("click", spy);
      return { link, outcome, remove: () => (window.removeEventListener("click", spy), link.remove()) };
    };

    it("asks before a link to another page is followed while recording, and stays put if the doctor says so", async () => {
      const { mic } = mount();
      const nav = sidebarLink();
      await startRecording(mic);
      nav.outcome.followed = false; // (pressing Start was itself a click that the window heard)
      fireEvent.click(nav.link);
      expect(nav.outcome.followed).toBe(false); // the click was stopped
      const dialog = await screen.findByRole("dialog", { name: "Leave this page?" });
      expect(dialog.textContent).toMatch(/A visit is being recorded/);
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(router.push).not.toHaveBeenCalled();
      expect(screen.getByText("Recording")).toBeTruthy();

      fireEvent.click(nav.link);
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave and lose the recording" }));
      await waitFor(() => expect(router.push).toHaveBeenCalledWith("/settings/team"));
      nav.remove();
    });

    it("asks before the tab or browser is closed, while recording and while sending, and not once the recording is safely stored", async () => {
      serverAcceptsUploads();
      const { mic, onUploaded } = mount();
      const asked = () => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(asked()).toBe(false); // nothing to lose yet
      await startRecording(mic);
      expect(asked()).toBe(true);
      mic.recorders[0]!.emit(1500);
      fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));
      await waitFor(() => expect(onUploaded).toHaveBeenCalled());
      expect(asked()).toBe(false); // the server has it: nothing is lost by leaving
      const nav = sidebarLink();
      fireEvent.click(nav.link);
      expect(nav.outcome.followed).toBe(true); // nothing to lose any more: the link is followed
      nav.remove();
    });

    it("does not get in the way of links that stay on the page or open elsewhere", async () => {
      const { mic } = mount();
      await startRecording(mic);
      const followed: boolean[] = [];
      for (const [href, attributes] of [["#top", {}], ["/", {}], ["https://elsewhere.example/page", {}], ["/settings/team", { target: "_blank" }], ["/files/report.pdf", { download: "" }]] as [string, Record<string, string>][]) {
        const nav = sidebarLink(href, attributes);
        fireEvent.click(nav.link);
        followed.push(nav.outcome.followed);
        nav.remove();
      }
      expect(followed).toEqual([true, true, true, true, true]); // none was stopped
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

// ── the note editor ──────────────────────────────────────────────────────────

describe("the note editor", () => {
  const mount = (note = noteDto()) => {
    const onChanged = vi.fn();
    const onEvidence = vi.fn();
    render(<NoteEditor consultationId={ID} note={note} onChanged={onChanged} onEvidence={onEvidence} />);
    return { onChanged, onEvidence };
  };
  const group = (title: string) => screen.getByRole("group", { name: title });
  const approveButton = () => screen.getByRole("button", { name: /^(Save and approve|Approve note)/ }) as HTMLButtonElement;
  const saveButton = () => screen.getByRole("button", { name: /Save draft/ }) as HTMLButtonElement;
  const reviewFlag = () => fireEvent.click(screen.getByRole("checkbox", { name: /Reviewed:/ }));
  /** Opens the small "Details" row of the one line inside a group (where who it came from is changed, and where a line is removed). */
  const openDetails = (title: string) => fireEvent.click(within(group(title)).getByRole("button", { name: "Details" }));

  it("shows four headings, says 'Not discussed' where nothing was, and says who each line came from", () => {
    mount();
    expect(NOTE_GROUPS.map((g) => g.title)).toEqual(["Chief complaint and symptoms", "Relevant history", "Assessment", "Plan and follow-up"]);
    for (const { title } of NOTE_GROUPS) expect(group(title)).toBeTruthy();
    // ...and not nine cards: none of the nine section titles is a heading any more
    for (const { title } of NOTE_SECTIONS) if (!NOTE_GROUPS.some((g) => g.title === title)) expect(screen.queryByRole("group", { name: title })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(4);

    expect(within(group("Chief complaint and symptoms")).getByDisplayValue("Fever and headache for three days.")).toBeTruthy();
    expect(within(group("Chief complaint and symptoms")).getByText("Patient reported")).toBeTruthy(); // who it came from, as a small caption
    expect(within(group("Plan and follow-up")).getByText("Doctor decided")).toBeTruthy();
    expect(screen.getAllByText("Not discussed")).toHaveLength(2); // relevant history and assessment have nothing
    expect(screen.getByText("Not approved")).toBeTruthy();
    expect(screen.getByText(/The AI wrote it from the transcript. Check it before you approve/)).toBeTruthy();
  });

  it("covers every one of the nine stored sections exactly once: nothing the note holds can be left out of view", () => {
    const covered = NOTE_GROUPS.flatMap((g) => [...g.sections]);
    expect([...covered].sort()).toEqual([...NOTE_SECTION_KEYS].sort());
    expect(new Set(covered).size).toBe(NOTE_SECTION_KEYS.length);
    for (const g of NOTE_GROUPS) expect(g.sections as readonly string[]).toContain(g.addTo);
  });

  it("names the stored section of a line only where a heading holds several, so the doctor can tell a medication from advice", () => {
    mount();
    expect(within(group("Plan and follow-up")).getByText("Medication")).toBeTruthy();
    expect(within(group("Chief complaint and symptoms")).queryByText("Complaint")).toBeNull(); // one section: nothing to tell apart
  });

  it("keeps who a line came from, and the way to change it or remove the line, out of the main view until Details is opened", () => {
    mount(noteDto({ content: noteContent({ flags: [] }) }));
    expect(screen.queryByLabelText("Who this came from")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove this line" })).toBeNull();
    const toggle = within(group("Chief complaint and symptoms")).getByRole("button", { name: "Details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((within(group("Chief complaint and symptoms")).getByLabelText("Who this came from") as HTMLSelectElement).value).toBe("patient_reported");
    fireEvent.click(toggle);
    expect(screen.queryByLabelText("Who this came from")).toBeNull();
  });

  it("links every line back to the part of the transcript it came from, with small links", () => {
    const { onEvidence } = mount();
    fireEvent.click(within(group("Plan and follow-up")).getByRole("button", { name: "Show transcript line 5" }));
    expect(onEvidence).toHaveBeenCalledWith(5);
    fireEvent.click(within(screen.getByRole("group", { name: "Items to review" })).getByRole("button", { name: "Show transcript line 6" }));
    expect(onEvidence).toHaveBeenCalledWith(6);
  });

  it("shows the warnings at the top, compact: how many need review, open while any does, collapsible", () => {
    mount();
    const warnings = screen.getByRole("group", { name: "Items to review" });
    const header = within(warnings).getByRole("button", { name: /1 item needs your review/ });
    expect(header.getAttribute("aria-expanded")).toBe("true"); // open while something needs the doctor
    expect(within(warnings).getByText(/The speech service was not sure of the words in transcript segment/)).toBeTruthy();
    expect(within(warnings).getByText("Uncertain transcription")).toBeTruthy();
    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(within(warnings).queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("1 item needs your review")).toBeTruthy(); // still said, even closed
    expect(approveButton().disabled).toBe(true); // closing the list does not review anything
  });

  it("can't be approved until every flagged item has been reviewed, and says how many are left", () => {
    mount();
    expect(screen.getByText("1 item needs your review")).toBeTruthy();
    expect(approveButton().disabled).toBe(true);
    expect(screen.getByText(/Mark every flagged item as reviewed to approve/)).toBeTruthy();
    reviewFlag();
    expect(screen.getByText("Everything flagged has been reviewed")).toBeTruthy();
    expect(approveButton().disabled).toBe(false);
  });

  it("a note with nothing flagged can be approved straight away, after the doctor has read it", () => {
    mount(noteDto({ content: noteContent({ flags: [] }) }));
    expect(screen.queryByRole("group", { name: "Items to review" })).toBeNull();
    expect(approveButton().disabled).toBe(false);
  });

  it("keeps Save draft and Approve note in a footer of their own, outside the part of the note that scrolls", () => {
    mount();
    const note = screen.getByRole("region", { name: "Clinical note" });
    const [header, body, footer] = [...note.children] as HTMLElement[];
    expect(body!.className).toMatch(/\boverflow-y-auto\b/);
    expect(body!.className).toMatch(/\bmin-h-0\b/);
    expect(footer!.className).toMatch(/\bshrink-0\b/);
    expect(footer!.className).toMatch(/\bsticky\b/); // on a small screen the page scrolls, and the footer stays in reach
    expect(within(footer!).getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(within(footer!).getByRole("button", { name: /Approve note|Save and approve/ })).toBeTruthy();
    expect(body!.contains(saveButton())).toBe(false);
    expect(body!.contains(approveButton())).toBe(false);
    expect(within(header!).getByRole("heading", { name: "Clinical note" })).toBeTruthy();
    // what the doctor must see before acting is in the footer too, next to the buttons
    expect(within(footer!).getByText(/Mark every flagged item as reviewed to approve/)).toBeTruthy();
  });

  it("approving is a deliberate step: a confirmation that states what it means, and nothing is sent until the doctor confirms", async () => {
    const { onChanged } = mount();
    reviewFlag();
    fireEvent.click(approveButton());
    const dialog = await screen.findByRole("dialog", { name: "Approve this note?" });
    expect(dialog.textContent).toMatch(/you confirm that you have read this note/);
    expect(dialog.textContent).toMatch(/cannot be changed/);
    expect(dialog.textContent).toMatch(/Your changes will be saved first/); // ticking a flag is a change
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(apiMock.saveConsultationNote).not.toHaveBeenCalled();
    expect(apiMock.approveConsultationNote).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("pending changes are saved first, and the version that was just saved is the one approved", async () => {
    const { onChanged } = mount();
    reviewFlag();
    fireEvent.change(within(group("Chief complaint and symptoms")).getByRole("textbox"), { target: { value: "Fever and a bad headache for three days." } });
    expect(approveButton().textContent).toMatch(/Save and approve/);
    apiMock.saveConsultationNote.mockResolvedValue(2);
    apiMock.approveConsultationNote.mockResolvedValue({ approved: true, version: 2 });
    fireEvent.click(approveButton());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Approve this note?" })).getByRole("button", { name: "Save and approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiMock.saveConsultationNote).toHaveBeenCalledWith(ID, 1, expect.anything());
    expect(apiMock.approveConsultationNote).toHaveBeenCalledWith(ID, 2); // not version 1
    expect(apiMock.saveConsultationNote.mock.invocationCallOrder[0]).toBeLessThan(apiMock.approveConsultationNote.mock.invocationCallOrder[0]!);
  });

  it("if the approval is refused after the changes were saved, the saved version is shown and the reason is given", async () => {
    const { onChanged } = mount();
    reviewFlag();
    apiMock.saveConsultationNote.mockResolvedValue(2);
    apiMock.approveConsultationNote.mockRejectedValue(new Error("Review all 2 flagged items before approving."));
    fireEvent.click(approveButton());
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save and approve" }));
    expect(await screen.findByText(/Review all 2 flagged items before approving/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1); // the saved version is loaded, so the next try starts from it
  });

  it("editing a line makes Save draft available, and it sends exactly the doctor's changes, with all nine sections in order", async () => {
    const { onChanged } = mount(noteDto({ content: noteContent({ flags: [] }) }));
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(within(group("Chief complaint and symptoms")).getByDisplayValue("Fever and headache for three days."), { target: { value: "High fever and headache for three days." } });
    openDetails("Chief complaint and symptoms");
    fireEvent.change(within(group("Chief complaint and symptoms")).getByLabelText("Who this came from"), { target: { value: "clinician_observation" } });
    expect(saveButton().disabled).toBe(false);
    expect(approveButton().textContent).toMatch(/Save and approve/);
    expect(screen.getByText(/You have unsaved changes/)).toBeTruthy();
    apiMock.saveConsultationNote.mockResolvedValue(2);
    fireEvent.click(saveButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [id, baseVersion, submission] = apiMock.saveConsultationNote.mock.calls[0]!;
    expect([id, baseVersion]).toEqual([ID, 1]);
    expect(submission.sections.map((s: { key: string }) => s.key)).toEqual([...NOTE_SECTION_KEYS]); // the server requires all nine, in order
    expect(submission.sections.find((s: { key: string }) => s.key === "chief_complaint").items).toEqual([{ id: "i1", text: "High fever and headache for three days.", origin: "clinician_observation", evidence: [2] }]);
    expect(submission.sections.find((s: { key: string }) => s.key === "medication_decisions").items[0].text).toBe("Paracetamol 650 mg twice a day for three days."); // untouched lines go back unchanged
    expect(JSON.stringify(submission)).not.toMatch(/byDoctor/); // the browser doesn't get to say who wrote what
  });

  it("saves which flags have been reviewed", async () => {
    mount();
    reviewFlag();
    apiMock.saveConsultationNote.mockResolvedValue(2);
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiMock.saveConsultationNote).toHaveBeenCalled());
    expect(apiMock.saveConsultationNote.mock.calls[0]![2].flags).toEqual([{ id: "f1", resolved: true }]);
  });

  it("adds and removes lines, and won't save a blank one", async () => {
    mount(noteDto({ content: noteContent({ flags: [] }) }));
    const assessment = group("Assessment");
    fireEvent.click(within(assessment).getByRole("button", { name: /Add a line/ }));
    fireEvent.click(within(assessment).getByRole("button", { name: "Details" }));
    expect(within(assessment).getByLabelText("Who this came from")).toHaveProperty("value", "clinician_assessment");
    expect(within(assessment).queryByText("Not discussed")).toBeNull();
    expect(screen.getByText(/Fill in or remove the empty line first/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true); // a blank line can't be saved
    expect(approveButton().disabled).toBe(true); // nor approved
    fireEvent.change(within(assessment).getByRole("textbox"), { target: { value: "Viral fever." } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(within(assessment).getByRole("button", { name: "Remove this line" }));
    expect(within(assessment).getByText("Not discussed")).toBeTruthy();
    expect(saveButton().disabled).toBe(true); // back to what is saved: nothing to save
  });

  it("puts a line the doctor adds under Plan and follow-up into the advice and follow-up section, and sends it there", async () => {
    mount(noteDto({ content: noteContent({ flags: [] }) }));
    fireEvent.click(within(group("Plan and follow-up")).getByRole("button", { name: /Add a line/ }));
    const boxes = within(group("Plan and follow-up")).getAllByRole("textbox");
    fireEvent.change(boxes[boxes.length - 1]!, { target: { value: "Review in five days." } });
    apiMock.saveConsultationNote.mockResolvedValue(2);
    fireEvent.click(saveButton());
    await waitFor(() => expect(apiMock.saveConsultationNote).toHaveBeenCalled());
    const submission = apiMock.saveConsultationNote.mock.calls[0]![2];
    const added = submission.sections.find((x: { key: string }) => x.key === "counselling_followup").items;
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ text: "Review in five days.", origin: "advice_given", evidence: [] });
    expect(submission.sections.find((x: { key: string }) => x.key === "medication_decisions").items).toHaveLength(1); // the AI's medication line is where it was
  });

  it("shows the server's refusal when the note changed somewhere else, and keeps the doctor's edits", async () => {
    mount(noteDto({ content: noteContent({ flags: [] }) }));
    fireEvent.change(within(group("Chief complaint and symptoms")).getByRole("textbox"), { target: { value: "Edited." } });
    apiMock.saveConsultationNote.mockRejectedValue(new Error("The note was changed somewhere else. Reload it to see the latest version."));
    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed somewhere else/);
    expect(within(group("Chief complaint and symptoms")).getByDisplayValue("Edited.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Clinical note" }).lastElementChild as HTMLElement).getByRole("alert")).toBeTruthy(); // shown beside the buttons, where the doctor is looking
  });

  it("approving a note that is saved and fully reviewed sends the approval for that version, then reloads", async () => {
    const reviewed = noteDto({ version: 3, content: noteContent({ flags: [{ id: "f1", kind: "ambiguity", text: "Duration unclear.", evidence: [2], resolved: true }] }) });
    const { onChanged } = mount(reviewed);
    expect(screen.getByText("Everything flagged has been reviewed")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Items to review" })).queryByRole("checkbox")).toBeNull(); // folded away once nothing is left to review
    apiMock.approveConsultationNote.mockResolvedValue({ approved: true, version: 3 });
    fireEvent.click(approveButton());
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Approve this note?" })).getByRole("button", { name: "Approve note" }));
    await waitFor(() => expect(apiMock.approveConsultationNote).toHaveBeenCalledWith(ID, 3));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("an approved note is read-only, shows who it came from, and can be reopened (which makes a new version)", async () => {
    const approved = noteDto({ version: 2, approvedAt: "2026-10-20T10:00:00.000Z", needsApproval: false, content: noteContent({ flags: [{ id: "f1", kind: "ambiguity", text: "x", evidence: [], resolved: true }] }), versions: [{ version: 2, source: "doctor", createdAt: "2026-10-20T09:40:00.000Z", approvedAt: "2026-10-20T10:00:00.000Z" }, { version: 1, source: "ai", createdAt: "2026-10-20T09:30:00.000Z", approvedAt: null }] });
    const { onChanged } = mount(approved);
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Approve note/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Save draft/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Add a line/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull(); // nothing to change
    expect(screen.getByText("Fever and headache for three days.")).toBeTruthy();
    expect(within(group("Chief complaint and symptoms")).getByText("Patient reported")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Everything flagged has been reviewed/ })); // the reviewed warnings can still be read
    expect((screen.getByRole("checkbox", { name: /Reviewed:/ }) as HTMLInputElement).disabled).toBe(true);

    apiMock.reopenConsultationNote.mockResolvedValue(3);
    fireEvent.click(screen.getByRole("button", { name: /Reopen to make changes/ }));
    const dialog = await screen.findByRole("dialog", { name: "Reopen this note?" });
    expect(dialog.textContent).toMatch(/approved version stays exactly as it is/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(apiMock.reopenConsultationNote).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("lists the earlier versions", () => {
    mount(noteDto({ version: 2, versions: [{ version: 2, source: "doctor", createdAt: "2026-10-20T09:40:00.000Z", approvedAt: null }, { version: 1, source: "ai", createdAt: "2026-10-20T09:30:00.000Z", approvedAt: null }] }));
    fireEvent.click(screen.getByText(/Earlier versions \(1\)/));
    expect(screen.getByText(/Version 1, AI draft/)).toBeTruthy();
    expect(screen.getByText(/Version 2, your edit/)).toBeTruthy();
  });
});
