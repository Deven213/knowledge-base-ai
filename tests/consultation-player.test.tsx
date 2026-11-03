// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordingPlayer, type PlayerRecording, type RecordingPlayerHandle } from "@/components/consultations/RecordingPlayer";
import { installFakeMedia } from "./fake-media";

// The recording player (components/consultations/RecordingPlayer.tsx). The bug it fixes: the browser records a WebM that cannot say how long
// it is, so a bare <audio controls> had no length and no usable timeline for the first ~8 seconds of a 10-second recording, then corrected
// itself. These tests pin down what a doctor must be able to rely on: the player only ever shows what is actually known, never plays by
// itself, keeps its place through re-renders and remounts, and says so when the recording is not there.
//
// jsdom has no media pipeline, so a controllable fake stands in for the element's state and events; the real behaviour of a real browser
// was observed separately (a recording made with a fake microphone, played in Chromium).

/** Every test has its own recording: the player remembers where each one was left, which is right for the doctor and wrong for a test that wants a fresh start. */
let SRC = "";
let recordings = 0;
const stored = (durationMs: number | null = 10_000): PlayerRecording => ({ status: "stored", durationMs });

const fake = installFakeMedia();
const { media, play, pause, load } = fake;

beforeEach(() => {
  SRC = `/api/consultations/recording-${++recordings}/audio`;
  fake.reset();
});
afterEach(cleanup);
afterAll(fake.restore);

const audio = () => document.querySelector("audio")!;
const fire = (type: string) => act(() => void audio().dispatchEvent(new Event(type)));
/** The browser reports where the playback is. */
const playbackAt = (seconds: number, duration = media.duration) => {
  media.currentTime = seconds;
  media.duration = duration;
  fire("timeupdate");
};
const playButton = () => screen.getByRole("button", { name: /^(Play|Pause)/ }) as HTMLButtonElement;
const slider = () => screen.getByRole("slider", { name: "Position in the recording" }) as HTMLInputElement;
const clock = () => screen.getByText(/^\d\d:\d\d \/ (\d\d:\d\d|--:--)$/).textContent;
const mount = (recording: PlayerRecording | null = stored(), src: string = SRC) => render(<RecordingPlayer src={src} recording={recording} />);

describe("it only shows a player for a recording that is really there", () => {
  it("has no audio at all, and says why, while the recording is still being saved, after it was deleted, or when there is none", () => {
    for (const [recording, message] of [
      [{ status: "uploading", durationMs: null }, /still being saved/],
      [{ status: "deleted", durationMs: 60_000 }, /was deleted/],
      [null, /no recording/],
    ] as const) {
      const view = mount(recording);
      expect(document.querySelector("audio")).toBeNull(); // nothing that could look finished
      expect(screen.queryByRole("slider")).toBeNull();
      expect(screen.getByRole("status").textContent).toMatch(message);
      view.unmount();
    }
  });

  it("appears, with a player, once the recording is stored", () => {
    const view = mount({ status: "uploading", durationMs: null });
    expect(document.querySelector("audio")).toBeNull();
    view.rerender(<RecordingPlayer src={SRC} recording={stored()} />);
    expect(audio().getAttribute("src")).toBe(SRC); // the stored recording itself, not a copy or a stand-in
  });
});

