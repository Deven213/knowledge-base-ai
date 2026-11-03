"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { api } from "@/lib/api";
import { Spinner } from "../ui";

const MAX_SECONDS = 120;
/** Preferred recording formats, in order (the server accepts all of these). */
const FORMATS = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4", "audio/aac"];

type Phase = "idle" | "starting" | "recording" | "transcribing";

function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission is required for voice input.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found on this device.";
  if (name === "NotReadableError") return "The microphone is being used by another app.";
  return "The microphone is unavailable right now.";
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Click to record a question, click Stop to transcribe it into the chat box. Nothing is sent to the
 * chat: the transcript is only placed in the input for the user to review. Hidden when the browser
 * can't record (typing still works).
 */
export function VoiceInputButton({
  language,
  disabled,
  onTranscript,
  onError,
}: {
  /** Language hint for transcription (the current answer language). */
  language: string;
  disabled?: boolean;
  onTranscript: (text: string) => void;
  onError: (message: string | null) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [seconds, setSeconds] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const ok = typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
    queueMicrotask(() => setSupported(ok));
    return () => release(); // leaving the page never keeps the microphone on
  }, []);

  function release() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  async function start() {
    onError(null);
    setPhase("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setPhase("idle");
      onError(micErrorMessage(err));
      return;
    }
    const mimeType = FORMATS.find((f) => MediaRecorder.isTypeSupported(f));
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    } catch {
      release();
      setPhase("idle");
      onError("Voice recording isn't supported in this browser. You can type your question instead.");
      return;
    }
    chunks.current = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.current.push(e.data);
    rec.onstop = () => void finish(rec.mimeType || mimeType || "audio/webm");
    recorder.current = rec;
    rec.start(250);
    setSeconds(0);
    setPhase("recording");
    const started = Date.now();
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS) stop(); // keep questions short (and the upload small)
    }, 250);
  }

  function stop() {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  async function finish(type: string) {
    release();
    const blob = new Blob(chunks.current, { type: type.split(";")[0] });
    chunks.current = [];
    recorder.current = null;
    if (blob.size < 1200) {
      setPhase("idle");
      onError("No speech was recorded. Please try again.");
      return;
    }
    setPhase("transcribing");
    try {
      const text = await api.transcribe(blob, language);
      onTranscript(text);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Voice transcription failed. Please try again.");
    } finally {
      setPhase("idle");
    }
  }

  if (!supported) return null;

  if (phase === "recording") {
    return (
      <div className="flex h-9 shrink-0 items-center gap-2 rounded-full bg-red-50 pr-1 pl-3 ring-1 ring-red-200" role="status" aria-live="polite">
        <span className="h-2.5 w-2.5 rounded-full bg-red-600 motion-safe:animate-pulse" aria-hidden />
        <span className="text-xs font-semibold text-red-700">
          Recording… <span className="tabular-nums">{clock(seconds)}</span>
        </span>
        <button
          type="button"
          onClick={stop}
          className="flex h-7 items-center gap-1 rounded-full bg-red-600 px-2.5 text-xs font-semibold text-white hover:bg-red-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
        >
          <Square className="h-3 w-3 fill-current" /> Stop
        </button>
      </div>
    );
  }

  if (phase === "transcribing" || phase === "starting") {
    return (
      <span className="flex h-9 shrink-0 items-center gap-1.5 px-2 text-xs text-slate-500" role="status">
        <Spinner className="h-3.5 w-3.5" /> {phase === "starting" ? "Starting microphone…" : "Transcribing…"}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void start()}
      disabled={disabled}
      aria-label="Ask with your voice"
      title="Ask with your voice"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-500 disabled:opacity-50"
    >
      <Mic className="h-4.5 w-4.5" />
    </button>
  );
}
