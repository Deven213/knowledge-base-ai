// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIXED_TRANSCRIPT } from "./consultation-helpers";
import { consultationApi as apiMock, detail, LIMITS, noteContent, noteDto, transcriptDto } from "./consultation-ui-fixtures";
import { installFakeMedia } from "./fake-media";

// The consultation screen once the note is ready: a clinical workspace with the note on the left and the transcript and recording on the right
// (stacked on a small screen), each scrolling by itself, with the status and the patient clear at the top.
//
// jsdom has no layout engine, so "two columns that scroll independently" is checked as structure (which element scrolls, which one stays put,
// which classes apply at which screen size); the measured geometry in a real browser at 1366x768, 1280x720, 1024x768 and 390x844 was checked
// separately against the running test app.

const router = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }));
vi.mock("@/lib/api", async () => ({ api: (await import("./consultation-ui-fixtures")).consultationApi }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/admin/consultations/x", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/consultations/RecorderPanel", () => ({ RecorderPanel: () => <div data-testid="recorder" /> }));

import { ConsultationDetail } from "@/components/consultations/ConsultationDetail";
import { NOTE_SECTION_KEYS } from "@/lib/consultations";

/** Every test has its own consultation: the player remembers where each recording was left, which is right for the doctor and wrong for a test that wants a fresh start. */
let ID = "";
let consultations = 0;
const fakeMedia = installFakeMedia();
const reviewable = (over = {}) => detail({ status: "needs_review", stage: "done", noteVersion: 1, hasTranscript: true, recording: { status: "stored", durationMs: 60_000, sizeBytes: 1000 }, ...over });
const withTimes = () => transcriptDto({ content: { ...MIXED_TRANSCRIPT, segments: MIXED_TRANSCRIPT.segments.map((s, i) => ({ ...s, startMs: 300 + i * 5_000 })) } });

beforeEach(() => {
  ID = `aaaaaaaa-0000-4000-8000-${String(++consultations).padStart(12, "0")}`;
  vi.clearAllMocks();
  fakeMedia.reset();
  apiMock.consultations.mockResolvedValue({ consultations: [], limits: LIMITS, consentVersion: "x" });
  apiMock.consultationNote.mockResolvedValue(noteDto());
  apiMock.consultationTranscript.mockResolvedValue(transcriptDto());
});
afterEach(cleanup);
afterAll(fakeMedia.restore);

async function open(d = reviewable()) {
  apiMock.consultation.mockResolvedValue(d);
  render(<ConsultationDetail id={ID} />);
  await screen.findByRole("region", { name: "Clinical note" });
  await screen.findByRole("region", { name: "Transcript" });
  await screen.findByText(/ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે/);
}
const note = () => screen.getByRole("region", { name: "Clinical note" });
const transcript = () => screen.getByRole("region", { name: "Transcript" });
const classes = (el: Element) => el.className.split(/\s+/);

describe("the workspace: note on the left, transcript and recording on the right", () => {
  it("is two columns on a large screen, the note first, and stacked on a small one", async () => {
    await open();
    const grid = note().parentElement!;
    expect(grid).toBe(transcript().parentElement); // the two panels are siblings in one grid
    expect([...grid.children]).toEqual([note(), transcript()]); // note first: on the left on a large screen, on top on a phone
    expect(classes(grid)).toContain("grid");
    expect(classes(grid)).toContain("lg:grid-cols-2");
    expect(classes(grid).some((c) => /^grid-cols-/.test(c))).toBe(false); // no columns without a screen-size prefix: one column below "lg"
  });

  it("makes each column scroll by itself, without hiding the header, the actions or the player", async () => {
    await open();
    for (const panel of [note(), transcript()]) {
      expect(classes(panel)).toContain("flex");
      expect(classes(panel)).toContain("flex-col");
      expect(classes(panel)).toContain("min-h-0");
      expect(classes(panel)).toContain("lg:overflow-hidden"); // the column itself does not scroll...
    }
    const [noteHeader, noteBody, noteFooter] = [...note().children] as HTMLElement[];
    expect(noteBody!.className).toMatch(/\boverflow-y-auto\b/); // ...the middle of it does
    expect(noteBody!.className).toMatch(/\bmin-h-0\b/);
    expect(noteHeader!.className).toMatch(/\bshrink-0\b/);
    expect(classes(noteHeader!)).not.toContain("flex-wrap"); // the status sits beside the title instead of wrapping under it and costing the note a line of room
    expect(noteFooter!.className).toMatch(/\bshrink-0\b/);
    expect(within(noteFooter!).getByRole("button", { name: "Save draft" })).toBeTruthy();

    const [transcriptHeader, transcriptBody] = [...transcript().children] as HTMLElement[];
    expect(transcriptBody!.className).toMatch(/\boverflow-y-auto\b/);
    expect(transcriptBody!.className).toMatch(/\bmin-h-0\b/);
    expect(transcriptHeader!.className).toMatch(/\bshrink-0\b/);
    expect(within(transcriptHeader!).getByRole("group", { name: "Recording player" })).toBeTruthy(); // the player stays put while the lines scroll
    expect(transcriptBody!.contains(transcriptHeader!.querySelector("audio"))).toBe(false);
  });

  it("is exactly one screen tall on a large screen so the columns can scroll, and an ordinary page below that", async () => {
    await open();
    const page = note().parentElement!.parentElement!;
    // The minimum (28rem) plus the shell's 4rem of padding must stay under the shortest laptop window, or the page would scroll as well (a
    // 600px-high window measured 608px with the earlier 34rem).
    expect(classes(page)).toEqual(expect.arrayContaining(["lg:flex", "lg:h-[calc(100dvh-4rem)]", "lg:min-h-[28rem]", "lg:flex-col"]));
    expect(classes(page).filter((c) => !c.startsWith("lg:"))).toEqual([]); // nothing fixes the height on a small screen
    expect(classes(note().parentElement!)).toEqual(expect.arrayContaining(["min-h-0", "flex-1", "lg:grid-rows-[minmax(0,1fr)]"]));
  });

  it("shows who and what this is, and where it stands, above the two columns", async () => {
    await open(reviewable({ patientLabel: "Asha Patel, record 4471" }));
    const grid = note().parentElement!;
    const header = grid.previousElementSibling as HTMLElement;
    expect(within(header).getByRole("heading", { name: "Asha Patel, record 4471" })).toBeTruthy();
    expect(within(header).getByText("Ready for your review")).toBeTruthy(); // the status
    expect(within(header).getByText(/Consent given by the patient, verbally/)).toBeTruthy();
    fireEvent.click(within(header).getByRole("button", { name: "Back" }));
    expect(router.push).toHaveBeenCalledWith("/admin/consultations"); // back to the list
    expect(grid.contains(header)).toBe(false); // it does not scroll away with either column
  });

  it("says Approved, and shows the approved note, once it has been", async () => {
    apiMock.consultationNote.mockResolvedValue(noteDto({ approvedAt: "2026-10-20T10:00:00.000Z", content: noteContent({ flags: [] }) }));
    await open(reviewable({ status: "approved", approvedAt: "2026-10-20T10:00:00.000Z" }));
    expect(screen.getAllByText("Approved").length).toBeGreaterThan(1); // the status and the note's own
    expect(screen.queryByRole("button", { name: /Save draft|Approve note/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Reopen to make changes/ })).toBeTruthy();
  });

  it("keeps the delete actions out of the way, below the two columns, and still reachable", async () => {
    await open();
    const grid = note().parentElement!;
    const deleteRow = screen.getByRole("region", { name: "Delete" });
    expect(grid.contains(deleteRow)).toBe(false);
    expect(within(deleteRow).getByRole("button", { name: /Delete the recording/ })).toBeTruthy();
    expect(within(deleteRow).getByRole("button", { name: /Delete this consultation/ })).toBeTruthy();
    expect(classes(deleteRow)).toContain("shrink-0");
  });
});

describe("the transcript", () => {
  it("shows readable speaker labels and every line in its own script, with the uncertain ones marked", async () => {
    await open();
    const lines = within(transcript()).getAllByRole("listitem");
    expect(lines).toHaveLength(MIXED_TRANSCRIPT.segments.length);
    expect(within(lines[0]!).getByText("Doctor")).toBeTruthy();
    expect(within(lines[1]!).getByText("Patient")).toBeTruthy();
    expect(within(lines[1]!).getByText(/ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે/).getAttribute("lang")).toBeNull(); // mixed: the browser chooses per script
    expect(within(lines[0]!).getByText(/નમસ્તે/).getAttribute("lang")).toBe("gu");
    expect(within(lines[5]!).getByText("Not clearly heard")).toBeTruthy();
    expect(within(lines[0]!).queryByText("Not clearly heard")).toBeNull();
    expect(transcript().textContent).toMatch(/speakers were worked out from the conversation/);
  });

  it("keeps the technical details (who made it, audio quality, the service's notes) folded away", async () => {
    await open();
    const details = transcript().querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.textContent).toMatch(/gemini \(test-model\)/);
    expect(details.textContent).toMatch(/Audio quality/);
    expect(details.textContent).toMatch(/Some background noise/);
  });

  describe("when the speech service measured real times", () => {
    it("lets the doctor pick a line to move the recording to where it starts, without starting or stopping it", async () => {
      apiMock.consultationTranscript.mockResolvedValue(withTimes());
      await open();
      const lines = within(transcript()).getAllByRole("listitem");
      fireEvent.click(within(lines[2]!).getByRole("button", { name: "Go to 00:10 in the recording" })); // 300 + 2 x 5000 ms
      expect(fakeMedia.media.currentTime).toBe(10.3);
      expect(fakeMedia.play).not.toHaveBeenCalled(); // picking a line is not playing
      expect(within(transcript()).getByText("00:10 / 01:00")).toBeTruthy(); // the player moved
      fireEvent.click(within(lines[0]!).getByRole("button", { name: "Go to 00:00 in the recording" }));
      expect(fakeMedia.media.currentTime).toBe(0.3);
      expect(screen.queryByText(/have no times/)).toBeNull();
    });

    it("shows a time for each line that has one and for no other (a line without a time gets none, not an estimate)", async () => {
      const content = { ...MIXED_TRANSCRIPT, segments: MIXED_TRANSCRIPT.segments.map((s, i) => (i % 2 === 0 ? { ...s, startMs: i * 4000 } : s)) };
      apiMock.consultationTranscript.mockResolvedValue(transcriptDto({ content }));
      await open();
      const lines = within(transcript()).getAllByRole("listitem");
      expect(lines.map((l) => within(l).queryAllByRole("button", { name: /^Go to/ }).length)).toEqual([1, 0, 1, 0, 1, 0]);
    });
  });

  describe("when it has no times (the usual case: the speech service does not measure them)", () => {
    it("offers no jump to a time, invents none, and says why", async () => {
      await open();
      expect(within(transcript()).queryAllByRole("button", { name: /^Go to/ })).toHaveLength(0);
      expect(within(transcript()).getByText(/These lines have no times, so they cannot jump to a point in the recording/)).toBeTruthy();
      expect(transcript().textContent).not.toMatch(/\b\d{2}:\d{2}\b(?! \/)/); // no clock time anywhere among the lines (the player's "00:00 / 01:00" is the recording's own length)
      expect(fakeMedia.media.currentTime).toBe(0);
    });
  });
});

