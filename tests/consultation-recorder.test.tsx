// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { microphoneMessage, useRecorder, type RecorderEnv } from "@/components/consultations/useRecorder";
import { readWebmDurationMs } from "@/lib/webm";
import { cluster, REAL_HEADER } from "./webm-fixtures";

// A fake microphone and MediaRecorder: enough of the real behaviour (states, chunks, events) to drive the recorder through every path.

class FakeTrack {
  enabled = true;
  stop = vi.fn();
  onended: (() => void) | null = null;
}
class FakeStream {
  track = new FakeTrack();
  getTracks = () => [this.track];
  getAudioTracks = () => [this.track];
}
let recorders: FakeRecorder[];
let supported: string[];
class FakeRecorder {
  static isTypeSupported = (type: string) => supported.includes(type);
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  timeslice?: number;
  constructor(
    readonly stream: FakeStream,
    readonly options: { mimeType?: string; audioBitsPerSecond?: number } = {},
  ) {
    this.mimeType = options.mimeType ?? "audio/webm";
    recorders.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  /** Audio captured but not yet handed over. A real recorder holds it until the next chunk, requestData() or stop(). */
  pending = 0;
  /** The same, when the test cares what the bytes are (a real WebM cluster, say). */
  pendingData: Blob[] = [];
  /** What was called, in order. */
  calls: string[] = [];
  capture(bytes: number) {
    this.pending += bytes;
  }
  captureData(data: Blob) {
    this.pendingData.push(data);
  }
  /** What the browser does every second: hand over a chunk now. */
  emit(size = 500) {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }
  private deliverPending() {
    const parts = [...this.pendingData, new Uint8Array(this.pending)];
    this.pending = 0;
    this.pendingData = [];
    this.ondataavailable?.({ data: new Blob(parts) }); // an empty chunk when nothing is waiting, as a real recorder gives
  }
  requestData() {
    if (this.state === "inactive") throw new DOMException("The recorder is not recording.", "InvalidStateError");
    this.calls.push("requestData");
    this.deliverPending();
  }
  stop() {
    if (this.state === "inactive") return;
    this.calls.push("stop");
    this.state = "inactive";
    // Like the real thing: stop() returns at once, and afterwards the browser delivers the last of the audio in a dataavailable event and THEN fires stop.
    queueMicrotask(() => {
      this.deliverPending();
      this.onstop?.();
    });
  }
}

let clock: number;
let stream: FakeStream;
const env = (overrides: Partial<RecorderEnv> = {}): Partial<RecorderEnv> => ({
  getUserMedia: vi.fn(async () => stream as unknown as MediaStream),
  MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
  now: () => clock,
  AudioContext: undefined,
  requestWakeLock: undefined,
  isSecureContext: true,
  ...overrides,
});
const options = (overrides: Partial<RecorderEnv> = {}, maxMs = 45 * 60_000) => ({ maxMs, bitsPerSecond: 48_000, env: env(overrides) });

/** Lets the time pass: the clock the recorder reads, and the timer that refreshes the display. */
const pass = (ms: number) => act(async () => {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
});

/** Lets everything that is already on its way finish: the recorder's last chunk, and the recording being completed. */
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
/** Presses Stop and waits for the recording to be complete. */
const stopped = async (hook: { result: { current: { stop: () => void } } }) => {
  await act(async () => hook.result.current.stop());
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers();
  recorders = [];
  supported = ["audio/webm;codecs=opus", "audio/webm"];
  clock = 1000;
  stream = new FakeStream();
});
afterEach(() => vi.useRealTimers());

async function started(overrides: Partial<RecorderEnv> = {}, maxMs?: number) {
  const hook = renderHook(() => useRecorder(options(overrides, maxMs)));
  await act(async () => void (await hook.result.current.start()));
  return hook;
}

