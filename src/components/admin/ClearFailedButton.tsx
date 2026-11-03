"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Trash2, XCircle } from "lucide-react";
import { Modal, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import type { ClearFailedDocumentsDTO } from "@/lib/types";

/**
 * "Clear N failed" for the Documents page: confirm in a dialog, then ask the server to remove its failed
 * documents. The server decides which rows are failed, so the list the browser holds can't cause a
 * healthy document to be deleted. The page is told what was removed through `onCleared`.
 */
export function ClearFailedButton({
  failedCount,
  onCleared,
}: {
  failedCount: number;
  onCleared: (result: ClearFailedDocumentsDTO) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  // State updates are async, so a ref is what actually stops a quick double click.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function clearFailed() {
    if (inFlight.current) return;
    inFlight.current = true;
    setConfirmOpen(false);
    setClearing(true);
    try {
      const result = await api.clearFailedDocuments();
      onCleared(result);
      setToast({ ok: true, text: result.message });
    } catch (err) {
      setToast({ ok: false, text: `Couldn't clear failed documents. ${(err as Error).message}` });
    } finally {
      inFlight.current = false;
      setClearing(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-outline"
        disabled={clearing || failedCount === 0}
        aria-busy={clearing}
        onClick={() => setConfirmOpen(true)}
      >
        {clearing ? <Spinner className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
        {clearing ? "Clearing..." : `Clear ${failedCount} failed`}
      </button>

      <Modal
        open={confirmOpen}
        title="Clear failed documents?"
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <button type="button" className="btn btn-outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger" onClick={() => void clearFailed()}>
              Clear Failed Documents
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          This will remove {failedCount} failed document records from the current knowledge base. Indexed and processing
          documents will not be affected.
        </p>
      </Modal>

      {toast && (
        <div
          role={toast.ok ? "status" : "alert"}
          aria-live="polite"
          className={`fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-2 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
            toast.ok ? "bg-slate-900" : "bg-red-600"
          }`}
        >
          {toast.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>{toast.text}</span>
        </div>
      )}
    </>
  );
}