describe("telling a mock transcript from a real one", () => {
  it("says plainly that it is test data when it comes from the mock AI: a banner over both columns and a tag on the transcript", async () => {
    apiMock.consultationTranscript.mockResolvedValue(
      transcriptDto({ model: "mock-transcription-model", content: { ...MIXED_TRANSCRIPT, remarks: ["MOCK AI: this is a fixed test transcript, not a transcription of the recording."] } }),
    );
    await open();
    const banner = screen.getByRole("note");
    expect(banner.textContent).toMatch(/Test data/);
    expect(banner.textContent).toMatch(/mock AI/);
    expect(banner.textContent).toMatch(/mock-transcription-model/);
    expect(banner.textContent).toMatch(/nothing to do with what was recorded/);
    expect(banner.compareDocumentPosition(note()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // above the note, so the note is read as test data too
    expect(within(transcript()).getByText("Test data")).toBeTruthy();
    expect(transcript().textContent).toMatch(/mock-transcription-model/); // and the model is named in the details
  });

  it("recognises the mock by its model name alone, even when its remarks say nothing", async () => {
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto({ model: "mock-transcription-model", content: { ...MIXED_TRANSCRIPT, remarks: [] } }));
    await open();
    expect(screen.getByRole("note").textContent).toMatch(/Test data/);
  });

  it("recognises the mock by its own remark as well as by its model name", async () => {
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto({ model: "something", content: { ...MIXED_TRANSCRIPT, remarks: ["MOCK AI: fixed text."] } }));
    await open();
    expect(screen.getByRole("note").textContent).toMatch(/Test data/);
  });

  it("shows nothing of the kind for a real transcription, and names the real service and model instead", async () => {
    apiMock.consultationTranscript.mockResolvedValue(transcriptDto({ provider: "gemini", model: "gemini-3.1-flash" }));
    await open();
    expect(screen.queryByRole("note")).toBeNull();
    expect(within(transcript()).queryByText("Test data")).toBeNull();
    expect(transcript().querySelector("details")!.textContent).toMatch(/gemini \(gemini-3.1-flash\)/);
  });
});