describe("starting", () => {
  it("asks for the microphone, then records in a supported format at the requested bitrate, a chunk every second", async () => {
    let allow!: (s: MediaStream) => void;
    const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => (allow = resolve)));
    const hook = renderHook(() => useRecorder(options({ getUserMedia })));
    act(() => void hook.result.current.start());
    expect(hook.result.current.phase).toBe("requesting"); // the browser is asking the doctor for permission
    await act(async () => allow(stream as unknown as MediaStream));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true } });
    expect(hook.result.current.phase).toBe("recording");
    expect(recorders).toHaveLength(1);
    expect(recorders[0]!.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 48_000 });
    expect(recorders[0]!.timeslice).toBe(1000);
  });

  it("falls back to the next supported format, and lets the browser choose when none of ours is supported", async () => {
    supported = ["audio/mp4"];
    await started();
    expect(recorders[0]!.options.mimeType).toBe("audio/mp4");
    recorders = [];
    supported = [];
    await started();
    expect(recorders[0]!.options.mimeType).toBeUndefined();
  });

  it("never opens two recorders, however often Start is pressed", async () => {
    const hook = await started();
    await act(async () => void (await hook.result.current.start()));
    await act(async () => void (await hook.result.current.start()));
    expect(recorders).toHaveLength(1);
  });
});

describe("the clock, pause and resume", () => {
  it("counts the time recorded, and not the time spent paused", async () => {
    const hook = await started();
    await pass(5000);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(4750);
    expect(hook.result.current.elapsedMs).toBeLessThanOrEqual(5000);

    act(() => hook.result.current.pause());
    expect(hook.result.current.phase).toBe("paused");
    expect(recorders[0]!.state).toBe("paused");
    const frozen = hook.result.current.elapsedMs;
    await pass(60_000); // a minute with the door closed
    expect(hook.result.current.elapsedMs).toBe(frozen);

    act(() => hook.result.current.resume());
    expect(hook.result.current.phase).toBe("recording");
    expect(recorders[0]!.state).toBe("recording");
    await pass(3000);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(frozen + 2750);
    expect(hook.result.current.elapsedMs).toBeLessThan(frozen + 4000);

    recorders[0]!.emit(800);
    await stopped(hook);
    expect(hook.result.current.recording!.durationMs).toBeGreaterThanOrEqual(7750);
    expect(hook.result.current.recording!.durationMs).toBeLessThanOrEqual(8000); // 5 s + 3 s, never the 60 s pause
  });

  it("pausing also switches the microphone track itself off, and resuming switches it back on", async () => {
    const hook = await started();
    expect(stream.track.enabled).toBe(true);
    act(() => hook.result.current.pause());
    expect(stream.track.enabled).toBe(false);
    act(() => hook.result.current.resume());
    expect(stream.track.enabled).toBe(true);
  });

  it("ignores Pause and Resume when they don't apply", async () => {
    const hook = await started();
    act(() => hook.result.current.resume()); // not paused
    expect(hook.result.current.phase).toBe("recording");
    act(() => hook.result.current.pause());
    act(() => hook.result.current.pause()); // already paused
    expect(hook.result.current.phase).toBe("paused");
  });
});

describe("stopping", () => {
  it("finishes with exactly what was recorded, as one file of the right type, and releases the microphone", async () => {
    const hook = await started();
    await pass(2000);
    recorders[0]!.emit(300);
    recorders[0]!.emit(700);
    await stopped(hook);
    expect(hook.result.current.phase).toBe("finished");
    const { recording } = hook.result.current;
    expect(recording!.blob.size).toBe(1000);
    expect(recording!.blob.type).toBe("audio/webm");
    expect(recording!.mimeType).toBe("audio/webm");
    expect(stream.track.stop).toHaveBeenCalled();
  });

  it("can stop while paused", async () => {
    const hook = await started();
    await pass(1000);
    recorders[0]!.emit();
    act(() => hook.result.current.pause());
    await stopped(hook);
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.recording).not.toBeNull();
  });

  it("says so when nothing was recorded, instead of offering to upload an empty file", async () => {
    const hook = await started();
    await stopped(hook);
    expect(hook.result.current.phase).toBe("error");
    expect(hook.result.current.error).toMatch(/Nothing was recorded/);
    expect(hook.result.current.recording).toBeNull();
  });
});

