"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { AlertTriangle, Pause, Play, RotateCcw } from "lucide-react";
import { Spinner } from "@/components/ui";
import { mmss } from "./status";

// Playing back a consultation's stored recording.
//
// Why this is not a bare <audio controls>: the browser's recorder writes a WebM that cannot say how long it is (src/lib/webm.ts), so for
// the first part of playback the browser's own controls had no length and no usable timeline (Infinity, then a sudden correction about
// eight seconds in). This player shows what is actually known: the length stored with the recording until the browser has learned the real
// one, and the position the element is actually at, always read back from the element, never simulated.
//
// Rules it keeps (tests/consultation-player.test.tsx):
//   - Nothing plays unless the doctor presses Play (or Play again). It never starts by itself, on load, after a render, a poll or a refresh.
//   - Nothing is loaded until then (preload="none"): a server record of someone listening means they listened.
//   - It only exists for a recording that is stored. While the recording is still being saved, or was deleted, there is no audio element at all,
//     so there is nothing that could look finished.
//   - Re-renders, status polling and transcript refreshes never touch the element. If the whole player is removed and comes back (the layout
//     changes, the doctor goes to another page and returns) it comes back paused at the same position.
//   - The source is released once, when the player is removed, never while it could still be in use.

/** Where each recording was left, so a player that is removed and comes back is paused at the same place. In memory only, never stored. */
const positions = new Map<string, number>();
/** Close enough to the end that "where it was left" means "finished": coming back starts again from the beginning. */
const END_MARGIN_S = 0.25;

export interface RecordingPlayerHandle {
  /** Moves to this point in the recording. Does not start playing, and does not stop playing. */
  seekTo: (ms: number) => void;
}

export interface PlayerRecording {
  status: "uploading" | "stored" | "deleted";
  /** The length stored with the recording, from the recorder's own clock. Null when it is not known. */
  durationMs: number | null;
}

type Phase = "idle" | "loading" | "ready" | "error";

const ERROR_TEXT: Record<number, string> = {
  2: "The recording could not be loaded. Check your connection and try again.",
  3: "This browser could not play the recording.",
  4: "The recording is not available.",
};

