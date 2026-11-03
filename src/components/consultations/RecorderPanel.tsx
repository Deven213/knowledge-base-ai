"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Mic, Pause, Play, RotateCcw, Square, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { uploadRecording, type UploadApi } from "@/lib/consultation-upload";
import type { FinishedRecording } from "./useRecorder";
import { useRecorder, type RecorderEnv } from "./useRecorder";
import { mmss } from "./status";

const uploadApi: UploadApi = {
  start: (id, mimeType) => api.startRecordingUpload(id, mimeType),
  putPart: async (id, n, bytes, signal) => void (await api.uploadRecordingPart(id, n, bytes, signal)),
  complete: async (id, info) => void (await api.completeRecording(id, info)),
};

/**
 * Stops a visit that is being recorded (or a recording that is still being sent) from being thrown away by accident: closing the tab asks
 * first, and so does clicking a link to another page. The recording lives only in this browser tab until the server has confirmed it.
 */
function useLeaveGuard(active: boolean) {
  const router = useRouter();
  const [target, setTarget] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      setTarget(`${url.pathname}${url.search}${url.hash}`);
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);
  return {
    target,
    stay: () => setTarget(null),
    leave: () => {
      const t = target;
      setTarget(null);
      if (t) router.push(t);
    },
  };
}