describe("the recording beside the note", () => {
  it("is the player for the stored recording, paused at the start, showing its stored length", async () => {
    await open();
    const player = within(transcript()).getByRole("group", { name: "Recording player" });
    expect(within(player).getByRole("button", { name: "Play the recording" })).toBeTruthy();
    expect(within(player).getByText("00:00 / 01:00")).toBeTruthy();
    expect(transcript().querySelector("audio")!.getAttribute("src")).toBe(`/api/consultations/${ID}/audio`);
    expect(fakeMedia.play).not.toHaveBeenCalled();
  });

  it("says so, instead of showing a player, when the recording has been deleted (the transcript is kept)", async () => {
    await open(reviewable({ recording: { status: "deleted", durationMs: 60_000, sizeBytes: null } }));
    expect(within(transcript()).getByText("The recording was deleted.")).toBeTruthy();
    expect(transcript().querySelector("audio")).toBeNull();
    expect(within(transcript()).getByText(/નમસ્તે/)).toBeTruthy();
  });

  it("is not disturbed when the note is saved and the screen refreshes: the transcript is not fetched again, and the player keeps its element and its place", async () => {
    await open();
    const audio = transcript().querySelector("audio")!;
    await act(async () => fireEvent.click(within(transcript()).getByRole("button", { name: "Play the recording" })));
    fakeMedia.media.currentTime = 4.2;
    fakeMedia.media.duration = 60;
    act(() => void audio.dispatchEvent(new Event("timeupdate")));
    fakeMedia.play.mockClear();

    // the doctor edits and saves; the screen reloads the consultation and the new note version
    fireEvent.change(within(within(note()).getByRole("group", { name: "Chief complaint and symptoms" })).getByRole("textbox"), { target: { value: "Fever for three days." } });
    apiMock.saveConsultationNote.mockResolvedValue(2);
    apiMock.consultationNote.mockResolvedValue(noteDto({ version: 2 }));
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apiMock.consultationNote).toHaveBeenCalledTimes(2));
    await screen.findByText(/Draft, version 2/);

    expect(apiMock.consultationTranscript).toHaveBeenCalledTimes(1); // the transcript did not change, so it was not read again
    expect(transcript().querySelector("audio")).toBe(audio); // the same element
    expect(fakeMedia.media.currentTime).toBe(4.2);
    expect(fakeMedia.media.paused).toBe(false); // still playing
    expect(fakeMedia.play).not.toHaveBeenCalled();
    expect(fakeMedia.pause).not.toHaveBeenCalled();
    expect(fakeMedia.load).not.toHaveBeenCalled();
    expect(within(transcript()).getByText("00:04 / 01:00")).toBeTruthy();
  });

  it("leaves the whole screen's other parts alone too: the note's version remounts the note, never the recording", async () => {
    await open();
    const before = transcript();
    apiMock.consultationNote.mockResolvedValue(noteDto({ version: 2 }));
    apiMock.saveConsultationNote.mockResolvedValue(2);
    fireEvent.change(within(note()).getAllByRole("textbox")[0]!, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText(/Draft, version 2/);
    expect(transcript()).toBe(before); // the transcript panel itself is the same element, not rebuilt
  });
});