export const RecordingPlayer = forwardRef<RecordingPlayerHandle, { src: string; recording: PlayerRecording | null }>(function RecordingPlayer({ src, recording }, ref) {
  const audio = useRef<HTMLAudioElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [time, setTime] = useState(() => positions.get(src) ?? 0);
  const [elementDuration, setElementDuration] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stored = recording?.status === "stored";

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (ms: number) => {
        const a = audio.current;
        if (!a || !Number.isFinite(ms)) return;
        const t = Math.max(0, ms / 1000);
        a.currentTime = t; // before anything is loaded this is the position playback will start from
        setTime(t);
        setEnded(false);
      },
    }),
    [],
  );

  // Put the element where it was left (still paused), and release it when the player goes away.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (!a.getAttribute("src")) a.setAttribute("src", src); // after a development-mode remount of the effects, below
    const left = positions.get(src);
    if (left !== undefined && left > 0 && a.currentTime === 0) a.currentTime = left;
    return () => {
      if (a.currentTime > 0 && !a.ended) positions.set(src, a.currentTime);
      else if (a.ended) positions.delete(src);
      a.pause();
      a.removeAttribute("src");
      a.load(); // stops a download that is still going
    };
  }, [src, stored]);

  if (!recording) return <Notice>There is no recording for this consultation.</Notice>;
  if (recording.status === "uploading") return <Notice>The recording is still being saved. It will appear here when it is complete.</Notice>;
  if (recording.status === "deleted") return <Notice>The recording was deleted.</Notice>;

  const known = recording.durationMs !== null && recording.durationMs > 0 ? recording.durationMs / 1000 : null;
  // The recording's own length once the browser knows it (it is Infinity until then); the stored length before that; nothing if neither.
  const total = elementDuration ?? known;
  const shown = total === null ? time : Math.min(time, total);
  const failed = phase === "error";

  const read = () => {
    const a = audio.current;
    if (!a) return;
    setTime(a.currentTime);
    setElementDuration(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : null);
  };

  async function toggle() {
    const a = audio.current;
    if (!a) return;
    if (!a.paused && !a.ended) {
      a.pause();
      return;
    }
    await start(a, a.ended);
  }

  async function start(a: HTMLAudioElement, fromTheBeginning: boolean) {
    setError(null);
    if (phase !== "ready") setPhase("loading");
    try {
      if (fromTheBeginning) {
        a.currentTime = 0;
        setTime(0);
        setEnded(false);
      }
      await a.play();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      if (name === "AbortError") return; // interrupted by a pause, or by loading something else: not a failure
      setPhase("error");
      setPlaying(false);
      setError(name === "NotAllowedError" ? "The browser did not allow playback." : (ERROR_TEXT[a.error?.code ?? 4] ?? ERROR_TEXT[4]!));
    }
  }

  function retry() {
    const a = audio.current;
    if (!a) return;
    setPhase("idle");
    setError(null);
    a.load();
    void start(a, false);
  }

  return (
    <div role="group" aria-label="Recording player" className="space-y-1.5">
      <audio
        ref={audio}
        src={src}
        preload="none"
        onLoadedMetadata={() => {
          setPhase("ready");
          read();
        }}
        onDurationChange={read}
        onCanPlay={() => setPhase("ready")}
        onTimeUpdate={read}
        onSeeked={read}
        onPlay={() => {
          setPlaying(true);
          setEnded(false);
        }}
        onPlaying={() => {
          setPhase("ready");
          setPlaying(true);
        }}
        onWaiting={() => setPhase((p) => (p === "error" ? p : "loading"))}
        onPause={() => {
          setPlaying(false);
          read();
        }}
        onEnded={() => {
          setPlaying(false);
          setEnded(true);
          read();
        }}
        onError={() => {
          const code = audio.current?.error?.code ?? 4;
          if (code === 1) return; // aborted by us (leaving the page, loading again)
          setPhase("error");
          setPlaying(false);
          setError(ERROR_TEXT[code] ?? ERROR_TEXT[4]!);
        }}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn btn-dark h-9 w-9 shrink-0 rounded-full p-0"
          aria-label={playing ? "Pause the recording" : ended ? "Play the recording again" : "Play the recording"}
          disabled={failed}
          onClick={() => void toggle()}
        >
          {phase === "loading" ? <Spinner /> : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <button type="button" className="btn btn-ghost h-9 w-9 shrink-0 rounded-full p-0" aria-label="Start again from the beginning" disabled={failed} onClick={() => audio.current && void start(audio.current, true)}>
          <RotateCcw className="h-4 w-4" />
        </button>
        <input
          type="range"
          className="h-2 min-w-0 flex-1 cursor-pointer accent-slate-800 disabled:cursor-not-allowed"
          aria-label="Position in the recording"
          aria-valuetext={`${mmss(shown * 1000)}${total === null ? "" : ` of ${mmss(total * 1000)}`}`}
          min={0}
          max={total ?? 0}
          step={0.1}
          value={shown}
          disabled={failed || total === null}
          onChange={(e) => {
            const t = Number(e.target.value);
            if (audio.current) audio.current.currentTime = t;
            setTime(t);
            setEnded(false);
          }}
        />
        <span className="shrink-0 text-xs text-slate-600 tabular-nums" aria-hidden>
          {mmss(shown * 1000)} / {total === null ? "--:--" : mmss(total * 1000)}
        </span>
      </div>
      <div aria-live="polite" className="min-h-4 text-xs">
        {phase === "loading" && <span className="text-slate-500">Loading the recording…</span>}
        {failed && (
          <span className="flex flex-wrap items-center gap-2 text-red-700">
            <AlertTriangle className="h-3.5 w-3.5" /> {error}
            <button type="button" className="font-medium underline" onClick={retry}>
              Try again
            </button>
          </span>
        )}
      </div>
    </div>
  );
});

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
      {children}
    </p>
  );
}
