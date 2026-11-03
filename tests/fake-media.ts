import { vi } from "vitest";

/**
 * A controllable stand-in for the browser's media element, for tests of anything that plays the recording. jsdom has no media pipeline at all
 * (play, pause and load are "not implemented"), so the state the element would have, and what it would do, is put here: a test changes the state
 * and then dispatches the event the browser would have fired. Call it once per test file; `reset` before each test; `restore` afterwards.
 */
export function installFakeMedia() {
  const media = { currentTime: 0, duration: Number.NaN, paused: true, ended: false, error: null as { code: number } | null };
  const play = vi.fn();
  const pause = vi.fn();
  const load = vi.fn();
  const names = ["currentTime", "duration", "paused", "ended", "error", "play", "pause", "load"] as const;
  const saved = names.map((n) => [n, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, n)] as const);

  const reset = () => {
    Object.assign(media, { currentTime: 0, duration: Number.NaN, paused: true, ended: false, error: null });
    play.mockReset().mockImplementation(async function (this: HTMLMediaElement) {
      media.paused = false;
      media.ended = false;
      this.dispatchEvent(new Event("play"));
      this.dispatchEvent(new Event("playing"));
    });
    pause.mockReset().mockImplementation(function (this: HTMLMediaElement) {
      media.paused = true;
      this.dispatchEvent(new Event("pause"));
    });
    load.mockReset();
  };

  Object.defineProperties(HTMLMediaElement.prototype, {
    currentTime: { configurable: true, get: () => media.currentTime, set: (v: number) => void (media.currentTime = v) },
    duration: { configurable: true, get: () => media.duration },
    paused: { configurable: true, get: () => media.paused },
    ended: { configurable: true, get: () => media.ended },
    error: { configurable: true, get: () => media.error },
    play: { configurable: true, writable: true, value: play },
    pause: { configurable: true, writable: true, value: pause },
    load: { configurable: true, writable: true, value: load },
  });
  reset();

  const restore = () => {
    for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, name, descriptor);
  };
  return { media, play, pause, load, reset, restore };
}