describe("the note stays a clinical note", () => {
  it("shows four headings and no more, each line with its source as small links", async () => {
    await open();
    expect(within(note()).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["Chief complaint and symptoms", "Relevant history", "Assessment", "Plan and follow-up"]);
    expect(within(note()).getAllByRole("button", { name: /^Show transcript line/ }).length).toBeGreaterThan(0);
    expect(note().querySelectorAll(".card").length).toBe(0); // no card inside a card: the groups are not separate cards
  });

  it("still holds all nine stored sections, so nothing is lost by grouping", async () => {
    await open();
    apiMock.saveConsultationNote.mockResolvedValue(2);
    fireEvent.change(within(note()).getAllByRole("textbox")[0]!, { target: { value: "Edited complaint." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(apiMock.saveConsultationNote).toHaveBeenCalled());
    expect(apiMock.saveConsultationNote.mock.calls[0]![2].sections.map((s: { key: string }) => s.key)).toEqual([...NOTE_SECTION_KEYS]);
  });

  it("never approves anything by itself: opening the screen, loading the transcript and refreshing send no approval", async () => {
    await open();
    expect(apiMock.approveConsultationNote).not.toHaveBeenCalled();
    expect(apiMock.saveConsultationNote).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: /Approve note/ }) as HTMLButtonElement).disabled).toBe(true); // a flag is waiting for the doctor
  });
});
