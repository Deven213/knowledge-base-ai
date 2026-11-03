"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { api } from "@/lib/api";
import { audioManager } from "@/lib/voice/audio-manager";
import { Spinner } from "../ui";

const button = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-60";

/**
 * "Listen" for one AI response: speech is generated only when clicked, in the response's current
 * language, and only one response plays at a time (shared player).
 */
export function TTSButton({ messageId, text, language }: { messageId: string; text: string; language: string }) {
  const snapshot = useSyncExternalStore(audioManager.subscribe, audioManager.getSnapshot, audioManager.getServerSnapshot);
  const key = `${messageId}:${language}`;
  const mine = snapshot.key === key;
  const state = mine ? snapshot.state : "idle";

  // Language changed or the response left the screen: stop its audio.
  useEffect(() => {
    return () => {
      if (audioManager.getSnapshot().key === key) audioManager.stop();
    };
  }, [key]);

  if (!text.trim()) return null;
  const listen = () => void audioManager.play(key, `${language}\u0000${text}`, (signal) => api.speech(text, language, signal));

  return (
    <span className="inline-flex flex-wrap items-center gap-0.5" aria-live="polite">
      {state === "loading" && (
        <button type="button" className={button} onClick={() => audioManager.stop()} title="Cancel">
          <Spinner className="h-3 w-3" /> Preparing audio…
        </button>
      )}
      {(state === "playing" || state === "paused") && (
        <>
          {state === "playing" ? (
            <button type="button" className={button} onClick={() => audioManager.pause()}>
              <Pause className="h-3.5 w-3.5" /> Pause
            </button>
          ) : (
            <button type="button" className={button} onClick={() => audioManager.resume()}>
              <Play className="h-3.5 w-3.5" /> Resume
            </button>
          )}
          <button type="button" className={button} onClick={() => audioManager.stop()}>
            <Square className="h-3 w-3 fill-current" /> Stop
          </button>
        </>
      )}
      {(state === "idle" || state === "ended" || state === "error") && (
        <button type="button" className={button} onClick={listen} aria-label={state === "ended" ? "Listen to this answer again" : "Listen to this answer"}>
          <Volume2 className="h-3.5 w-3.5" /> {state === "ended" ? "Listen again" : "Listen"}
        </button>
      )}
      {state === "error" && snapshot.error && (
        <span role="alert" className="text-[11px] text-red-700">
          {snapshot.error}
        </span>
      )}
    </span>
  );
}
