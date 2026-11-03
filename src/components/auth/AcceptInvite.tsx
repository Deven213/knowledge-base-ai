"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Eye, EyeOff, UserCheck } from "lucide-react";
import { api } from "@/lib/api";
import { PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { Alert, Spinner } from "../ui";

interface Invitation {
  organization: string;
  email: string;
  role: string;
  hasAccount: boolean;
}

const ROLE_LABEL: Record<string, string> = { owner: "the workspace's Customer Admin (owner)", admin: "an administrator", member: "a member", doctor: "a doctor", viewer: "a viewer" };

/**
 * Accepting an invitation link. Someone without an account chooses a password and joins; someone who already
 * has an account must be signed in as the invited address. The server decides everything: the link is
 * single-use, tied to one email address, and expires.
 */
export function AcceptInvite({ token }: { token: string }) {
  const [invitation, setInvitation] = useState<Invitation | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .peekInvitation(token)
      .then((i) => !cancelled && setInvitation(i))
      .catch(() => !cancelled && setInvitation(null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.acceptInvitation({ token, ...(invitation?.hasAccount ? {} : { password, name }) });
      window.location.assign(result.redirect); // full navigation so the product loads with the new session
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (invitation === undefined) {
    return (
      <div className="flex justify-center py-10 text-slate-400" role="status">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (invitation === null) {
    return (
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">This link isn&apos;t valid</h1>
        <p className="mt-2 text-sm text-slate-600">The invitation may have expired, been withdrawn, or already been used. Ask the person who invited you for a new link.</p>
        <Link href="/login" className="btn btn-outline mt-5">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void join(e)} className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">Join {invitation.organization}</h1>
        <p className="mt-1 text-sm text-slate-500">
          You&apos;ve been invited as {ROLE_LABEL[invitation.role] ?? invitation.role} using <strong>{invitation.email}</strong>.
        </p>
      </div>

      {invitation.hasAccount ? (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
          This email already has an account. <Link href="/login" className="font-medium text-brand-600 hover:underline">Sign in</Link> with it, then open this link again and press Join.
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="invite-name" className="label">Your name (optional)</label>
            <input id="invite-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <div>
            <label htmlFor="invite-password" className="label">Choose a password</label>
            <div className="relative">
              <input
                id="invite-password"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                required
                minLength={PASSWORD_MIN_LENGTH}
                className="input pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-slate-400 hover:text-slate-700" aria-label={show ? "Hide password" : "Show password"} onClick={() => setShow(!show)}>
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">At least {PASSWORD_MIN_LENGTH} characters.</p>
          </div>
        </>
      )}

      {error && <Alert>{error}</Alert>}
      <button type="submit" className="btn btn-dark w-full" disabled={busy || (!invitation.hasAccount && password.length < PASSWORD_MIN_LENGTH)}>
        {busy ? <Spinner className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />} {invitation.hasAccount ? "Join" : "Create my account and join"}
      </button>
    </form>
  );
}
