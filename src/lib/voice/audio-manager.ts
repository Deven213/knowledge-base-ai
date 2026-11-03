// One audio player for the whole chat: starting an answer's audio stops any other. Generated audio
// is kept in memory for this page (object URLs) so "Listen again" doesn't call the server twice.

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface PlaybackSnapshot {
  /** Which answer (and language) the player is working on. */
  key: string | null;
  state: PlaybackState;
  error: string | null;
}

const IDLE: PlaybackSnapshot = { key: null, state: "idle", error: null };
const MAX_CACHED = 20;

class AudioManager {
  private audio: HTMLAudioElement | null = null;
  private snapshot: PlaybackSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private urls = new Map<string, string>(); // cache key → object URL
  private pending: AbortController | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => IDLE;

  private set(next: PlaybackSnapshot) {
    this.snapshot = next;
    this.listeners.forEach((fn) => fn());
  }

  private element(): HTMLAudioElement {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.preload = "auto";
      this.audio.addEventListener("ended", () => this.snapshot.key && this.set({ key: this.snapshot.key, state: "ended", error: null }));
      this.audio.addEventListener("pause", () => {
        if (this.snapshot.state === "playing" && !this.audio!.ended) this.set({ ...this.snapshot, state: "paused" });
      });
      this.audio.addEventListener("play", () => this.snapshot.key && this.set({ ...this.snapshot, state: "playing", error: null }));
    }
    return this.audio;
  }

  /**
   * Plays `key`'s audio, fetching it with `load` only if it isn't cached for `cacheKey`.
   * Anything else that was playing (or loading) is stopped first.
   */
  async play(key: string, cacheKey: string, load: (signal: AbortSignal) => Promise<Blob>): Promise<void> {
    this.stop();
    const audio = this.element();
    let url = this.urls.get(cacheKey);
    if (!url) {
      const controller = new AbortController();
      this.pending = controller;
      this.set({ key, state: "loading", error: null });
      try {
        const blob = await load(controller.signal);
        if (controller.signal.aborted) return;
        if (blob.size === 0) throw new Error("No audio was produced for this answer. Please try again.");
        url = URL.createObjectURL(blob);
        this.remember(cacheKey, url);
      } catch (err) {
        if (controller.signal.aborted) return;
        this.set({ key, state: "error", error: err instanceof Error ? err.message : "Speech playback is temporarily unavailable." });
        return;
      } finally {
        if (this.pending === controller) this.pending = null;
      }
    }
    this.set({ key, state: "loading", error: null });
    audio.src = url;
    try {
      await audio.play();
    } catch {
      this.set({ key, state: "error", error: "Your browser blocked audio playback. Click Listen again." });
    }
  }

  pause() {
    if (this.snapshot.state === "playing") this.element().pause();
  }

  resume() {
    if (this.snapshot.state === "paused") void this.element().play();
  }

  /** Stops playback (or a pending request) and resets to the start. */
  stop() {
    this.pending?.abort();
    this.pending = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    if (this.snapshot.state !== "idle") this.set(IDLE);
  }

  private remember(cacheKey: string, url: string) {
    this.urls.set(cacheKey, url);
    while (this.urls.size > MAX_CACHED) {
      const [oldKey, oldUrl] = this.urls.entries().next().value as [string, string];
      if (this.audio?.src !== oldUrl) URL.revokeObjectURL(oldUrl);
      this.urls.delete(oldKey);
    }
  }
}

export const audioManager = new AudioManager();
