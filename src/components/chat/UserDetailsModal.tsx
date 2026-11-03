"use client";

import { useEffect, useRef } from "react";
import { BookOpenText, Lock, MessageSquareText, Sparkles, X } from "lucide-react";
import { profileToForm, type UserChatProfile } from "@/lib/chat/user-chat-profile";
import { UserDetailsForm } from "./UserDetailsForm";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Optional "a few details" bottom sheet over the chat. Never blocking: X, Escape, the backdrop and
 * "Skip for now" all close it. Focus stays inside while open and returns to the chat input after.
 */
export function UserDetailsModal({
  open,
  initial,
  onSave,
  onDismiss,
}: {
  open: boolean;
  initial: UserChatProfile | null;
  onSave: (profile: UserChatProfile) => void;
  /** Closed without saving (X, Escape, backdrop, Skip). */
  onDismiss: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  // Latest callback without re-running the effect (re-running would move focus back to the first field).
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    if (!open) return;
    const sheet = sheetRef.current;
    // Start on the first field, once per opening.
    sheet?.querySelector<HTMLElement>("input, select, textarea")?.focus({ preventScroll: true });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissRef.current();
        return;
      }
      if (e.key !== "Tab" || !sheet) return;
      // Keep Tab / Shift+Tab inside the dialog.
      const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items.at(-1)!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  const formId = "user-details-form";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div
        aria-hidden
        className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px] motion-safe:animate-[fade-in_0.2s_ease-out_both]"
        onMouseDown={onDismiss}
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-details-title"
        aria-describedby="user-details-description"
        className="relative flex max-h-[94dvh] w-full max-w-5xl flex-col rounded-t-3xl bg-white shadow-[0_-12px_40px_-8px_rgba(15,23,42,0.25)] motion-safe:animate-[sheet-up_0.28s_cubic-bezier(0.2,0.8,0.2,1)_both] sm:max-h-[85dvh]"
      >
        {/* Handle + close */}
        <div className="relative flex shrink-0 justify-center pt-3 pb-1">
          <span aria-hidden className="h-1.5 w-12 rounded-full bg-slate-200" />
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Close"
            className="absolute top-2.5 right-3 rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-5 sm:px-8">
          <div className="grid gap-6 md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)] md:gap-10">
            {/* Explanation (illustration hidden on small screens to save space) */}
            <div className="md:pt-4">
              <div aria-hidden className="relative mb-5 hidden h-32 w-40 md:block">
                <div className="absolute top-2 left-0 flex h-16 w-28 items-center gap-2 rounded-2xl rounded-bl-sm bg-brand-50 px-3 shadow-sm ring-1 ring-brand-100">
                  <MessageSquareText className="h-5 w-5 text-brand-600" />
                  <span className="space-y-1.5">
                    <span className="block h-1.5 w-12 rounded-full bg-brand-200" />
                    <span className="block h-1.5 w-8 rounded-full bg-brand-200" />
                  </span>
                </div>
                <div className="brand-gradient absolute right-0 bottom-0 flex h-16 w-24 items-center justify-center rounded-2xl rounded-br-sm text-white shadow-md">
                  <BookOpenText className="h-6 w-6" />
                </div>
                <Sparkles className="absolute top-0 right-6 h-5 w-5 text-amber-400" />
              </div>
              <h2 id="user-details-title" className="pr-8 text-xl leading-snug font-bold text-slate-900 sm:text-2xl">
                A few details to get better answers
              </h2>
              <p id="user-details-description" className="mt-2 text-sm leading-relaxed text-slate-600">
                Help us understand your needs so we can provide more relevant and personalized answers from your documents.
              </p>
              <p className="mt-4 flex items-start gap-2 rounded-xl bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
                <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                Everything here is optional. It stays in this browser tab only and is not sent to the AI.
              </p>
            </div>

            <UserDetailsForm id={formId} initial={profileToForm(initial)} onSubmit={onSave} />
          </div>
        </div>

        {/* Actions (always visible) */}
        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-slate-100 bg-white px-5 py-3 sm:flex-row sm:justify-end sm:px-8 sm:py-4">
          <button type="button" onClick={onDismiss} className="btn btn-outline justify-center px-5 py-2.5">
            Skip for now
          </button>
          <button type="submit" form={formId} className="btn justify-center bg-brand-600 px-5 py-2.5 text-white hover:bg-brand-700">
            Continue to Chat
          </button>
        </div>
      </div>
    </div>
  );
}