describe("it starts paused, shows what is known, and never plays by itself", () => {
  it("is paused, at the start, showing the length stored with the recording and not an invented one", () => {
    mount(stored(10_400));
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording");
    expect(clock()).toBe("00:00 / 00:10");
    expect(slider().max).toBe("10.4");
    expect(slider().value).toBe("0");
    expect(slider().getAttribute("aria-valuetext")).toBe("00:00 of 00:10");
    expect(audio().autoplay).toBe(false);
    expect(audio().hasAttribute("autoplay")).toBe(false);
    expect(audio().preload).toBe("none"); // nothing is fetched (and no listen is recorded) until the doctor presses play
    expect(play).not.toHaveBeenCalled();
  });

  it("says the length is unknown when it is, instead of showing a made-up one, and the slider cannot be used", () => {
    mount(stored(null));
    expect(clock()).toBe("00:00 / --:--");
    expect(slider().disabled).toBe(true);
    expect(slider().getAttribute("aria-valuetext")).toBe("00:00");
  });

  it("does not start when the browser reports that it has loaded, learned the length, or can play (events are not a request to play)", () => {
    mount();
    for (const event of ["loadstart", "loadedmetadata", "durationchange", "loadeddata", "canplay", "canplaythrough", "progress", "suspend", "seeked", "timeupdate"]) fire(event);
    expect(play).not.toHaveBeenCalled();
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording");
  });

  it("does not start in a development-mode double render either, and is not left without its source", () => {
    render(
      <StrictMode>
        <RecordingPlayer src={SRC} recording={stored()} />
      </StrictMode>,
    );
    expect(play).not.toHaveBeenCalled();
    expect(audio().getAttribute("src")).toBe(SRC);
  });
});

describe("the duration, position and progress are the audio's own", () => {
  it("keeps the stored length while the browser reports Infinity (a live-written recording), and never shows Infinity or NaN", () => {
    mount(stored(12_000));
    media.duration = Number.POSITIVE_INFINITY;
    fire("loadedmetadata");
    playbackAt(2.5);
    expect(clock()).toBe("00:02 / 00:12");
    expect(document.body.textContent).not.toMatch(/Infinity|NaN/);
    expect(slider().max).toBe("12");
  });

  it("switches to the recording's own length the moment the browser learns it", () => {
    mount(stored(12_000));
    media.duration = Number.POSITIVE_INFINITY;
    fire("loadedmetadata");
    expect(clock()).toBe("00:00 / 00:12");
    playbackAt(7.9, 10.26); // the browser's durationChange, about eight seconds in, in the old player
    fire("durationchange");
    expect(clock()).toBe("00:07 / 00:10");
    expect(slider().max).toBe("10.26");
  });

  it("uses the recording's own length straight away when the file states it (a recording made with the fix)", () => {
    mount(stored(10_400));
    media.duration = 10.28;
    fire("loadedmetadata");
    expect(clock()).toBe("00:00 / 00:10");
    expect(slider().max).toBe("10.28");
  });

  it("shows the position the audio is at, in the clock, the slider and the screen reader's text", () => {
    mount(stored(10_000));
    playbackAt(5.4, 10);
    expect(clock()).toBe("00:05 / 00:10");
    expect(Number(slider().value)).toBeCloseTo(5.4, 1);
    expect(slider().getAttribute("aria-valuetext")).toBe("00:05 of 00:10");
  });

  it("never shows more than the whole recording (the audio can run past a stated length)", () => {
    mount(stored(10_000));
    playbackAt(11.4, 10);
    expect(clock()).toBe("00:10 / 00:10");
    expect(Number(slider().value)).toBe(10);
    expect(slider().getAttribute("aria-valuetext")).toBe("00:10 of 00:10");
  });
});

