"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FlaskConical, RotateCcw, ShieldCheck, Stethoscope, Trash2 } from "lucide-react";
import { BackButton } from "@/components/BackButton";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Alert, Badge, formatDate, PageHeader, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { ConsultationDetailDTO, ConsultationLimitsDTO, NoteDTO, TranscriptDTO } from "@/lib/consultations";
import { NoteEditor } from "./NoteEditor";
import { RecorderPanel } from "./RecorderPanel";
import { RecordingPlayer, type RecordingPlayerHandle } from "./RecordingPlayer";
import { STAGE_TEXT, STATUS_LABEL, STATUS_TONE, isMockTranscript, mmss } from "./status";
import { TranscriptPanel, type TranscriptHighlight } from "./TranscriptPanel";

const POLL_MS = 3000;

/** One consultation: record it, watch it being processed, then review and approve the note. What is shown follows its status. */
export function ConsultationDetail({ id }: { id: string }) {
  const router = useRouter();
  const [c, setC] = useState<ConsultationDetailDTO | null>(null);
  const [limits, setLimits] = useState<ConsultationLimitsDTO | null>(null);
  const [note, setNote] = useState<NoteDTO | null>(null);
  const [transcript, setTranscript] = useState<TranscriptDTO | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<TranscriptHighlight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"audio" | "consultation" | "upload" | null>(null);
  const [busy, setBusy] = useState(false);
  /** The transcript is loaded once per time the note is ready for review (it does not change when the note is saved or approved). */
  const transcriptAsked = useRef(false);
  const player = useRef<RecordingPlayerHandle>(null);

  const reload = useCallback(async () => {
    try {
      const detail = await api.consultation(id);
      setC(detail);
      setError(null);
      if (detail.status === "needs_review" || detail.status === "approved") {
        setNote(await api.consultationNote(id));
      } else {
        setNote(null);
        setTranscript(null); // a recording that is processed again gets a new transcript
        transcriptAsked.current = false;
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading on mount
    void reload();
    api.consultations().then((o) => setLimits(o.limits), () => undefined);
  }, [reload]);

  // While the AI is working, look again every few seconds: the doctor doesn't have to do anything.
  const processing = c?.status === "processing";
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [processing, reload]);

  const loadTranscript = useCallback(async () => {
    setTranscriptError(null);
    try {
      setTranscript(await api.consultationTranscript(id));
    } catch (err) {
      setTranscriptError((err as Error).message);
    }
  }, [id]);

  // The transcript sits beside the note, so it is loaded (once) as soon as the note is ready. The server records every time it is read.
  const reviewing = c?.status === "needs_review" || c?.status === "approved";
  useEffect(() => {
    if (!reviewing || transcriptAsked.current) return;
    transcriptAsked.current = true;
    void loadTranscript();
  }, [reviewing, loadTranscript]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!c) {
    return error ? (
      <Alert>{error}</Alert>
    ) : (
      <p className="flex items-center gap-2 py-10 text-sm text-slate-500">
        <Spinner /> Loading…
      </p>
    );
  }

  const stored = c.recording?.status === "stored";
  const review = reviewing && note;
  const who = { patient: "the patient", guardian: "the patient's parent or guardian", representative: "an authorised representative" }[c.consent.givenBy];

  return (
    // While a note is being reviewed on a large screen the whole page is exactly one screen tall (the shell's own padding is 4rem), so the note and
    // the transcript scroll by themselves and the header, the actions and the player never move. On a small screen it is an ordinary page.
    <div className={review ? "lg:flex lg:h-[calc(100dvh-4rem)] lg:min-h-[28rem] lg:flex-col" : undefined}>
      <div className="shrink-0">
        {review ? (
          // One row while a note is being reviewed, to leave the room to the note: back, the patient, where it stands, and the consent.
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <BackButton href="/admin/consultations" compact className="-ml-2 shrink-0" />
            <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-slate-900" title={c.patientLabel}>
              {c.patientLabel}
            </h1>
            <Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>
            <p className="text-xs text-slate-500 lg:ml-auto">
              Started {formatDate(c.createdAt, true)}. Consent given by {who}, {c.consent.method === "verbal" ? "verbally" : "in writing"}.
            </p>
          </div>
        ) : (
          <PageHeader
            icon={Stethoscope}
            title={c.patientLabel}
            subtitle={`Started ${formatDate(c.createdAt, true)}. Consent given by ${who}, ${c.consent.method === "verbal" ? "verbally" : "in writing"}.`}
            back="/admin/consultations"
            actions={<Badge tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Badge>}
          />
        )}
        {error && (
          <div className="mb-4">
            <Alert>{error}</Alert>
          </div>
        )}
        {review && transcript && isMockTranscript(transcript) && (
          <div role="note" className="mb-3 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-100 px-3 py-1.5 text-sm text-amber-900">
            <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>
              <strong>Test data.</strong> The transcript and the note come from a mock AI in the test environment ({transcript.model}). They are a fixed example with nothing to do with what was recorded.
            </p>
          </div>
        )}
      </div>

      {c.status === "ready" && limits && <RecorderPanel consultationId={id} maxMinutes={limits.maxMinutes} bitsPerSecond={limits.bitsPerSecond} onUploaded={() => void reload()} />}
      {c.status === "ready" && !limits && (
        <p className="flex items-center gap-2 py-6 text-sm text-slate-500">
          <Spinner /> Getting ready…
        </p>
      )}

      {c.status === "uploading" && (
        <div className="card space-y-3 p-5">
          <Alert tone="amber">An upload of this recording was interrupted, and the recording itself is not on this page any more, so it can&apos;t be finished.</Alert>
          <p className="text-sm text-slate-600">Discard the unfinished upload and record again. Whatever part had reached the server is deleted.</p>
          <button type="button" className="btn btn-dark" disabled={busy} onClick={() => setConfirm("upload")}>
            <RotateCcw className="h-4 w-4" /> Discard and record again
          </button>
        </div>
      )}

      {c.status === "processing" && (
        <div className="card space-y-3 p-5" role="status" aria-live="polite">
          {c.stage === "waiting" ? (
            <>
              <p className="flex items-center gap-2 font-semibold text-slate-900">
                <ShieldCheck className="h-5 w-5 text-emerald-600" /> Your recording is saved
              </p>
              <Alert tone="amber">{c.waitingReason}</Alert>
            </>
          ) : (
            <>
              <p className="flex items-center gap-2 font-semibold text-slate-900">
                <Spinner /> {STAGE_TEXT[c.stage]}…
              </p>
              <p className="text-sm text-slate-600">This usually takes a few minutes. You can leave this page: the note will be waiting for you in your list.</p>
            </>
          )}
          {c.recording?.durationMs ? <p className="text-xs text-slate-500">Recording length {mmss(c.recording.durationMs)}.</p> : null}
        </div>
      )}

      {c.status === "failed" && (
        <div className="card space-y-3 p-5">
          <Alert>{c.failureMessage ?? "Something went wrong while processing this consultation."}</Alert>
          <div className="flex flex-wrap gap-2">
            {stored && (
              <button type="button" className="btn btn-dark" disabled={busy} onClick={() => void run(() => api.retryConsultation(id))}>
                {busy ? <Spinner /> : <RotateCcw className="h-4 w-4" />} Try again
              </button>
            )}
            {!stored && <p className="text-sm text-slate-600">The recording is no longer stored, so it can&apos;t be processed again. Start a new consultation to record again.</p>}
          </div>
        </div>
      )}

      {review && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2 lg:grid-rows-[minmax(0,1fr)]">
          <NoteEditor key={note.version} consultationId={id} note={note} onChanged={() => void reload()} onEvidence={(n) => setHighlight({ segment: n, nonce: Date.now() })} />
          <TranscriptPanel
            transcript={transcript}
            error={transcriptError}
            onRetry={() => void loadTranscript()}
            highlight={highlight}
            onSeek={(ms) => player.current?.seekTo(ms)}
            player={<RecordingPlayer ref={player} src={api.consultationAudioUrl(id)} recording={c.recording} />}
          />
        </div>
      )}

      <section className="mt-3 shrink-0 border-t border-slate-200 pt-2" aria-label="Delete">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-700">Delete</h2>
          {stored && (
            <button type="button" className="btn btn-outline px-2.5 py-1 text-xs text-red-700" onClick={() => setConfirm("audio")}>
              <Trash2 className="h-3.5 w-3.5" /> Delete the recording
            </button>
          )}
          <button type="button" className="btn btn-outline px-2.5 py-1 text-xs text-red-700" onClick={() => setConfirm("consultation")}>
            <Trash2 className="h-3.5 w-3.5" /> Delete this consultation
          </button>
          <p className="basis-full text-xs text-slate-500 sm:basis-auto">Permanent. Each deletion is recorded in the audit log, never its contents.</p>
        </div>
      </section>

      {confirm === "upload" && (
        <ConfirmDialog
          key="upload"
          title="Discard the unfinished upload?"
          confirmLabel="Discard"
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteRecordingAudio(id);
            setConfirm(null);
            await reload();
          }}
        >
          <p className="text-sm text-slate-700">The part of the recording that reached the server will be deleted, and you can record again.</p>
        </ConfirmDialog>
      )}
      {confirm === "audio" && (
        <ConfirmDialog
          key="audio"
          title="Delete the recording?"
          confirmLabel="Delete the recording"
          tone="danger"
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteRecordingAudio(id);
            setConfirm(null);
            await reload();
          }}
        >
          <p className="text-sm text-slate-700">
            The audio is permanently deleted. {c.status === "processing" ? "It has not been processed yet, so no note will be made. " : "The transcript and the note are kept. "}You will not be able to listen to it again.
          </p>
        </ConfirmDialog>
      )}
      {confirm === "consultation" && (
        <ConfirmDialog
          key="consultation"
          title="Delete this consultation?"
          confirmLabel="Delete consultation"
          tone="danger"
          requireText={{ label: "Type delete to confirm", value: "delete" }}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await api.deleteConsultation(id);
            router.push("/admin/consultations");
          }}
        >
          <p className="text-sm text-slate-700">
            This permanently deletes the recording, the transcript, every version of the note and the consent record for {c.patientLabel}.{" "}
            {c.status === "approved" ? "The note has been approved: check that you are allowed to delete it. " : ""}It cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