describe("stopping: nothing recorded is left out, and nothing is finished early", () => {
  it("includes the last of the audio, which the browser only hands over when the recorder stops", async () => {
    const hook = await started();
    await pass(3000);
    recorders[0]!.emit(400); // the chunk for the first seconds
    recorders[0]!.capture(650); // what was said since: still inside the browser until Stop
    await stopped(hook);
    expect(hook.result.current.recording!.blob.size).toBe(1050);
  });

  it("asks the browser for what it is holding before it stops the recorder, so none of it waits behind the stop", async () => {
    const hook = await started();
    recorders[0]!.capture(300);
    await stopped(hook);
    expect(recorders[0]!.calls).toEqual(["requestData", "stop"]);
    expect(hook.result.current.recording!.blob.size).toBe(300);
  });

  it("is still stopping, with nothing to upload, until the last chunk has arrived and the recording is complete", async () => {
    const hook = await started();
    recorders[0]!.emit(400);
    recorders[0]!.capture(300);
    act(() => hook.result.current.stop());
    expect(hook.result.current.phase).toBe("stopping");
    expect(hook.result.current.recording).toBeNull(); // nothing can be uploaded yet
    await settle();
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.recording!.blob.size).toBe(700);
  });

  it("finishes once, even when the browser reports an error and then reports that it stopped", async () => {
    const hook = await started();
    recorders[0]!.emit(600);
    recorders[0]!.capture(100);
    await act(async () => recorders[0]!.onerror?.());
    await settle();
    const first = hook.result.current.recording;
    expect(first!.blob.size).toBe(700);
    await act(async () => recorders[0]!.onstop?.()); // a second report must not turn the finished recording into "nothing was recorded"
    await settle();
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.recording).toBe(first);
  });

  it("leaves no recording behind when it is discarded while it is being completed", async () => {
    const hook = await started();
    recorders[0]!.emit(500);
    act(() => hook.result.current.stop());
    act(() => hook.result.current.discard());
    await settle();
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.recording).toBeNull();
  });

  describe("while the recording is being completed", () => {
    /** Holds back the step that writes the length (it reads the recording), so a test can act in the middle of it. */
    function holdTheLengthStep() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = Blob.prototype.arrayBuffer;
      const spy = vi.spyOn(Blob.prototype, "arrayBuffer").mockImplementation(function (this: Blob) {
        return gate.then(() => original.call(this));
      });
      return { release: () => release(), restore: () => spy.mockRestore() };
    }

    it("stays stopping, with nothing to upload, even though the recorder has stopped and its last chunk has arrived", async () => {
      const held = holdTheLengthStep();
      try {
        const hook = await started();
        recorders[0]!.emit(500);
        recorders[0]!.capture(200);
        await act(async () => hook.result.current.stop());
        await settle();
        expect(recorders[0]!.state).toBe("inactive"); // the browser's recorder is done...
        expect(hook.result.current.phase).toBe("stopping"); // ...but the recording is not complete yet
        expect(hook.result.current.recording).toBeNull();
        held.release();
        await settle();
        expect(hook.result.current.phase).toBe("finished");
        expect(hook.result.current.recording!.blob.size).toBe(700);
      } finally {
        held.restore();
      }
    });

    it("leaves no recording behind when it is discarded in the middle of that", async () => {
      const held = holdTheLengthStep();
      try {
        const hook = await started();
        recorders[0]!.emit(500);
        await act(async () => hook.result.current.stop());
        await settle();
        expect(hook.result.current.phase).toBe("stopping");
        act(() => hook.result.current.discard());
        held.release();
        await settle();
        expect(hook.result.current.phase).toBe("idle");
        expect(hook.result.current.recording).toBeNull();
      } finally {
        held.restore();
      }
    });
  });

  describe("the recording's length", () => {
    it("is written into a browser-made WebM before it is offered for upload, at the point where the audio really ends, and not one byte of the audio is changed", async () => {
      const hook = await started();
      await pass(2400);
      const header = [REAL_HEADER, cluster(0, [0, 20, 40]), cluster(1000, [0, 20, 40])];
      recorders[0]!.ondataavailable?.({ data: new Blob(header) });
      recorders[0]!.ondataavailable?.({ data: new Blob([cluster(2000, [0, 20, 40])]) });
      const asRecorded = new Blob([...header, cluster(2000, [0, 20, 40])]).size;
      await stopped(hook);
      const { recording } = hook.result.current;
      expect(await readWebmDurationMs(recording!.blob)).toBe(2060); // the last block is at 2040 ms, plus one 20 ms packet
      expect(recording!.blob.size).toBe(asRecorded + 11); // a Duration element and nothing else
      expect(recording!.durationMs).toBeGreaterThanOrEqual(2150); // what the doctor saw on the clock is still what is reported
      expect(recording!.durationMs).toBeLessThanOrEqual(2400);
    });

    it("is written even when the last cluster is the one the browser only delivers with Stop", async () => {
      const hook = await started();
      await pass(1100);
      recorders[0]!.ondataavailable?.({ data: new Blob([REAL_HEADER, cluster(0, [0, 20, 40])]) });
      recorders[0]!.captureData(new Blob([cluster(1000, [0, 20, 40])])); // still inside the browser when Stop is pressed
      await stopped(hook);
      expect(await readWebmDurationMs(hook.result.current.recording!.blob)).toBe(1060); // the end of the audio, including that last cluster
    });

    it("is not added to formats that do not need it: the recording is exactly what the browser produced", async () => {
      supported = ["audio/mp4"];
      const hook = await started();
      recorders[0]!.emit(900);
      await stopped(hook);
      const { recording } = hook.result.current;
      expect(recording!.blob.type).toBe("audio/mp4");
      expect(recording!.blob.size).toBe(900);
    });
  });

  it("starts at zero, and counts up from there", async () => {
    const hook = await started();
    expect(hook.result.current.phase).toBe("recording");
    expect(hook.result.current.elapsedMs).toBe(0);
    await pass(1000);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(750);
    expect(hook.result.current.elapsedMs).toBeLessThanOrEqual(1000);
    await pass(2000);
    expect(hook.result.current.elapsedMs).toBeGreaterThanOrEqual(2750);
  });
});

