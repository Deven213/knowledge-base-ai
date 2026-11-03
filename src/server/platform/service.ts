import "server-only";
import type Database from "better-sqlite3";
import { AuditLog, AuditReader, type AuditActor, type AuditEntry } from "../audit/audit";
import { credentialStatus, IdentityRepository, normalizeEmail, type CredentialStatus, type OrganizationStatus } from "../auth/identity";
import { InvitationRepository, type InvitationView } from "../auth/invitations";
import { hashPassword } from "../auth/password";
import { generateTemporaryPassword } from "../auth/temporary-password";
import type { Role } from "../db/constants";
import { splitAccounts, storedObjectKeys, summarizeTenantData, workInProgress, type TenantDataSummary } from "../db/tenant-erasure";

// What a Super Admin (platform administrator) may do to customers: see every workspace, create one together
// with its first Customer Admin, suspend or reactivate it, add a Customer Admin, hand out or withdraw a temporary
// password, and disable or re-enable an account.
//
// Onboarding is by TEMPORARY PASSWORD: creating a customer creates the workspace, the Customer Admin's account
// (role owner) and a random temporary password, which is returned ONCE to the Super Admin and stored only as a
// scrypt hash. The Super Admin passes it on; at the first sign-in the customer is forced (server-side, see
// tenant.ts / proxy.ts) to replace it, which overwrites the hash. A temporary password also expires.
//
// Hard boundary: this file only reads the IDENTITY tables (organizations, users, memberships, invitations).
// It never touches documents, chunks, conversations or integrations, so even a platform administrator sees
// customer metadata and counts, never customer content (tests/tenant-guards checks this statically).
//
// Every method writes its audit record in the same transaction as the change it describes: if the audit
// write fails, the change is rolled back. Reads are audited too, because looking at customers is sensitive.
// The audit records never contain a password.

export class PlatformError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export interface PlatformContext {
  actor: AuditActor;
  ip: string | null;
}

/** Whether the workspace has a Customer Admin who has chosen their own password yet. */
export type ActivationStatus = "activated" | "pending" | "expired" | "none";

export interface PlatformOrganization {
  id: string;
  name: string;
  slug: string;
  /** The Super Admin's own label for the customer. Metadata only: it is never a way to sign in. */
  reference: string | null;
  status: OrganizationStatus;
  createdAt: string;
  memberCount: number;
  ownerCount: number;
  /** Customer Admin invitation LINKS (the earlier onboarding) that are still unused. */
  pendingAdminInvites: number;
  /** "pending": waiting for the first sign-in with a temporary password; "expired": that password ran out or was revoked. */
  activation: { status: ActivationStatus; loginId: string | null; expiresAt: string | null };
  /** The most recent sign-in by any member (their last sign-in anywhere). */
  lastLoginAt: string | null;
}

export interface PlatformMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  userStatus: "active" | "disabled";
  lastLoginAt: string | null;
  joinedAt: string;
  isPlatformAdmin: boolean;
  /** "temporary": a temporary password is outstanding; "expired": it ran out or was revoked; "set": they chose their own. */
  credential: { status: CredentialStatus; expiresAt: string | null };
}

export interface PlatformOrganizationDetail {
  organization: PlatformOrganization;
  members: PlatformMember[];
  invitations: InvitationView[];
  /** How much the workspace holds (counts only), so a deletion can say what it would remove. */
  data: TenantDataSummary;
}

/** What a deletion removed (numbers only; the audit record carries the same). */
export interface DeletedCustomer {
  id: string;
  name: string;
  members: number;
  /** Accounts deleted with the workspace because they existed only for it. */
  accountsDeleted: number;
  /** Accounts that stay because deleting them would have touched another customer's data (they just lose access to this workspace). */
  accountsKept: number;
  data: TenantDataSummary;
  /** Storage folders to remove once the deletion has committed (server-side only: the route strips this before replying). */
  storedObjects: string[];
}

/** What the Super Admin passes on. `temporaryPassword` exists only in the response that created it. */
export interface IssuedCredentials {
  workspaceName: string;
  loginId: string;
  temporaryPassword: string;
  expiresAt: string;
}