describe("start, pause, resume, replay", () => {
  it("plays only when asked, shows that it is playing, pauses where it is, and resumes from there", async () => {
    mount();
    await act(async () => fireEvent.click(playButton()));
    expect(play).toHaveBeenCalledTimes(1);
    expect(playButton().getAttribute("aria-label")).toBe("Pause the recording");

    playbackAt(4.2, 10);
    await act(async () => fireEvent.click(playButton()));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording");
    expect(media.currentTime).toBe(4.2); // pausing does not move it

    await act(async () => fireEvent.click(playButton()));
    expect(play).toHaveBeenCalledTimes(2);
    expect(media.currentTime).toBe(4.2); // resuming carries on from the same place
  });

  it("plays again from the beginning when it has finished", async () => {
    mount();
    await act(async () => fireEvent.click(playButton()));
    playbackAt(10, 10);
    media.paused = true;
    media.ended = true;
    fire("ended");
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording again");
    play.mockClear();
    await act(async () => fireEvent.click(playButton()));
    expect(media.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(1);
    expect(clock()).toBe("00:00 / 00:10");
  });

  it("starts again from the beginning at any moment, with its own button", async () => {
    mount();
    await act(async () => fireEvent.click(playButton()));
    playbackAt(7, 10);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start again from the beginning" })));
    expect(media.currentTime).toBe(0);
    expect(play).toHaveBeenCalledTimes(2);
    expect(clock()).toBe("00:00 / 00:10");
  });

  it("moves to where the slider is put, without starting or stopping anything", () => {
    mount();
    media.duration = 10;
    fire("loadedmetadata");
    fireEvent.change(slider(), { target: { value: "6" } });
    expect(media.currentTime).toBe(6);
    expect(clock()).toBe("00:06 / 00:10");
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
  });

  it("can be told to move to a point in the recording (a transcript line with a real time): it moves, and does not start or stop playback", async () => {
    const handle = createRef<RecordingPlayerHandle>();
    render(<RecordingPlayer ref={handle} src={SRC} recording={stored()} />);
    act(() => handle.current!.seekTo(3500));
    expect(media.currentTime).toBe(3.5);
    expect(clock()).toBe("00:03 / 00:10");
    expect(play).not.toHaveBeenCalled(); // seeking is not playing

    await act(async () => fireEvent.click(playButton()));
    play.mockClear();
    act(() => handle.current!.seekTo(8000));
    expect(media.currentTime).toBe(8);
    expect(pause).not.toHaveBeenCalled(); // and it does not stop what is playing
    expect(play).not.toHaveBeenCalled();
    act(() => handle.current!.seekTo(Number.NaN)); // nonsense is ignored
    expect(media.currentTime).toBe(8);
  });
});

describe("when the recording cannot be played", () => {
  it("shows a clear error instead of a finished-looking player, and tries again when asked", async () => {
    mount();
    play.mockRejectedValueOnce(Object.assign(new Error("no"), { name: "NotSupportedError" }));
    media.error = { code: 4 };
    await act(async () => fireEvent.click(playButton()));
    expect(screen.getByText("The recording is not available.")).toBeTruthy();
    expect(playButton().disabled).toBe(true);
    expect(slider().disabled).toBe(true);

    media.error = null;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(load).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("The recording is not available.")).toBeNull();
    expect(playButton().disabled).toBe(false);
  });

  it("explains a network failure, and ignores the browser reporting that it gave up on purpose", () => {
    mount();
    media.error = { code: 1 };
    fire("error");
    expect(screen.queryByText(/could not be loaded/)).toBeNull(); // an abort is not an error
    media.error = { code: 2 };
    fire("error");
    expect(screen.getByText(/could not be loaded.*connection/)).toBeTruthy();
  });

  it("explains a recording this browser cannot decode", () => {
    mount();
    media.error = { code: 3 };
    fire("error");
    expect(screen.getByText(/could not play the recording/)).toBeTruthy();
  });

  it("says when the browser did not allow playback, and an interrupted play() is not treated as a failure", async () => {
    mount();
    play.mockRejectedValueOnce(Object.assign(new Error("interrupted"), { name: "AbortError" }));
    await act(async () => fireEvent.click(playButton()));
    expect(screen.queryByText(/not available|did not allow/)).toBeNull();
    play.mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
    await act(async () => fireEvent.click(playButton()));
    expect(screen.getByText("The browser did not allow playback.")).toBeTruthy();
  });

  it("shows that it is loading (and not that it is playing) between pressing play and the first sound", async () => {
    mount();
    play.mockImplementationOnce(() => new Promise(() => undefined)); // the browser is still fetching
    act(() => void fireEvent.click(playButton()));
    expect(screen.getByText("Loading the recording…")).toBeTruthy();
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording");
    fire("playing");
    expect(screen.queryByText("Loading the recording…")).toBeNull();
  });
});

