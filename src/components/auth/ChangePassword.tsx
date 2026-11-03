"use client";

import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { api } from "@/lib/api";
import { PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { Alert, Spinner } from "../ui";


/**
 * Choosing a new password. When `forced` (the account only has a temporary password) this is the only page the
 * person can use: the server refuses everything else until it succeeds, so there is no way around it by editing
 * the address bar. The current (temporary) password has to be typed again.
 */
export function ChangePassword({ forced, email }: { forced: boolean; email: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirmation.length > 0 && confirmation !== next;
  const tooShort = next.length > 0 && next.length < PASSWORD_MIN_LENGTH;
  const unchanged = next.length > 0 && next === current;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.changePassword({ currentPassword: current, newPassword: next });
      // Full navigation so the product loads with the fresh session the server has just started.
      window.location.assign(result.redirect);
    } catch (err) {
      setError((err as Error).message);
      setCurrent("");
      setBusy(false);
    }
  }

  const type = show ? "text" : "password";
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">{forced ? "Choose your new password" : "Change your password"}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {forced ? (
            <>
              You signed in with a temporary password. Before you continue, choose a password of your own for <strong>{email}</strong>. The temporary password stops working as soon as you do.
            </>
          ) : (
            <>Changing the password for <strong>{email}</strong> signs you out of every other device.</>
          )}
        </p>
      </div>
      <div>
        <label htmlFor="current-password" className="label">
          {forced ? "Temporary password" : "Current password"}
        </label>
        <input id="current-password" type={type} autoComplete="current-password" className="input" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div>
        <label htmlFor="new-password" className="label">
          New password
        </label>
        <div className="relative">
          <input id="new-password" type={type} autoComplete="new-password" className="input pr-10" value={next} onChange={(e) => setNext(e.target.value)} />
          <button type="button" className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600" aria-label={show ? "Hide passwords" : "Show passwords"} onClick={() => setShow(!show)}>
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
        <p className={`mt-1 text-xs ${tooShort ? "text-red-600" : "text-slate-500"}`}>At least {PASSWORD_MIN_LENGTH} characters.</p>
        {unchanged && <p className="mt-1 text-xs text-red-600">Choose a password that is different from the current one.</p>}
      </div>
      <div>
        <label htmlFor="confirm-password" className="label">
          Confirm new password
        </label>
        <input id="confirm-password" type={type} autoComplete="new-password" className="input" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
        {mismatch && <p className="mt-1 text-xs text-red-600">The passwords don&apos;t match.</p>}
      </div>
      {error && <Alert>{error}</Alert>}
      <button type="submit" className="btn btn-dark w-full" disabled={busy || !current || next.length < PASSWORD_MIN_LENGTH || next !== confirmation || unchanged}>
        {busy ? <Spinner className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />} {busy ? "Saving…" : forced ? "Save and continue" : "Change password"}
      </button>
    </form>
  );
}