export interface CreatedCustomer {
  organization: PlatformOrganization;
  /** Null when the request was a retry of one that already succeeded: the password can't be shown again. */
  credentials: IssuedCredentials | null;
  alreadyCreated: boolean;
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
const ADMIN_PENDING = `i.org_id = o.id AND i.grants_owner = 1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL`;
const OWNER = `m.org_id = o.id AND m.role = 'owner'`;

const ORGANIZATION_SELECT = `
  SELECT o.id, o.name, o.slug, o.customer_reference AS reference, o.status, o.created_at AS createdAt,
    (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS memberCount,
    (SELECT COUNT(*) FROM memberships m WHERE ${OWNER}) AS ownerCount,
    (SELECT COUNT(*) FROM invitations i WHERE ${ADMIN_PENDING} AND i.expires_at > ${NOW}) AS pendingAdminInvites,
    (SELECT COUNT(*) FROM invitations i WHERE ${ADMIN_PENDING} AND i.expires_at <= ${NOW}) AS expiredAdminInvites,
    (SELECT i.email FROM invitations i WHERE ${ADMIN_PENDING} ORDER BY i.created_at DESC LIMIT 1) AS inviteLoginId,
    (SELECT i.expires_at FROM invitations i WHERE ${ADMIN_PENDING} ORDER BY i.created_at DESC LIMIT 1) AS inviteExpiresAt,
    (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${OWNER} AND u.must_change_password = 0) AS ownersWithOwnPassword,
    (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${OWNER} AND u.must_change_password = 1 AND u.temp_password_expires_at > ${NOW}) AS ownersOnTemporary,
    (SELECT COUNT(*) FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${OWNER} AND u.must_change_password = 1 AND u.temp_password_expires_at <= ${NOW}) AS ownersExpired,
    (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${OWNER} AND u.must_change_password = 1 ORDER BY m.created_at DESC LIMIT 1) AS temporaryLoginId,
    (SELECT u.temp_password_expires_at FROM memberships m JOIN users u ON u.id = m.user_id WHERE ${OWNER} AND u.must_change_password = 1 ORDER BY m.created_at DESC LIMIT 1) AS temporaryExpiresAt,
    (SELECT MAX(u.last_login_at) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id) AS lastLoginAt
  FROM organizations o`;

interface OrganizationRow extends Omit<PlatformOrganization, "activation"> {
  expiredAdminInvites: number;
  inviteLoginId: string | null;
  inviteExpiresAt: string | null;
  ownersWithOwnPassword: number;
  ownersOnTemporary: number;
  ownersExpired: number;
  temporaryLoginId: string | null;
  temporaryExpiresAt: string | null;
}

function toOrganization(row: OrganizationRow): PlatformOrganization {
  const { expiredAdminInvites, inviteLoginId, inviteExpiresAt, ownersWithOwnPassword, ownersOnTemporary, ownersExpired, temporaryLoginId, temporaryExpiresAt, ...rest } = row;
  const status: ActivationStatus =
    ownersWithOwnPassword > 0
      ? "activated"
      : ownersOnTemporary > 0 || row.pendingAdminInvites > 0
        ? "pending"
        : ownersExpired > 0 || expiredAdminInvites > 0
          ? "expired"
          : "none";
  const waiting = status === "pending" || status === "expired";
  return {
    ...rest,
    activation: { status, loginId: waiting ? (temporaryLoginId ?? inviteLoginId) : null, expiresAt: waiting ? (temporaryExpiresAt ?? inviteExpiresAt) : null },
  };
}

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const DOUBLE_ACCOUNT = "An account with that email address already exists. Use a different email address for the new Customer Admin.";

export interface PlatformOptions {
  /** How long a temporary password works. */
  temporaryPasswordHours: number;
  /** Test seams: production uses scrypt, the system CSPRNG and the real clock. */
  hashPassword?: (password: string) => Promise<string>;
  generatePassword?: () => string;
  now?: () => number;
}

export class PlatformAdminService {
  private readonly identity: IdentityRepository;
  private readonly audit: AuditLog;
  private readonly hash: (password: string) => Promise<string>;
  private readonly generate: () => string;
  private readonly now: () => number;

