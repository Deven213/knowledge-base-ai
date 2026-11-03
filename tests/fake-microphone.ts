import { vi } from "vitest";
import type { RecorderEnv } from "@/components/consultations/useRecorder";

/**
 * A fake microphone and MediaRecorder for tests of the screens: the same behaviour the recorder relies on (states, chunks, events), with the
 * test in control of the clock and of what the microphone "hears". Every call to fakeMicrophone() is independent.
 */
export function fakeMicrophone(options: { supported?: string[]; deny?: string } = {}) {
  const track = { stop: vi.fn(), onended: null as (() => void) | null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const recorders: FakeRecorder[] = [];
  const supported = options.supported ?? ["audio/webm;codecs=opus", "audio/webm"];
  let now = 1000;

  class FakeRecorder {
    static isTypeSupported = (type: string) => supported.includes(type);
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(
      readonly stream: unknown,
      readonly options: { mimeType?: string; audioBitsPerSecond?: number } = {},
    ) {
      this.mimeType = options.mimeType ?? "audio/webm";
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    pause() {
      this.state = "paused";
    }
    resume() {
      this.state = "recording";
    }
    /** What the browser does every second: a chunk of audio. Real-looking (a WebM header) so the server's check would pass. */
    emit(size = 500) {
      const bytes = new Uint8Array(size);
      bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
      this.ondataavailable?.({ data: new Blob([bytes]) });
    }
    /** Audio captured but not yet handed over: a real recorder holds it until the next chunk, requestData() or stop(). */
    pending = 0;
    capture(bytes: number) {
      this.pending += bytes;
    }
    private deliverPending() {
      const size = this.pending;
      this.pending = 0;
      this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }); // empty when nothing is waiting, as a real recorder gives
    }
    requestData() {
      if (this.state === "inactive") throw new DOMException("The recorder is not recording.", "InvalidStateError");
      this.deliverPending();
    }
    stop() {
      if (this.state === "inactive") return;
      this.state = "inactive";
      // Like the real thing: stop() returns at once; afterwards the browser delivers the last of the audio and THEN reports that it stopped.
      queueMicrotask(() => {
        this.deliverPending();
        this.onstop?.();
      });
    }
  }

  const getUserMedia = vi.fn(async () => {
    if (options.deny) throw Object.assign(new Error("denied"), { name: options.deny });
    return stream as unknown as MediaStream;
  });
  const env: Partial<RecorderEnv> = {
    getUserMedia,
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    now: () => now,
    AudioContext: undefined,
    requestWakeLock: undefined,
    isSecureContext: true,
  };
  return { env, recorders, track, getUserMedia, advance: (ms: number) => (now += ms) };
}
