"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Ban, CheckCircle2, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import type { IssuedCredentialsDTO, OrgRole, PlatformMemberDTO, PlatformOrganizationDetailDTO, SessionDTO } from "@/lib/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { Alert, Badge, formatDate, Spinner } from "../ui";
import { CredentialsCard } from "./CredentialsCard";

const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner (Customer Admin)", admin: "Administrator", member: "Member", doctor: "Doctor", viewer: "Viewer" };

function credentialBadge(m: PlatformMemberDTO) {
  if (m.credential.status === "temporary") return <Badge tone="amber">Temporary password until {formatDate(m.credential.expiresAt ?? "", true)}</Badge>;
  if (m.credential.status === "expired") return <Badge tone="red">Temporary password expired</Badge>;
  return null;
}

/** What is waiting for the person's confirmation. Every one of these is confirmed in the page, never with the browser's native dialog. */
type Pending = { kind: "suspend" | "reactivate" | "delete" } | { kind: "disable" | "reissue" | "revoke"; member: PlatformMemberDTO };

/**
 * One customer workspace as the Super Admin sees it: its people, their credentials and its status, with the actions that
 * change them. It deliberately shows no documents, chats or integrations (only how many there are).
 */
export function OrganizationPanel({
  id,
  session,
  onBack,
  onChanged,
  onDeleted,
}: {
  id: string;
  session: SessionDTO;
  onBack: () => void;
  onChanged: () => void;
  onDeleted: (name: string) => void;
}) {
  const [detail, setDetail] = useState<PlatformOrganizationDetailDTO | null>(null);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [issued, setIssued] = useState<{ title: string; credentials: IssuedCredentialsDTO } | null>(null);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .platformGetOrganization(id)
      .then((d) => !cancelled && setDetail(d))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [id, reload]);

  /** Runs an action that needs no confirmation (its error appears at the top of the page). */
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      setReload((n) => n + 1);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!detail) {
    return error ? (
      <div className="space-y-3">
        <Alert>{error}</Alert>
        <button type="button" className="btn btn-outline" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> All customers
        </button>
      </div>
    ) : (
      <div className="flex justify-center py-14 text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  const { organization: org, members, invitations, data } = detail;
  const suspended = org.status === "suspended";
  const isCurrent = org.id === session.organization.id;
  const hasSuperAdmin = members.some((m) => m.isPlatformAdmin);
  const pendingLinks = invitations.filter((i) => i.status === "pending");
  const protectedReason = isCurrent
    ? "You are signed in to this workspace, so it can't be suspended or deleted from here. Switch to another workspace first."
    : hasSuperAdmin
      ? "This workspace contains a Super Admin account, so it can't be deleted from here."
      : null;

  /** Refreshes what the page shows after an action, without waiting for a second request. */
  const refresh = () => {
    setReload((n) => n + 1);
    onChanged();
  };

  const addAdmin = (e: React.FormEvent) => {
    e.preventDefault();
    const target = email;
    void run("admin", async () => {
      setIssued({ title: `Customer Admin added to ${org.name}.`, credentials: await api.platformAddCustomerAdmin(org.id, target) });
      setEmail("");
    });
  };

  /** The dialog for whatever is pending. Its action throws on failure, so the error shows inside the dialog and nothing closes. */
  function dialog(p: Pending) {
    const close = () => setPending(null);
    switch (p.kind) {
      case "suspend":
      case "reactivate": {
        const next = p.kind === "suspend" ? "suspended" : "active";
        return (
          <ConfirmDialog
            key={p.kind}
            title={p.kind === "suspend" ? `Suspend ${org.name}?` : `Reactivate ${org.name}?`}
            confirmLabel={p.kind === "suspend" ? "Suspend workspace" : "Reactivate workspace"}
            tone={p.kind === "suspend" ? "danger" : "default"}
            onCancel={close}
            onConfirm={async () => {
              const updated = await api.platformSetOrganizationStatus(org.id, next);
              setDetail((d) => (d ? { ...d, organization: updated } : d)); // the status changes on screen at once
              close();
              refresh();
            }}
          >
            {p.kind === "suspend" ? (
              <>
                <p>
                  Everyone in <strong>{org.name}</strong> is signed out immediately, and nobody can sign in, switch into it or accept an invitation to it until you reactivate it.
                </p>
                <p>Nothing is deleted: the workspace&apos;s data and accounts are kept exactly as they are.</p>
              </>
            ) : (
              <>
                <p>
                  People in <strong>{org.name}</strong> can sign in again. Earlier sign-ins stay ended, and a temporary password that has expired or been revoked stays expired.
                </p>
              </>
            )}
          </ConfirmDialog>
        );
      }
      case "delete":
        return (
          <ConfirmDialog
            key="delete"
            title={`Delete ${org.name}?`}
            confirmLabel="Delete permanently"
            tone="danger"
            requireText={{ label: `Type the workspace name (${org.name}) to confirm`, value: org.name }}
            onCancel={close}
            onConfirm={async (typed) => {
              const deleted = await api.platformDeleteOrganization(org.id, typed);
              close();
              onDeleted(deleted.name);
            }}
          >
            <p className="font-semibold text-red-700">This permanently deletes the customer workspace &quot;{org.name}&quot; and cannot be undone.</p>
            <p>
              It removes everything the workspace owns: its {members.length} {members.length === 1 ? "person" : "people"}, {data.documents} {data.documents === 1 ? "document" : "documents"} (and their
              search index), {data.conversations} {data.conversations === 1 ? "chat" : "chats"}, {data.integrations} connected {data.integrations === 1 ? "integration" : "integrations"} (with their stored
              connection credentials), invitations and settings.
            </p>
            {data.consultations > 0 && (
              <p>
                It also permanently deletes {data.consultations} doctor {data.consultations === 1 ? "consultation" : "consultations"}: the stored recordings, transcripts and clinical notes. They are removed from storage too.
              </p>
            )}
            <p>
              People who belong only to this workspace lose their accounts too. The audit log keeps a record that the deletion happened. Other customers are not affected. Consider <strong>suspending</strong> instead if
              you may need the data again.
            </p>
          </ConfirmDialog>
        );
      case "disable":
        return (
          <ConfirmDialog
            key={`disable-${p.member.userId}`}
            title={`Disable ${p.member.email}?`}
            confirmLabel="Disable account"
            tone="danger"
            onCancel={close}
            onConfirm={async () => {
              await api.platformSetUserStatus(p.member.userId, "disabled");
              close();
              refresh();
            }}
          >
            <p>
              <strong>{p.member.email}</strong> is signed out everywhere at once and can&apos;t sign in to any workspace until you enable the account again.
            </p>
          </ConfirmDialog>
        );
      case "reissue":
        return (
          <ConfirmDialog
            key={`reissue-${p.member.userId}`}
            title={`Issue a new temporary password for ${p.member.email}?`}
            confirmLabel="Issue new password"
            onCancel={close}
            onConfirm={async () => {
              const credentials = await api.platformReissueCredentials(org.id, p.member.userId);
              setIssued({ title: `New temporary password for ${p.member.email}.`, credentials });
              close();
              refresh();
            }}
          >
            <p>The current temporary password stops working and the person is signed out. The new one is shown once.</p>
          </ConfirmDialog>
        );
      case "revoke":
        return (
          <ConfirmDialog
            key={`revoke-${p.member.userId}`}
            title={`Revoke the temporary password of ${p.member.email}?`}
            confirmLabel="Revoke password"
            tone="danger"
            onCancel={close}
            onConfirm={async () => {
              await api.platformRevokeCredentials(org.id, p.member.userId);
              close();
              refresh();
            }}
          >
            <p>It stops working immediately and the person is signed out. You can issue a new one later.</p>
          </ConfirmDialog>
        );
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-ghost -ml-2" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" /> All customers
        </button>
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold">{org.name}</h2>
        <Badge tone={suspended ? "red" : "green"}>{suspended ? "Suspended" : "Active"}</Badge>
        <button
          type="button"
          className="btn btn-outline"
          disabled={busy !== null || (isCurrent && !suspended)}
          title={isCurrent && !suspended ? "You are signed in to this workspace. Switch to another workspace first." : undefined}
          onClick={() => setPending({ kind: suspended ? "reactivate" : "suspend" })}
        >
          {suspended ? <CheckCircle2 className="h-4 w-4" /> : <Ban className="h-4 w-4" />} {suspended ? "Reactivate" : "Suspend"}
        </button>
      </div>

      {error && <Alert>{error}</Alert>}
      {isCurrent && !suspended && <Alert tone="amber">{protectedReason}</Alert>}
      {issued && <CredentialsCard title={issued.title} credentials={issued.credentials} onDismiss={() => setIssued(null)} />}
      <p className="text-sm text-slate-500">
        Created {formatDate(org.createdAt)}
        {org.reference ? " · reference " + org.reference : ""}. Customer documents, chats and integrations are never shown here: this screen only manages the workspace and its people.
      </p>

      <section className="card" aria-labelledby="people-heading">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 id="people-heading" className="text-lg font-semibold">People ({members.length})</h3>
        </div>
        {members.length === 0 ? (
          <p className="px-5 py-4 text-sm text-slate-500">Nobody has an account in this workspace yet. Add a Customer Admin below.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {members.map((m) => {
              const protectedAccount = m.isPlatformAdmin || m.userId === session.user.id;
              const hasTemporary = m.credential.status !== "set" && !m.isPlatformAdmin;
              return (
                <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-slate-800">{m.displayName || m.email}</p>
                    <p className="truncate text-xs text-slate-500">
                      {m.email} · joined {formatDate(m.joinedAt)} · {m.lastLoginAt ? `last sign-in ${formatDate(m.lastLoginAt)}` : "never signed in"}
                    </p>
                  </div>
                  <Badge tone={m.role === "owner" ? "blue" : "slate"}>{ROLE_LABEL[m.role]}</Badge>
                  {m.isPlatformAdmin && <Badge tone="amber">Super Admin</Badge>}
                  {m.userStatus === "disabled" && <Badge tone="red">Disabled</Badge>}
                  {credentialBadge(m)}
                  {hasTemporary && (
                    <button type="button" className="btn btn-ghost px-2 py-1 text-xs" disabled={busy !== null || suspended} aria-label={`Reissue temporary password for ${m.email}`} onClick={() => setPending({ kind: "reissue", member: m })}>
                      Reissue temporary password
                    </button>
                  )}
                  {hasTemporary && m.credential.status === "temporary" && (
                    <button type="button" className="btn btn-ghost px-2 py-1 text-xs" disabled={busy !== null} aria-label={`Revoke temporary password for ${m.email}`} onClick={() => setPending({ kind: "revoke", member: m })}>
                      Revoke
                    </button>
                  )}
                  {!protectedAccount && (
                    <button
                      type="button"
                      className="btn btn-ghost px-2 py-1 text-xs"
                      disabled={busy !== null}
                      aria-label={`${m.userStatus === "disabled" ? "Enable" : "Disable"} ${m.email}`}
                      onClick={() => (m.userStatus === "disabled" ? void run(`user-${m.userId}`, async () => void (await api.platformSetUserStatus(m.userId, "active"))) : setPending({ kind: "disable", member: m }))}
                    >
                      {m.userStatus === "disabled" ? "Enable" : "Disable"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="links-heading">
        <div className="border-b border-slate-100 px-5 py-4">
          <h3 id="links-heading" className="text-lg font-semibold">Add a Customer Admin</h3>
          <p className="text-sm text-slate-500">
            Creates another administrator account with a random temporary password, shown once. The address must not already have an account. They must choose their own password at their first sign-in.
          </p>
        </div>
        <form onSubmit={addAdmin} className="flex flex-wrap items-end gap-3 px-5 py-4">
          <label className="min-w-56 flex-1">
            <span className="label">Customer Admin&apos;s email</span>
            <input className="input" type="email" required placeholder="admin@customer.com" value={email} onChange={(e) => setEmail(e.target.value)} disabled={suspended} />
          </label>
          <button type="submit" className="btn btn-dark" disabled={busy !== null || suspended}>
            {busy === "admin" ? <Spinner className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />} Add Customer Admin
          </button>
        </form>
        {suspended && <p className="px-5 pb-4 text-xs text-slate-500">Reactivate the workspace to add a Customer Admin.</p>}
        {pendingLinks.length > 0 && (
          <div className="border-t border-slate-100">
            <p className="px-5 pt-3 text-xs text-slate-500">Invitation links issued earlier that haven&apos;t been used yet (they still work until used, withdrawn or expired):</p>
            <ul className="divide-y divide-slate-100">
              {pendingLinks.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{i.email}</span>
                  <span className="text-xs text-slate-500">valid until {formatDate(i.expiresAt)}</span>
                  <Badge tone="amber">invitation link</Badge>
                  <button type="button" className="btn btn-ghost px-2 py-1 text-xs" disabled={busy !== null} aria-label={`Withdraw invitation link for ${i.email}`} onClick={() => void run(`revoke-${i.id}`, () => api.platformRevokeInvitation(org.id, i.id))}>
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="card border-red-200" aria-labelledby="danger-heading">
        <div className="border-b border-red-100 px-5 py-4">
          <h3 id="danger-heading" className="text-lg font-semibold text-red-700">Delete this customer</h3>
          <p className="text-sm text-slate-500">
            Permanently removes the workspace and everything in it: {data.documents} {data.documents === 1 ? "document" : "documents"}, {data.conversations} {data.conversations === 1 ? "chat" : "chats"},{" "}
            {data.integrations} connected {data.integrations === 1 ? "integration" : "integrations"}, and the {members.length} {members.length === 1 ? "person" : "people"} listed above. This cannot be undone. To keep the data, suspend the workspace instead.
            {data.consultations > 0 && ` It includes ${data.consultations} doctor ${data.consultations === 1 ? "consultation" : "consultations"} (recordings, transcripts and notes).`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <button type="button" className="btn border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50" disabled={busy !== null || protectedReason !== null} onClick={() => setPending({ kind: "delete" })}>
            <Trash2 className="h-4 w-4" /> Delete customer…
          </button>
          {protectedReason && <p className="min-w-0 flex-1 text-xs text-slate-500">{protectedReason}</p>}
        </div>
      </section>

      {pending && dialog(pending)}
    </div>
  );
}