function LevelMeter({ level }: { level: number }) {
  return (
    <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-100" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
      <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

export function RecorderPanel({
  consultationId,
  maxMinutes,
  bitsPerSecond,
  onUploaded,
  env,
}: {
  consultationId: string;
  maxMinutes: number;
  bitsPerSecond: number;
  /** The server has stored the recording and queued its processing. */
  onUploaded: () => void;
  /** Replaces the browser's recording features (tests only). */
  env?: Partial<RecorderEnv>;
}) {
  const recorder = useRecorder({ maxMs: maxMinutes * 60_000, bitsPerSecond, env });
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [uploaded, setUploaded] = useState(false); // the server has confirmed: from here on nothing is lost by leaving
  const held = useRef<FinishedRecording | null>(null); // the recording we are sending (kept in memory until the server confirms)
  const abort = useRef<AbortController | null>(null);
  const sending = useRef(false);

  const recording = recorder.recording;
  const live = recorder.phase === "recording" || recorder.phase === "paused" || recorder.phase === "stopping";
  const guard = useLeaveGuard(!uploaded && (live || uploading || recording !== null));

  const send = useCallback(
    async (rec: FinishedRecording) => {
      if (sending.current) return;
      sending.current = true;
      held.current = rec;
      abort.current = new AbortController();
      setUploading(true);
      setUploadError(null);
      setProgress(0);
      try {
        await uploadRecording(uploadApi, consultationId, rec.blob, rec.durationMs, { onProgress: setProgress, signal: abort.current.signal });
        held.current = null;
        setUploaded(true);
        onUploaded();
      } catch (err) {
        setUploadError((err as Error).message || "The recording could not be sent.");
      } finally {
        sending.current = false;
        setUploading(false);
      }
    },
    [consultationId, onUploaded],
  );

  // As soon as the doctor stops, the recording is sent: no extra step to forget.
  useEffect(() => {
    if (recording && !held.current && !uploaded) void send(recording);
  }, [recording, send, uploaded]);
  useEffect(() => () => abort.current?.abort(), []);

  const discard = () => {
    // If the recording had started to be sent, the server holds some of its parts: tell it to throw them away, so the next recording starts clean.
    const hadStartedUploading = held.current !== null;
    abort.current?.abort();
    held.current = null;
    setUploadError(null);
    setConfirmDiscard(false);
    recorder.discard();
    if (hadStartedUploading) void api.deleteRecordingAudio(consultationId).catch(() => undefined);
  };

  return (
    <div className="card p-5">
      {recorder.phase === "idle" && !recording && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50 text-red-600">
            <Mic className="h-7 w-7" />
          </div>
          <div>
            <p className="font-semibold text-slate-900">Ready to record</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
              Place the device where it can hear both of you. You can pause at any time. Recording stops by itself after {maxMinutes} minutes. Stay on this page while recording.
            </p>
          </div>
          <button type="button" className="btn btn-danger px-5 py-2.5" onClick={() => void recorder.start()}>
            <Mic className="h-4 w-4" /> Start recording
          </button>
        </div>
      )}

      {recorder.phase === "requesting" && (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-600" role="status">
          <Spinner /> Waiting for permission to use the microphone… choose Allow in your browser.
        </p>
      )}

      {(recorder.phase === "recording" || recorder.phase === "paused") && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3" role="status" aria-live="polite">
              <span className={`h-3 w-3 rounded-full ${recorder.phase === "recording" ? "bg-red-600 motion-safe:animate-pulse" : "bg-amber-500"}`} aria-hidden />
              <span className="text-sm font-semibold text-slate-900">{recorder.phase === "recording" ? "Recording" : "Paused"}</span>
              <span className="text-2xl font-semibold text-slate-900 tabular-nums" role="timer" aria-label="Time recorded">
                {mmss(recorder.elapsedMs)}
              </span>
            </div>
            <LevelMeter level={recorder.level} />
          </div>
          {recorder.silent && <Alert tone="amber">No sound is being picked up. Check that the microphone is connected, not muted, and close to the speakers.</Alert>}
          <div className="flex flex-wrap gap-2">
            {recorder.phase === "recording" ? (
              <button type="button" className="btn btn-outline" onClick={recorder.pause}>
                <Pause className="h-4 w-4" /> Pause
              </button>
            ) : (
              <button type="button" className="btn btn-outline" onClick={recorder.resume}>
                <Play className="h-4 w-4" /> Resume
              </button>
            )}
            <button type="button" className="btn btn-dark" onClick={recorder.stop}>
              <Square className="h-4 w-4" /> Stop and save
            </button>
            <button type="button" className="btn btn-ghost text-red-700" onClick={() => setConfirmDiscard(true)}>
              <Trash2 className="h-4 w-4" /> Discard
            </button>
          </div>
        </div>
      )}

      {recorder.phase === "stopping" && (
        <p className="flex items-center justify-center gap-2 py-8 text-sm text-slate-600" role="status">
          <Spinner /> Finishing the recording…
        </p>
      )}

      {recorder.notice && recording && <div className="mb-3"><Alert tone="amber">{recorder.notice}</Alert></div>}

      {uploaded && (
        <p className="flex items-center justify-center gap-2 py-8 text-sm font-medium text-emerald-700" role="status">
          Saved securely. Preparing your note…
        </p>
      )}

      {recording && uploading && (
        <div className="space-y-2 py-4" role="status">
          <p className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <Spinner /> Sending the recording securely… {Math.round(progress * 100)}%
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full rounded-full bg-brand-600 transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <p className="text-xs text-slate-500">Keep this page open until it finishes.</p>
        </div>
      )}

      {recording && !uploaded && !uploading && uploadError && (
        <div className="space-y-3 py-2">
          <Alert>{uploadError}</Alert>
          <p className="text-sm text-slate-600">Your recording is still here, on this page. Nothing has been lost, so try again when the connection is back. Do not close this page.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-dark" onClick={() => void send(recording)}>
              <RotateCcw className="h-4 w-4" /> Try again
            </button>
            <button type="button" className="btn btn-ghost text-red-700" onClick={() => setConfirmDiscard(true)}>
              <Trash2 className="h-4 w-4" /> Discard the recording
            </button>
          </div>
        </div>
      )}

      {recorder.phase === "error" && (
        <div className="space-y-3 py-2">
          <Alert>{recorder.error}</Alert>
          <button type="button" className="btn btn-dark" onClick={() => void recorder.start()}>
            <RotateCcw className="h-4 w-4" /> Try again
          </button>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          key="discard"
          title="Discard this recording?"
          confirmLabel="Discard recording"
          tone="danger"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={async () => discard()}
        >
          <p className="text-sm text-slate-700">The recording on this page will be thrown away. It has not been kept anywhere else, so it cannot be brought back.</p>
        </ConfirmDialog>
      )}

      {guard.target && (
        <ConfirmDialog key="leave" title="Leave this page?" confirmLabel="Leave and lose the recording" tone="danger" onCancel={guard.stay} onConfirm={async () => guard.leave()}>
          <p className="text-sm text-slate-700">
            {live ? "A visit is being recorded." : "The recording is still being sent."} If you leave now it will be lost, because it has not been saved on the server yet.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