describe("when the microphone can't be used", () => {
  it.each([
    ["NotAllowedError", /blocked.*Allow the microphone/],
    ["SecurityError", /blocked/],
    ["NotFoundError", /No microphone was found/],
    ["NotReadableError", /being used by another app/],
    ["SomethingElse", /could not be started/],
  ])("%s becomes a message the doctor can act on, and nothing is left running", async (name, message) => {
    const hook = renderHook(() => useRecorder(options({ getUserMedia: vi.fn(async () => { throw Object.assign(new Error("x"), { name }); }) })));
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.phase).toBe("error");
    expect(hook.result.current.error).toMatch(message);
    expect(recorders).toHaveLength(0);
    expect(microphoneMessage({ name })).toMatch(message);
  });

  it("can be tried again after an error", async () => {
    let allowed = false;
    const getUserMedia = vi.fn(async () => {
      if (!allowed) throw Object.assign(new Error("x"), { name: "NotAllowedError" });
      return stream as unknown as MediaStream;
    });
    const hook = renderHook(() => useRecorder(options({ getUserMedia })));
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.phase).toBe("error");
    allowed = true;
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.phase).toBe("recording");
    expect(hook.result.current.error).toBeNull();
  });

  it("explains an unsupported browser or an insecure page without ever asking for the microphone", async () => {
    const getUserMedia = vi.fn(async () => stream as unknown as MediaStream);
    const noRecorder = renderHook(() => useRecorder(options({ getUserMedia, MediaRecorder: undefined })));
    await act(async () => void (await noRecorder.result.current.start()));
    expect(noRecorder.result.current.error).toMatch(/can't record audio/);
    const insecure = renderHook(() => useRecorder(options({ getUserMedia, isSecureContext: false })));
    await act(async () => void (await insecure.result.current.start()));
    expect(insecure.result.current.error).toMatch(/secure connection/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("reports a recorder the browser refuses to build, and releases the microphone it had opened", async () => {
    class Refusing extends FakeRecorder {
      constructor() {
        super(new FakeStream());
        throw new Error("NotSupportedError");
      }
    }
    const hook = renderHook(() => useRecorder(options({ MediaRecorder: Refusing as unknown as typeof MediaRecorder })));
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.phase).toBe("error");
    expect(stream.track.stop).toHaveBeenCalled();
  });
});

describe("keeping what was recorded when something goes wrong", () => {
  it("keeps the recording when the microphone is unplugged, and says so", async () => {
    const hook = await started();
    await pass(4000);
    recorders[0]!.emit(900);
    await act(async () => stream.track.onended?.());
    await settle();
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.notice).toMatch(/microphone was disconnected.*kept/);
    expect(hook.result.current.recording!.blob.size).toBe(900);
    expect(hook.result.current.recording!.durationMs).toBeGreaterThanOrEqual(3750);
  });

  it("keeps the recording when the browser's recorder reports an error", async () => {
    const hook = await started();
    recorders[0]!.emit(600);
    await act(async () => recorders[0]!.onerror?.());
    await settle();
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.notice).toMatch(/interrupted by the browser.*kept/);
    expect(hook.result.current.recording!.blob.size).toBe(600);
  });

  it("stops by itself at the maximum length and keeps the recording", async () => {
    const hook = await started({}, 10_000);
    recorders[0]!.emit(500);
    await pass(11_000);
    await settle();
    expect(hook.result.current.phase).toBe("finished");
    expect(hook.result.current.notice).toMatch(/maximum length of 0 minutes|maximum length/);
    expect(hook.result.current.recording!.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(recorders[0]!.state).toBe("inactive");
  });

  it("states the limit in minutes", async () => {
    const hook = await started({}, 45 * 60_000);
    recorders[0]!.emit(500);
    await pass(45 * 60_000 + 1000);
    await settle();
    expect(hook.result.current.notice).toMatch(/maximum length of 45 minutes/);
  });
});

