"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { finishRecordingBlob } from "@/lib/webm";

// Recording a consultation in the browser with MediaRecorder.
//
//   idle → requesting (asking for the microphone) → recording ⇄ paused → stopping → finished   (or error, from anywhere)
//
// The recording stays in memory until it has been uploaded and confirmed: nothing is written to the computer's storage. The hook keeps
// time itself (excluding the time spent paused), stops at the maximum length, keeps what it has if the microphone is unplugged, and
// notices a microphone that is picking up nothing so the doctor finds out in seconds rather than after the visit.
//
// Stopping is not instant, and "finished" means the recording is complete: the browser hands over the last of the audio in a final
// `dataavailable` event and only then reports `stop`; the recording is then given its length (src/lib/webm.ts: a browser writes the file
// without one, which is what made players show a wrong timeline). Until both have happened the phase stays "stopping", so nothing is
// uploaded early and nothing recorded is left out.

export type RecorderPhase = "idle" | "requesting" | "recording" | "paused" | "stopping" | "finished" | "error";

export interface FinishedRecording {
  blob: Blob;
  durationMs: number;
  mimeType: string;
}

export interface RecorderState {
  phase: RecorderPhase;
  /** Time recorded so far, not counting time spent paused. */
  elapsedMs: number;
  /** 0..1, how loud the room is right now (0 when it can't be measured). */
  level: number;
  /** The microphone has picked up (almost) nothing for several seconds. */
  silent: boolean;
  /** Something the doctor should know that isn't an error (the length limit was reached, the microphone was unplugged). */
  notice: string | null;
  error: string | null;
  recording: FinishedRecording | null;
}

export interface RecorderEnv {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  MediaRecorder: typeof MediaRecorder | undefined;
  now: () => number;
  AudioContext: typeof AudioContext | undefined;
  requestWakeLock: (() => Promise<{ release: () => Promise<void> }>) | undefined;
  isSecureContext: boolean;
}

export interface RecorderOptions {
  maxMs: number;
  bitsPerSecond: number;
  env?: Partial<RecorderEnv>;
}

const PREFERRED_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
const TICK_MS = 250;
const SILENCE_AFTER_MS = 8000;
const SILENCE_LEVEL = 0.01;

const initial: RecorderState = { phase: "idle", elapsedMs: 0, level: 0, silent: false, notice: null, error: null, recording: null };

/** Why the microphone couldn't be used, in words a doctor can act on. */
export function microphoneMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Allow the microphone for this site (the icon in the address bar), then try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Connect one and try again.";
  if (name === "NotReadableError" || name === "AbortError") return "The microphone is being used by another app. Close it and try again.";
  return "The microphone could not be started. Check it is connected and allowed, then try again.";
}