describe("renders, status polling, transcript refreshes and remounts", () => {
  it("never touch the element: not its source, not its position, and never play, pause or load", () => {
    const view = mount(stored(10_000));
    const element = audio();
    playbackAt(3.3, 10);
    for (let i = 0; i < 25; i++) {
      // a poll or a transcript refresh gives the parent new objects with the same content, again and again
      view.rerender(<RecordingPlayer src={SRC} recording={{ ...stored(10_000) }} />);
    }
    view.rerender(<RecordingPlayer src={SRC} recording={stored(10_050)} />); // even a changed stored length
    expect(audio()).toBe(element); // the same element, not a new one
    expect(element.getAttribute("src")).toBe(SRC);
    expect(media.currentTime).toBe(3.3);
    expect(play).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(clock()).toBe("00:03 / 00:10");
  });

  it("do not interrupt something that is playing", async () => {
    const view = mount();
    await act(async () => fireEvent.click(playButton()));
    playbackAt(2, 10);
    play.mockClear();
    for (let i = 0; i < 10; i++) view.rerender(<RecordingPlayer src={SRC} recording={{ ...stored() }} />);
    expect(pause).not.toHaveBeenCalled();
    expect(play).not.toHaveBeenCalled();
    expect(media.paused).toBe(false);
    expect(playButton().getAttribute("aria-label")).toBe("Pause the recording");
  });

  it("a player that is removed and comes back is paused at the same place, and does not play by itself", async () => {
    const first = mount(stored(10_000), "/api/consultations/remount/audio");
    await act(async () => fireEvent.click(playButton()));
    playbackAt(4.2, 10);
    await act(async () => fireEvent.click(playButton())); // paused at 4.2
    first.unmount();
    media.paused = true;
    media.currentTime = 0; // a new element starts at the beginning
    play.mockClear();

    mount(stored(10_000), "/api/consultations/remount/audio");
    expect(media.currentTime).toBe(4.2); // put back where it was
    expect(clock()).toBe("00:04 / 00:10");
    expect(Number(slider().value)).toBeCloseTo(4.2, 1);
    expect(playButton().getAttribute("aria-label")).toBe("Play the recording"); // still paused
    expect(play).not.toHaveBeenCalled();
  });

  it("a recording that had finished starts from the beginning when the player comes back", async () => {
    const first = mount(stored(10_000), "/api/consultations/finished/audio");
    await act(async () => fireEvent.click(playButton()));
    playbackAt(10, 10);
    media.paused = true;
    media.ended = true;
    fire("ended");
    first.unmount();
    media.ended = false;
    media.currentTime = 0;
    mount(stored(10_000), "/api/consultations/finished/audio");
    expect(media.currentTime).toBe(0);
    expect(clock()).toBe("00:00 / 00:10");
  });

  it("each recording keeps its own place", async () => {
    const a = mount(stored(10_000), "/api/consultations/one/audio");
    await act(async () => fireEvent.click(playButton()));
    playbackAt(6, 10);
    a.unmount();
    media.currentTime = 0;
    mount(stored(10_000), "/api/consultations/two/audio");
    expect(media.currentTime).toBe(0);
    expect(clock()).toBe("00:00 / 00:10");
  });
});

describe("releasing the audio", () => {
  it("is done once, when the player goes away: it stops playing, remembers the place, lets go of the source and the download", async () => {
    const view = mount(stored(10_000), "/api/consultations/release/audio");
    await act(async () => fireEvent.click(playButton()));
    playbackAt(2, 10);
    const element = audio();
    pause.mockClear();
    load.mockClear();
    view.unmount();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(element.hasAttribute("src")).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("is not done while the player is still in use, however often it is rendered", () => {
    const view = mount();
    for (let i = 0; i < 10; i++) view.rerender(<RecordingPlayer src={SRC} recording={stored()} />);
    expect(load).not.toHaveBeenCalled();
    expect(audio().hasAttribute("src")).toBe(true);
  });

  it("the player creates no object URLs: the source is the server's own address for the stored recording", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const view = mount();
    view.unmount();
    expect(create).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled(); // so there is nothing that could be revoked while it is still in use
    create.mockRestore();
    revoke.mockRestore();
  });
});