describe("the level meter and the silent microphone", () => {
  /** A microphone whose loudness the test sets. */
  function fakeAudio(sample: { value: number }) {
    return class {
      createAnalyser() {
        return {
          fftSize: 0,
          getByteTimeDomainData: (buffer: Uint8Array) => buffer.fill(sample.value),
        };
      }
      createMediaStreamSource() {
        return { connect: () => undefined };
      }
      close = vi.fn(async () => undefined);
    } as unknown as typeof AudioContext;
  }

  it("warns when nothing is being picked up, after several seconds, and not before", async () => {
    const hook = await started({ AudioContext: fakeAudio({ value: 128 }) });
    await pass(3000);
    expect(hook.result.current.silent).toBe(false);
    await pass(7000);
    expect(hook.result.current.silent).toBe(true);
    expect(hook.result.current.level).toBe(0);
  });

  it("shows the level and never warns when there is sound", async () => {
    const hook = await started({ AudioContext: fakeAudio({ value: 200 }) });
    await pass(10_000);
    expect(hook.result.current.silent).toBe(false);
    expect(hook.result.current.level).toBeGreaterThan(0.1);
  });

  it("does not count paused time as silence", async () => {
    const hook = await started({ AudioContext: fakeAudio({ value: 128 }) });
    await pass(2000);
    act(() => hook.result.current.pause());
    await pass(60_000);
    expect(hook.result.current.silent).toBe(false);
  });

  it("works without any audio analysis at all (the meter is a convenience)", async () => {
    const hook = await started({ AudioContext: undefined });
    await pass(20_000);
    expect(hook.result.current.silent).toBe(false);
    expect(hook.result.current.level).toBe(0);
  });
});

describe("leaving and discarding", () => {
  it("leaving the page switches the microphone off", async () => {
    const hook = await started();
    hook.unmount();
    expect(stream.track.stop).toHaveBeenCalled();
    expect(recorders[0]!.state).toBe("inactive");
  });

  it("discard throws the recording away and goes back to the start with the microphone off", async () => {
    const hook = await started();
    await pass(3000);
    recorders[0]!.emit(900);
    act(() => hook.result.current.discard());
    expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.recording).toBeNull();
    expect(hook.result.current.elapsedMs).toBe(0);
    expect(stream.track.stop).toHaveBeenCalled();
  });

  it("a finished recording can be discarded and a fresh one started", async () => {
    const hook = await started();
    recorders[0]!.emit(900);
    await stopped(hook);
    expect(hook.result.current.phase).toBe("finished");
    act(() => hook.result.current.discard());
    stream = new FakeStream();
    await act(async () => void (await hook.result.current.start()));
    expect(hook.result.current.phase).toBe("recording");
    expect(recorders).toHaveLength(2);
  });
});
