"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Trash2, UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import type { CreatedInvitationDTO, InvitationDTO, MemberDTO, OrgRole, SessionDTO } from "@/lib/types";
import { canChangeRole, invitableRoles, ROLES } from "@/server/authz/permissions";
import { Alert, Badge, formatDate, Spinner } from "../ui";

const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Administrator", member: "Member", doctor: "Doctor", viewer: "Viewer" };
const ROLE_HELP: Record<OrgRole, string> = {
  owner: "Full control of the workspace.",
  admin: "Manages the team, integrations and documents.",
  member: "Uploads documents and chats.",
  doctor: "Records consultations and reviews their own clinical notes. Nobody else can open them.",
  viewer: "Chats and reads documents.",
};

/**
 * People and invitations of the current workspace. Everything shown is for the signed-in person's own
 * workspace only. The choices offered follow the same rules the server enforces (you can't grant a role above
 * your own, only an owner can change an owner); the server still checks every request.
 */
export function TeamManagement() {
  const [session, setSession] = useState<SessionDTO | null>(null);
  const [members, setMembers] = useState<MemberDTO[] | null>(null);
  const [invitations, setInvitations] = useState<InvitationDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedInvitationDTO | null>(null);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Exclude<OrgRole, "owner">>("member");

  const actorRole = session?.organization.role;
  const canManage = !!session?.permissions.includes("members:manage");

  /** Everything the page needs, fetched without touching state. Only people who may manage the team ask for the member list. */
  const fetchTeam = useCallback(async () => {
    const me = await api.me();
    if (!me.permissions.includes("members:manage")) return { me, members: [] as MemberDTO[], invitations: [] as InvitationDTO[] };
    const [members, invitations] = await Promise.all([api.listMembers(), api.listInvitations()]);
    return { me, members, invitations };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTeam()
      .then((r) => {
        if (cancelled) return;
        setSession(r.me);
        setMembers(r.members);
        setInvitations(r.invitations);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
        setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchTeam]);

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const invite = (e: React.FormEvent) => {
    e.preventDefault();
    void run("invite", async () => {
      const result = await api.createInvitation(email, role);
      setCreated(result);
      setCopied(false);
      setEmail("");
      setInvitations(await api.listInvitations());
    });
  };

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (members === null || !session) {
    return (
      <div className="flex justify-center py-14 text-slate-400">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <section className="card p-5">
        <h2 className="font-semibold text-slate-800">Team</h2>
        <p className="mt-1 text-sm text-slate-600">
          You are {ROLE_LABEL[session.organization.role].toLowerCase()} in <strong>{session.organization.name}</strong>. Only administrators and owners can manage the team.
        </p>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
      </section>
    );
  }

  const myRole = actorRole!;
  const ownerCount = members.filter((m) => m.role === "owner").length;
  // The server refuses to demote or remove the last owner, so don't offer it.
  const isLastOwner = (m: MemberDTO) => m.role === "owner" && ownerCount <= 1;
  const assignable = (target: MemberDTO) => (isLastOwner(target) ? [] : ROLES.filter((r) => canChangeRole(myRole, target.role, r)));
  const pending = invitations.filter((i) => i.status === "pending");

  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}

      <section className="card" aria-labelledby="members-heading">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 id="members-heading" className="text-lg font-semibold">People in {session.organization.name}</h2>
          <p className="text-sm text-slate-500">{members.length} member{members.length === 1 ? "" : "s"}. Documents are shared with everyone here; chats stay private to their author.</p>
        </div>
        <ul className="divide-y divide-slate-100">
          {members.map((m) => {
            const options = assignable(m);
            const you = m.userId === session.user.id;
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-slate-800">
                    {m.displayName || m.email} {you && <Badge tone="blue">You</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500">{m.email} · joined {formatDate(m.joinedAt)}</p>
                </div>
                {options.length > 0 ? (
                  <label>
                    <span className="sr-only">Role of {m.email}</span>
                    <select
                      className="input w-44 text-sm"
                      value={m.role}
                      disabled={busy !== null}
                      onChange={(e) => void run(`role-${m.userId}`, async () => setMembers(await api.changeMemberRole(m.userId, e.target.value as OrgRole)))}
                    >
                      {options.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span title={isLastOwner(m) ? "A workspace always needs an owner. Make someone else an owner first." : undefined}>
                    <Badge tone="slate">{ROLE_LABEL[m.role]}</Badge>
                  </span>
                )}
                {!isLastOwner(m) && canChangeRole(myRole, m.role, null) && (
                  <button
                    type="button"
                    className="btn btn-ghost p-2 text-slate-400 hover:text-red-600"
                    aria-label={`Remove ${m.email}`}
                    disabled={busy !== null}
                    onClick={() => {
                      if (confirm(`Remove ${m.email} from ${session.organization.name}? They lose access immediately.`)) void run(`rm-${m.userId}`, async () => setMembers(await api.removeMember(m.userId)));
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card" aria-labelledby="invite-heading">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 id="invite-heading" className="text-lg font-semibold">Invite someone</h2>
          <p className="text-sm text-slate-500">Creates a single-use link for one email address. Send it to them yourself; it expires in a few days.</p>
        </div>
        <form onSubmit={invite} className="flex flex-wrap items-end gap-3 px-5 py-4">
          <label className="min-w-56 flex-1">
            <span className="label">Email address</span>
            <input className="input" type="email" required placeholder="colleague@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label>
            <span className="label">Role</span>
            <select className="input w-44" value={role} onChange={(e) => setRole(e.target.value as Exclude<OrgRole, "owner">)}>
              {invitableRoles(myRole).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn btn-dark" disabled={busy !== null}>
            {busy === "invite" ? <Spinner className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />} Create invitation
          </button>
        </form>
        <p className="px-5 pb-4 text-xs text-slate-500">{ROLE_HELP[role]}</p>

        {created && (
          <div className="mx-5 mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4" role="status">
            <p className="text-sm font-medium text-emerald-900">Invitation for {created.invitation.email} created. Copy the link now: it is shown only once.</p>
            <div className="mt-2 flex items-center gap-2">
              <input className="input flex-1 font-mono text-xs" readOnly value={created.url} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn btn-outline" onClick={() => void copyLink(created.url)}>
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {invitations.length > 0 && (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {invitations.slice(0, 20).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate">{i.email}</span>
                <span className="text-xs text-slate-500">{ROLE_LABEL[i.role]}</span>
                <Badge tone={i.status === "pending" ? "amber" : i.status === "accepted" ? "green" : "slate"}>{i.status}</Badge>
                {i.status === "pending" && (
                  <button
                    type="button"
                    className="btn btn-ghost px-2 py-1 text-xs"
                    disabled={busy !== null}
                    onClick={() => void run(`revoke-${i.id}`, async () => (await api.revokeInvitation(i.id), setInvitations(await api.listInvitations())))}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {pending.length === 0 && invitations.length === 0 && <p className="border-t border-slate-100 px-5 py-4 text-sm text-slate-500">No invitations yet.</p>}
      </section>
    </div>
  );
}
