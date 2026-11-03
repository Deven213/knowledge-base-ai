"use client";

import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import type { IssuedCredentialsDTO } from "@/lib/types";
import { formatDate } from "../ui";

/** The text the Super Admin sends to the customer (login page, login ID, temporary password, what happens next). */
export function credentialsMessage(c: IssuedCredentialsDTO): string {
  return [
    `Workspace: ${c.workspaceName}`,
    `Login page: ${c.loginUrl}`,
    `Login ID: ${c.loginId}`,
    `Temporary password: ${c.temporaryPassword}`,
    "",
    `You will be asked to choose your own new password the first time you sign in. This temporary password works until ${formatDate(c.expiresAt, true)} and stops working as soon as you have replaced it.`,
  ].join("\n");
}

function CopyValue({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false); // the field is selectable, so it can still be copied by hand
    }
  }
  return (
    <div className="flex items-center gap-2">
      <input
        className={`input flex-1 text-sm ${mono ? "font-mono" : ""}`}
        readOnly
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-label={label}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className="btn btn-outline" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * A freshly issued temporary password, shown ONCE: the server only keeps a hash of it, and this component keeps it in
 * React state only (never in browser storage, never in the URL). "Done" discards it from the page.
 */
export function CredentialsCard({ title, credentials, onDismiss }: { title: string; credentials: IssuedCredentialsDTO; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(credentialsMessage(credentials));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4" role="status">
      <p className="text-sm font-semibold text-emerald-900">{title}</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[10rem_1fr]">
        <dt className="text-emerald-900/70">Workspace</dt>
        <dd className="font-medium text-slate-900">{credentials.workspaceName}</dd>
        <dt className="text-emerald-900/70">Login page</dt>
        <dd>
          <CopyValue label="Login page URL" value={credentials.loginUrl} />
        </dd>
        <dt className="text-emerald-900/70">Login ID</dt>
        <dd>
          <CopyValue label="Login ID" value={credentials.loginId} mono={false} />
        </dd>
        <dt className="text-emerald-900/70">Temporary password</dt>
        <dd>
          <CopyValue label="Temporary password" value={credentials.temporaryPassword} />
        </dd>
        <dt className="text-emerald-900/70">Works until</dt>
        <dd className="text-slate-700">{formatDate(credentials.expiresAt, true)}</dd>
      </dl>
      <button type="button" className="btn btn-dark" onClick={() => void copyAll()}>
        {copied ? <Check className="h-4 w-4" /> : <KeyRound className="h-4 w-4" />} {copied ? "Credentials copied" : "Copy credentials"}
      </button>
      <ul className="list-disc space-y-1 pl-5 text-sm text-emerald-900">
        <li>
          <strong>This is the only time the temporary password is shown.</strong> It is not stored anywhere: if it is lost, issue a new one.
        </li>
        <li>Send the login page, login ID and temporary password to the customer yourself.</li>
        <li>At their first sign-in the customer must choose their own new password before they can do anything else. The temporary password stops working as soon as they have.</li>
      </ul>
      <button type="button" className="btn btn-ghost" onClick={onDismiss}>
        Done
      </button>
    </div>
  );
}
