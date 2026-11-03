import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Role } from "../db/constants";
import { IdentityRepository, normalizeEmail } from "./identity";

// Single-use invitation links. The link carries a random token; only its SHA-256 hash is stored, so a
// database leak doesn't leak working links. An invitation is bound to one email address and one
// organization and expires. An ordinary invitation can never grant 'owner'. Invitations flagged grants_owner (the
// earlier Customer Admin onboarding, issued only by a platform administrator: a DB trigger enforces that) can no
// longer be created, but links already issued keep working until they are used, withdrawn or expire. New customers
// are onboarded with a temporary password instead (see platform/service.ts).

export type InvitableRole = Exclude<Role, "owner">;
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface InvitationView {
  id: string;
  email: string;
  /** The role the person will get: 'owner' for a Customer Admin invitation. */
  role: Role;
  status: InvitationStatus;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const isWellFormedInviteToken = (token: unknown): token is string => typeof token === "string" && TOKEN_PATTERN.test(token);

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

/** One organization's invitations. Scoped: it can't see or change another organization's. */
export class InvitationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly orgId: string,
  ) {}

  /** Creates an invitation (replacing an earlier pending one for the same email). The token is returned once and never stored. */
  create(email: string, role: InvitableRole, invitedBy: string, ttlHours: number): { id: string; token: string; expiresAt: string } {
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE invitations SET revoked_at = ${NOW} WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
        .run(this.orgId, normalizeEmail(email));
      this.db
        .prepare(`INSERT INTO invitations (id, org_id, email, role, token_hash, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, this.orgId, normalizeEmail(email), role, hashInviteToken(token), invitedBy, expiresAt);
    })();
    return { id, token, expiresAt };
  }

  list(): InvitationView[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.email, CASE WHEN i.grants_owner = 1 THEN 'owner' ELSE i.role END AS role, i.expires_at AS expiresAt, i.created_at AS createdAt, i.accepted_at AS acceptedAt,
                i.revoked_at AS revokedAt, u.email AS invitedBy
         FROM invitations i JOIN users u ON u.id = i.invited_by
         WHERE i.org_id = ? ORDER BY i.created_at DESC LIMIT 200`,
      )
      .all(this.orgId) as (Omit<InvitationView, "status"> & { acceptedAt: string | null; revokedAt: string | null })[];
    const now = new Date().toISOString();
    return rows.map(({ acceptedAt, revokedAt, ...r }) => ({
      ...r,
      status: acceptedAt ? "accepted" : revokedAt ? "revoked" : r.expiresAt <= now ? "expired" : "pending",
    }));
  }

  /** Withdraws a pending invitation of this organization. */
  revoke(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE invitations SET revoked_at = ${NOW} WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`)
        .run(id, this.orgId).changes > 0
    );
  }
}

export interface PendingInvitation {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  /** The role the person will get: 'owner' for a Customer Admin invitation. */
  role: Role;
}

/** The invitation behind a link, if it is still valid and its workspace isn't suspended. The token itself is the capability, so this is not organization-scoped. */
export function findPendingInvitation(db: Database.Database, token: unknown): PendingInvitation | undefined {
  if (!isWellFormedInviteToken(token)) return undefined;
  return db
    .prepare(
      `SELECT i.id, i.org_id AS orgId, o.name AS orgName, i.email, CASE WHEN i.grants_owner = 1 THEN 'owner' ELSE i.role END AS role
       FROM invitations i JOIN organizations o ON o.id = i.org_id AND o.status = 'active'
       WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ${NOW}`,
    )
    .get(hashInviteToken(token)) as PendingInvitation | undefined;
}

export type AcceptResult =
  | { ok: true; userId: string; orgId: string; createdAccount: boolean }
  | { ok: false; reason: "invalid" | "email_mismatch" | "account_exists" | "already_member" };

/**
 * Accepts an invitation, atomically: the membership is created and the invitation is used up together.
 * - A new person (no account for the invited email) supplies a password hash and gets an account.
 * - An existing account must be the one signed in, and its email must match the invitation.
 */
export function acceptInvitation(
  db: Database.Database,
  token: unknown,
  who: { existingUserId: string } | { newUser: { passwordHash: string; displayName?: string | null } },
): AcceptResult {
  const identity = new IdentityRepository(db);
  return db.transaction((): AcceptResult => {
    const invitation = findPendingInvitation(db, token);
    if (!invitation) return { ok: false, reason: "invalid" };

    const existing = identity.findUserByEmail(invitation.email);
    let userId: string;
    let createdAccount = false;
    if ("existingUserId" in who) {
      if (!existing || existing.id !== who.existingUserId) return { ok: false, reason: "email_mismatch" };
      userId = existing.id;
    } else {
      if (existing) return { ok: false, reason: "account_exists" };
      userId = identity.createUser({ email: invitation.email, passwordHash: who.newUser.passwordHash, displayName: who.newUser.displayName }).id;
      createdAccount = true;
    }

    if (identity.getMembership(invitation.orgId, userId)) return { ok: false, reason: "already_member" };
    identity.addMember(invitation.orgId, userId, invitation.role);
    db.prepare(`UPDATE invitations SET accepted_at = ${NOW} WHERE id = ?`).run(invitation.id);
    return { ok: true, userId, orgId: invitation.orgId, createdAccount };
  })();
}