function defaultEnv(): RecorderEnv {
  const w = typeof window === "undefined" ? undefined : window;
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    MediaRecorder: typeof MediaRecorder === "undefined" ? undefined : MediaRecorder,
    now: () => performance.now(),
    AudioContext: w ? (w.AudioContext ?? (w as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined,
    requestWakeLock: typeof navigator !== "undefined" && "wakeLock" in navigator ? () => (navigator as unknown as { wakeLock: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock.request("screen") : undefined,
    isSecureContext: w ? w.isSecureContext : false,
  };
}

export function useRecorder({ maxMs, bitsPerSecond, env: envOverride }: RecorderOptions) {
  const [state, setState] = useState<RecorderState>(initial);
  // What the browser provides (or what a test substitutes). Refreshed after every render, and only ever read from handlers and timers.
  const env = useRef<RecorderEnv | null>(null);
  useEffect(() => {
    env.current = { ...defaultEnv(), ...envOverride };
  });
  const getEnv = useCallback((): RecorderEnv => env.current ?? { ...defaultEnv(), ...envOverride }, [envOverride]);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const accumulated = useRef(0); // time recorded before the current stretch
  const stretchStart = useRef<number | null>(null); // when the current (unpaused) stretch began
  const audio = useRef<{ context: AudioContext; analyser: AnalyserNode; buffer: Uint8Array<ArrayBuffer> } | null>(null);
  const loudest = useRef(0);
  const wakeLock = useRef<{ release: () => Promise<void> } | null>(null);
  const pendingNotice = useRef<string | null>(null);
  const discarding = useRef(false);
  /** A recorder that reports an error and then stops would otherwise be finished twice (the second time with nothing left in it). */
  const finished = useRef(false);

  const elapsed = useCallback(() => accumulated.current + (stretchStart.current === null ? 0 : getEnv().now() - stretchStart.current), [getEnv]);

  const release = useCallback(() => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    stream.current = null;
    void audio.current?.context.close().catch(() => undefined);
    audio.current = null;
    void wakeLock.current?.release().catch(() => undefined);
    wakeLock.current = null;
  }, []);

  // Leaving the page never keeps the microphone on.
  useEffect(
    () => () => {
      discarding.current = true;
      if (recorder.current && recorder.current.state !== "inactive") {
        try {
          recorder.current.stop();
        } catch {
          /* already stopped */
        }
      }
      release();
    },
    [release],
  );

  /** Called when the browser's recorder has stopped, which is after it has delivered everything it recorded. */
  const finish = useCallback(
    async (mime: string) => {
      if (finished.current) return;
      finished.current = true;
      const durationMs = Math.round(elapsed());
      stretchStart.current = null;
      release();
      const type = (mime || "audio/webm").split(";")[0]!;
      const recorded = new Blob(chunks.current, { type });
      chunks.current = [];
      recorder.current = null;
      if (discarding.current) return;
      if (recorded.size === 0) {
        setState((s) => ({ ...s, phase: "error", error: "Nothing was recorded. Check the microphone and try again.", level: 0, recording: null }));
        return;
      }
      // Still "stopping" while the recording is given its length: only now is it complete.
      const blob = await finishRecordingBlob(recorded, durationMs);
      if (discarding.current) return;
      setState((s) => ({ ...s, phase: "finished", elapsedMs: durationMs, level: 0, notice: pendingNotice.current ?? s.notice, recording: { blob, durationMs, mimeType: type } }));
    },
    [elapsed, release],
  );

  const stop = useCallback(() => {
    const rec = recorder.current;
    if (!rec || rec.state === "inactive") return;
    setState((s) => ({ ...s, phase: "stopping" }));
    // Freeze the clock now: anything said after Stop is not part of the recording.
    accumulated.current = elapsed();
    stretchStart.current = null;
    // Ask for what the browser is still holding before stopping it. The last of the audio is delivered before the recorder reports that it has
    // stopped, and this makes sure none of it is waiting behind that (the empty chunk that stop() then produces is ignored).
    try {
      rec.requestData();
    } catch {
      /* not allowed in this state: stop() delivers it anyway */
    }
    rec.stop();
  }, [elapsed]);

  const start = useCallback(async () => {
    const e = getEnv();
    if (state.phase === "requesting" || state.phase === "recording" || state.phase === "paused" || state.phase === "stopping") return;
    if (!e.isSecureContext) {
      setState({ ...initial, phase: "error", error: "Recording needs a secure connection (https). Open this page from your organisation's secure address." });
      return;
    }
    if (!e.MediaRecorder || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia && !envOverride?.getUserMedia) {
      setState({ ...initial, phase: "error", error: "This browser can't record audio. Use a current version of Chrome, Edge, Firefox or Safari." });
      return;
    }
    discarding.current = false;
    finished.current = false;
    pendingNotice.current = null;
    chunks.current = [];
    accumulated.current = 0;
    stretchStart.current = null;
    loudest.current = 0;
    setState({ ...initial, phase: "requesting" });

    let media: MediaStream;
    try {
      media = await e.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setState({ ...initial, phase: "error", error: microphoneMessage(err) });
      return;
    }
    if (discarding.current) {
      media.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.current = media;

    const mimeType = PREFERRED_TYPES.find((t) => e.MediaRecorder!.isTypeSupported?.(t));
    let rec: MediaRecorder;
    try {
      rec = new e.MediaRecorder(media, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: bitsPerSecond });
    } catch {
      release();
      setState({ ...initial, phase: "error", error: "This browser can't record in a supported audio format. Use a current version of Chrome, Edge, Firefox or Safari." });
      return;
    }
    rec.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.current.push(ev.data);
    };
    rec.onstop = () => void finish(rec.mimeType || mimeType || "audio/webm");
    rec.onerror = () => {
      pendingNotice.current = "The recording was interrupted by the browser. What was recorded up to that point has been kept.";
      if (rec.state !== "inactive") rec.stop();
      else void finish(rec.mimeType || mimeType || "audio/webm");
    };
    // An unplugged or revoked microphone ends the track: keep everything recorded so far instead of losing it.
    media.getAudioTracks().forEach((track) => {
      track.onended = () => {
        pendingNotice.current = "The microphone was disconnected. What was recorded up to that point has been kept.";
        stop();
      };
    });

    // A level meter (and the silent-microphone check), when the browser has what it needs.
    if (e.AudioContext) {
      try {
        const context = new e.AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(media).connect(analyser);
        audio.current = { context, analyser, buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)) };
      } catch {
        audio.current = null;
      }
    }
    void e.requestWakeLock?.().then((lock) => (wakeLock.current = lock)).catch(() => undefined);

    rec.start(1000); // a chunk every second, so little is lost if the browser stops the recorder
    recorder.current = rec;
    stretchStart.current = e.now();
    timer.current = setInterval(() => {
      const ms = elapsed();
      let level = 0;
      const a = audio.current;
      if (a && stretchStart.current !== null) {
        a.analyser.getByteTimeDomainData(a.buffer);
        let sum = 0;
        for (const v of a.buffer) sum += ((v - 128) / 128) ** 2;
        level = Math.min(1, Math.sqrt(sum / a.buffer.length) * 3);
        loudest.current = Math.max(loudest.current, level);
      }
      const silent = !!a && ms > SILENCE_AFTER_MS && loudest.current < SILENCE_LEVEL;
      setState((s) => (s.phase === "recording" || s.phase === "paused" ? { ...s, elapsedMs: Math.round(ms), level, silent } : s));
      if (ms >= maxMs && stretchStart.current !== null) {
        pendingNotice.current = `The recording reached the maximum length of ${Math.round(maxMs / 60000)} minutes and was stopped. It has been kept.`;
        stop();
      }
    }, TICK_MS);
    setState({ ...initial, phase: "recording" });
  }, [bitsPerSecond, elapsed, envOverride?.getUserMedia, finish, getEnv, maxMs, release, state.phase, stop]);

  const pause = useCallback(() => {
    const rec = recorder.current;
    if (!rec || rec.state !== "recording") return;
    rec.pause();
    // The recorder has stopped capturing; also switch the microphone track itself off, so nothing is picked up while the door is closed.
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    accumulated.current = elapsed();
    stretchStart.current = null;
    setState((s) => ({ ...s, phase: "paused", level: 0, elapsedMs: Math.round(accumulated.current) }));
  }, [elapsed]);

  const resume = useCallback(() => {
    const rec = recorder.current;
    if (!rec || rec.state !== "paused") return;
    stream.current?.getAudioTracks().forEach((t) => (t.enabled = true));
    rec.resume();
    stretchStart.current = getEnv().now();
    setState((s) => ({ ...s, phase: "recording" }));
  }, [getEnv]);

  /** Throws the recording away (nothing has been sent anywhere) and goes back to the start. */
  const discard = useCallback(() => {
    discarding.current = true;
    if (recorder.current && recorder.current.state !== "inactive") {
      try {
        recorder.current.stop();
      } catch {
        /* already stopped */
      }
    }
    release();
    recorder.current = null;
    chunks.current = [];
    accumulated.current = 0;
    stretchStart.current = null;
    setState(initial);
  }, [release]);

  return { ...state, start, pause, resume, stop, discard };
}