  constructor(
    private readonly db: Database.Database,
    private readonly options: PlatformOptions,
  ) {
    this.identity = new IdentityRepository(db);
    this.audit = new AuditLog(db);
    this.hash = options.hashPassword ?? ((password) => hashPassword(password));
    this.generate = options.generatePassword ?? generateTemporaryPassword;
    this.now = options.now ?? Date.now;
  }

  private expiry(): string {
    return new Date(this.now() + this.options.temporaryPasswordHours * 3600_000).toISOString();
  }

  private organization(id: string): PlatformOrganization | undefined {
    const row = this.db.prepare(`${ORGANIZATION_SELECT} WHERE o.id = ?`).get(id) as OrganizationRow | undefined;
    return row && toOrganization(row);
  }

  private requireOrganization(id: string): PlatformOrganization {
    const org = this.organization(id);
    if (!org) throw new PlatformError(404, "Workspace not found.");
    return org;
  }

  private organizationByRequest(requestId: string): PlatformOrganization | undefined {
    const row = this.db.prepare(`SELECT id FROM organizations WHERE creation_request_id = ?`).get(requestId) as { id: string } | undefined;
    return row && this.organization(row.id);
  }

  /** Every customer workspace, newest first. Metadata and counts only. */
  listOrganizations(ctx: PlatformContext): PlatformOrganization[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare(`${ORGANIZATION_SELECT} ORDER BY o.created_at DESC, o.name`).all() as OrganizationRow[];
      const organizations = rows.map(toOrganization);
      this.audit.record({ actor: ctx.actor, action: "platform.organizations.list", ip: ctx.ip, details: { count: organizations.length } });
      return organizations;
    })();
  }

  /** One workspace with its people and invitations (no documents, chats or integrations). */
  getOrganization(ctx: PlatformContext, id: string): PlatformOrganizationDetail {
    return this.db.transaction(() => {
      const organization = this.requireOrganization(id);
      const rows = this.db
        .prepare(
          `SELECT u.id AS userId, u.email, u.display_name AS displayName, m.role, u.status AS userStatus,
                  u.last_login_at AS lastLoginAt, m.created_at AS joinedAt, u.is_platform_admin AS isPlatformAdmin,
                  u.must_change_password AS mustChange, u.temp_password_expires_at AS tempExpires
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = ? ORDER BY m.created_at, u.email`,
        )
        .all(id) as (Omit<PlatformMember, "isPlatformAdmin" | "credential"> & { isPlatformAdmin: number; mustChange: number; tempExpires: string | null })[];
      const members: PlatformMember[] = rows.map(({ isPlatformAdmin, mustChange, tempExpires, ...row }) => {
        const status = credentialStatus({ must_change_password: mustChange, temp_password_expires_at: tempExpires }, this.now());
        return { ...row, isPlatformAdmin: isPlatformAdmin === 1, credential: { status, expiresAt: status === "set" ? null : tempExpires } };
      });
      const invitations = new InvitationRepository(this.db, id).list();
      this.audit.record({ actor: ctx.actor, action: "platform.organization.view", targetOrgId: id, targetLabel: organization.name, ip: ctx.ip });
      return { organization, members, invitations, data: summarizeTenantData(this.db, id) };
    })();
  }

  /** The audit log, newest first. Reading it is itself recorded. */
  readAuditLog(ctx: PlatformContext, filters: { limit?: number; beforeId?: number; targetOrgId?: string; action?: string }): AuditEntry[] {
    return this.db.transaction(() => {
      const entries = new AuditReader(this.db).list(filters);
      // Recorded after reading, so a read shows up from the next one on (and still fails as a whole if it can't be recorded).
      this.audit.record({
        actor: ctx.actor,
        action: "platform.audit.view",
        ip: ctx.ip,
        details: { limit: filters.limit ?? null, workspace: filters.targetOrgId ?? null, action: filters.action ?? null },
      });
      return entries;
    })();
  }

  /**
   * Creates an isolated workspace, its Customer Admin (an account with the owner role) and a random temporary
   * password for them, all in one transaction. The password is returned here and nowhere else: only its hash is
   * stored. Safe to retry: a repeated `requestId` returns the customer that already exists (without any password,
   * which can no longer be shown), and the name / email / reference checks make a duplicate impossible anyway.
   */
  async createOrganization(ctx: PlatformContext, input: { name: string; adminEmail: string; reference?: string; requestId?: string }): Promise<CreatedCustomer> {
    const name = input.name.trim();
    const adminEmail = normalizeEmail(input.adminEmail);
    const reference = input.reference?.trim() || null;
    const requestId = input.requestId ?? null;

    const earlier = requestId ? this.organizationByRequest(requestId) : undefined;
    if (earlier) return { organization: earlier, credentials: null, alreadyCreated: true };

    if (name.length < 2 || name.length > 100) throw new PlatformError(400, "Give the workspace a name of 2 to 100 characters.");
    if (reference !== null && !REFERENCE_PATTERN.test(reference)) {
      throw new PlatformError(400, "A customer reference can use letters, numbers, dots, dashes and underscores (up to 40 characters).");
    }
    const temporaryPassword = this.generate();
    const passwordHash = await this.hash(temporaryPassword);

    return this.db.transaction((): CreatedCustomer => {
      // Checked again inside the transaction: a second request with the same key may have won while this one was hashing.
      const again = requestId ? this.organizationByRequest(requestId) : undefined;
      if (again) return { organization: again, credentials: null, alreadyCreated: true };

      if (this.db.prepare(`SELECT 1 FROM organizations WHERE lower(name) = lower(?)`).get(name)) {
        throw new PlatformError(409, "A workspace with that name already exists.");
      }
      if (reference !== null && this.db.prepare(`SELECT 1 FROM organizations WHERE lower(customer_reference) = lower(?)`).get(reference)) {
        throw new PlatformError(409, "That customer reference is already used by another workspace.");
      }
      if (this.identity.findUserByEmail(adminEmail)) throw new PlatformError(409, DOUBLE_ACCOUNT);

      const org = this.identity.createOrganization(name);
      this.db.prepare(`UPDATE organizations SET customer_reference = ?, creation_request_id = ? WHERE id = ?`).run(reference, requestId, org.id);
      const expiresAt = this.expiry();
      const user = this.identity.createUser({ email: adminEmail, passwordHash, temporaryUntil: expiresAt });
      this.identity.addMember(org.id, user.id, "owner");
      this.audit.record({
        actor: ctx.actor,
        action: "platform.organization.create",
        targetOrgId: org.id,
        targetUserId: user.id,
        targetLabel: org.name,
        ip: ctx.ip,
        details: { adminEmail, reference },
      });
      return { organization: this.requireOrganization(org.id), credentials: { workspaceName: org.name, loginId: adminEmail, temporaryPassword, expiresAt }, alreadyCreated: false };
    })();
  }

  /**
   * Suspends or reactivates a workspace. Suspending ends every session inside it at once; its data is kept.
   * Nobody can suspend the workspace they are currently signed in to (they would lock themselves out).
   */
  setOrganizationStatus(ctx: PlatformContext, id: string, status: OrganizationStatus): PlatformOrganization {
    return this.db.transaction(() => {
      const org = this.requireOrganization(id);
      if (org.status === status) return org;
      if (status === "suspended" && id === ctx.actor.orgId) {
        throw new PlatformError(409, "You are signed in to this workspace. Switch to another workspace before suspending it.");
      }
      this.identity.setOrganizationStatus(id, status);
      this.audit.record({
        actor: ctx.actor,
        action: status === "suspended" ? "platform.organization.suspend" : "platform.organization.reactivate",
        targetOrgId: id,
        targetLabel: org.name,
        ip: ctx.ip,
      });
      return this.requireOrganization(id);
    })();
  }

  /**
   * Permanently deletes a customer: the workspace and everything it owns, and the accounts that existed only for it.
   * One transaction: either all of it happens, with its audit record, or none of it does. The database removes the
   * workspace's rows through ON DELETE CASCADE (see db/tenant-erasure.ts), so no other customer's rows are touched.
   *
   * Refused (nothing changes) unless the caller typed the workspace's name, and never for: the workspace the caller is
   * signed in to, a workspace that contains a Super Admin account, or one with work still running.
   * Accounts are removed only if deleting them cannot reach another customer's data; the rest merely lose this workspace.
   * The audit history, platform settings and Super Admin accounts are never touched.
   */
  deleteOrganization(ctx: PlatformContext, id: string, confirmName: string): DeletedCustomer {
    return this.db.transaction((): DeletedCustomer => {
      const org = this.requireOrganization(id);
      if (confirmName.trim().toLowerCase() !== org.name.trim().toLowerCase()) {
        throw new PlatformError(400, "Type the workspace's name exactly to confirm that you want to delete it.");
      }
      if (id === ctx.actor.orgId) throw new PlatformError(409, "You are signed in to this workspace. Switch to another workspace before deleting it.");
      const superAdmin = this.db.prepare(`SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.is_platform_admin = 1 LIMIT 1`).get(id);
      if (superAdmin) throw new PlatformError(409, "This workspace contains a Super Admin account, so it can't be deleted from here.");
      const busy = workInProgress(this.db, id);
      if (busy) throw new PlatformError(409, busy);

      const data = summarizeTenantData(this.db, id);
      const storedObjects = storedObjectKeys(this.db, id);
      const memberIds = (this.db.prepare(`SELECT user_id AS id FROM memberships WHERE org_id = ?`).all(id) as { id: string }[]).map((r) => r.id);
      const accounts = splitAccounts(this.db, id, memberIds);
      const violationsBefore = (this.db.pragma("foreign_key_check") as unknown[]).length;

      this.db.prepare(`DELETE FROM organizations WHERE id = ?`).run(id); // everything the workspace owns goes with it (cascade)
      const deleteAccount = this.db.prepare(`DELETE FROM users WHERE id = ? AND is_platform_admin = 0`);
      for (const userId of accounts.remove) deleteAccount.run(userId);

      // Belt and braces: the deletion must not leave a dangling reference anywhere. If it did, everything is rolled back.
      if ((this.db.pragma("foreign_key_check") as unknown[]).length > violationsBefore) {
        throw new Error("Deleting a workspace left an inconsistent database state, so nothing was deleted.");
      }

      const result: DeletedCustomer = { id, name: org.name, members: memberIds.length, accountsDeleted: accounts.remove.length, accountsKept: accounts.keep.length, data, storedObjects };
      this.audit.record({
        actor: ctx.actor,
        action: "platform.organization.delete",
        targetOrgId: id, // the audit log has no foreign keys, so this record outlives the workspace
        targetLabel: org.name,
        ip: ctx.ip,
        details: { members: result.members, accountsDeleted: result.accountsDeleted, accountsKept: result.accountsKept, ...data },
      });
      return result;
    })();
  }

  /**
   * Adds another Customer Admin (an owner) to an existing workspace, with a temporary password returned once. An
   * email that already has an account is refused: attaching somebody's existing account to another customer's
   * workspace would be a cross-tenant mistake waiting to happen, and an existing account's password is never touched.
   */
  async addCustomerAdmin(ctx: PlatformContext, orgId: string, emailInput: string): Promise<IssuedCredentials> {
    const email = normalizeEmail(emailInput);
    this.requireOrganization(orgId); // fail early (and cheaply) for an unknown workspace
    const temporaryPassword = this.generate();
    const passwordHash = await this.hash(temporaryPassword);

    return this.db.transaction((): IssuedCredentials => {
      const org = this.requireOrganization(orgId);
      if (org.status !== "active") throw new PlatformError(409, "This workspace is suspended. Reactivate it before adding a Customer Admin.");
      const existing = this.identity.findUserByEmail(email);
      if (existing) {
        throw new PlatformError(409, this.identity.getMembership(orgId, existing.id) ? "That person is already a member of this workspace." : DOUBLE_ACCOUNT);
      }
      const expiresAt = this.expiry();
      const user = this.identity.createUser({ email, passwordHash, temporaryUntil: expiresAt });
      this.identity.addMember(orgId, user.id, "owner");
      this.audit.record({
        actor: ctx.actor,
        action: "platform.customer_admin.add",
        targetOrgId: orgId,
        targetUserId: user.id,
        targetLabel: org.name,
        ip: ctx.ip,
        details: { adminEmail: email },
      });
      return { workspaceName: org.name, loginId: email, temporaryPassword, expiresAt };
    })();
  }

  /** The member of a workspace whose temporary password is still unreplaced (the only accounts these actions may touch). */
  private temporaryMember(orgId: string, userId: string) {
    const org = this.requireOrganization(orgId);
    const user = this.identity.findUserById(userId);
    if (!user || !this.identity.getMembership(orgId, userId)) throw new PlatformError(404, "Person not found in this workspace.");
    if (user.is_platform_admin === 1) throw new PlatformError(409, "Platform administrators are managed outside this screen.");
    if (user.must_change_password !== 1) {
      throw new PlatformError(409, "This person has already chosen their own password, so their credentials can't be reissued or revoked from here.");
    }
    return { org, user };
  }

  /**
   * Gives a person who hasn't replaced their temporary password yet a NEW one (shown once): the earlier one stops working
   * and their sessions end. It is deliberately impossible for an account that has chosen its own password: that would let
   * a Super Admin sign in as a customer's user and read their private chats.
   */
  async reissueCredentials(ctx: PlatformContext, orgId: string, userId: string): Promise<IssuedCredentials> {
    this.temporaryMember(orgId, userId);
    const temporaryPassword = this.generate();
    const passwordHash = await this.hash(temporaryPassword);

    return this.db.transaction((): IssuedCredentials => {
      const { org, user } = this.temporaryMember(orgId, userId);
      if (org.status !== "active") throw new PlatformError(409, "This workspace is suspended. Reactivate it first.");
      const expiresAt = this.expiry();
      this.identity.setTemporaryPassword(user.id, passwordHash, expiresAt);
      this.audit.record({ actor: ctx.actor, action: "platform.credentials.reissue", targetOrgId: orgId, targetUserId: user.id, targetLabel: user.email, ip: ctx.ip });
      return { workspaceName: org.name, loginId: user.email, temporaryPassword, expiresAt };
    })();
  }

  /** Makes a temporary password that hasn't been replaced yet stop working immediately (sessions end too). The account stays; reissue to let them in. */
  revokeCredentials(ctx: PlatformContext, orgId: string, userId: string): { loginId: string } {
    return this.db.transaction(() => {
      const { user } = this.temporaryMember(orgId, userId);
      this.identity.expireTemporaryPassword(user.id, new Date(this.now()).toISOString());
      this.audit.record({ actor: ctx.actor, action: "platform.credentials.revoke", targetOrgId: orgId, targetUserId: user.id, targetLabel: user.email, ip: ctx.ip });
      return { loginId: user.email };
    })();
  }

  /** Withdraws a pending invitation LINK of one workspace (the earlier onboarding; existing links keep working until then). */
  revokeInvitation(ctx: PlatformContext, orgId: string, invitationId: string): void {
    this.db.transaction(() => {
      const org = this.requireOrganization(orgId);
      if (!new InvitationRepository(this.db, orgId).revoke(invitationId)) throw new PlatformError(404, "Invitation not found, or it was already used or withdrawn.");
      this.audit.record({
        actor: ctx.actor,
        action: "platform.invitation.revoke",
        targetOrgId: orgId,
        targetLabel: org.name,
        ip: ctx.ip,
        details: { invitationId },
      });
    })();
  }

  /**
   * Disables or re-enables an account everywhere (a disabled person is signed out at once and can't sign in).
   * You can't disable yourself, and platform administrators are managed outside this screen.
   */
  setUserStatus(ctx: PlatformContext, userId: string, status: "active" | "disabled"): { userId: string; email: string; status: "active" | "disabled" } {
    return this.db.transaction(() => {
      const user = this.identity.findUserById(userId);
      if (!user) throw new PlatformError(404, "Person not found.");
      if (user.id === ctx.actor.userId) throw new PlatformError(409, "You can't disable your own account.");
      if (user.is_platform_admin === 1) throw new PlatformError(409, "Platform administrators can't be disabled from here.");
      if (user.status !== status) {
        this.identity.setUserStatus(userId, status);
        this.audit.record({
          actor: ctx.actor,
          action: status === "disabled" ? "platform.user.disable" : "platform.user.enable",
          targetUserId: userId,
          targetLabel: user.email,
          ip: ctx.ip,
        });
      }
      return { userId, email: user.email, status };
    })();
  }
}
