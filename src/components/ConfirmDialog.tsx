"use client";

import { useState, type ReactNode } from "react";
import { Alert, Modal, Spinner } from "./ui";

/**
 * An in-page confirmation, used instead of the browser's native confirm(). Native dialogs are not shown at all by some
 * embedded browsers (confirm() simply returns false), which made every button guarded by one silently do nothing; this
 * dialog always appears, names exactly what is about to happen, shows the server's error without closing, and (for the
 * most dangerous actions) makes the person type a name before the button works.
 *
 * Render it only while a confirmation is pending (give it a key per action) so its state starts fresh each time.
 * `onConfirm` resolves when the action succeeded (the caller then closes the dialog) and throws to show an error here.
 */
export function ConfirmDialog({
  title,
  confirmLabel,
  tone = "default",
  requireText,
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  confirmLabel: string;
  tone?: "default" | "danger";
  /** The person must type this (case-insensitively) before the confirm button works. */
  requireText?: { label: string; value: string };
  onConfirm: (typed: string) => Promise<void>;
  onCancel: () => void;
  children: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = !requireText || typed.trim().toLowerCase() === requireText.value.trim().toLowerCase();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(typed.trim());
    } catch (err) {
      setError((err as Error).message);
      setBusy(false); // on success the caller closes the dialog, so there is nothing to reset
    }
  }

  return (
    <Modal
      open
      title={title}
      onClose={busy ? () => undefined : onCancel}
      footer={
        <>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === "danger" ? "btn bg-red-600 text-white hover:bg-red-700 disabled:opacity-50" : "btn btn-dark"}
            disabled={busy || !matches}
            onClick={() => void submit()}
          >
            {busy && <Spinner className="h-4 w-4" />} {confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-700">
        {children}
        {requireText && (
          <label className="block">
            <span className="label">{requireText.label}</span>
            <input
              className="input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches && !busy) void submit();
              }}
            />
          </label>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}
