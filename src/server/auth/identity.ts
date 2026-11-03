import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Role } from "../db/constants";

// Who people are and which organizations they belong to. These tables are the identity layer itself,
// so they are not scoped by organization; everything customers own is (see db/repositories.ts).

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  is_platform_admin: number;
  status: "active" | "disabled";
  created_at: string;
  last_login_at: string | null;
  /** 1 while the account only has a temporary password that must be replaced before anything else is allowed. */
  must_change_password: number;
  /** When the temporary password stops working (set exactly while must_change_password = 1). */
  temp_password_expires_at: string | null;
  password_changed_at: string | null;
}

/** Where an account stands with its password. */
export type CredentialStatus = "set" | "temporary" | "expired";

/** A temporary password that was handed over and not yet replaced is 'temporary'; once past its expiry (or revoked) it is 'expired'. */
export function credentialStatus(user: Pick<UserRow, "must_change_password" | "temp_password_expires_at">, nowMs: number = Date.now()): CredentialStatus {
  if (user.must_change_password !== 1) return "set";
  return user.temp_password_expires_at !== null && Date.parse(user.temp_password_expires_at) > nowMs ? "temporary" : "expired";
}

export type OrganizationStatus = "active" | "suspended";

export interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  /** A suspended workspace can't be signed in to; its data is kept. */
  status: OrganizationStatus;
  created_at: string;
}

export interface MembershipRow {
  org_id: string;
  user_id: string;
  role: Role;
  created_at: string;
}

/** An organization a user belongs to, with their role in it. */
export interface UserOrganization {
  orgId: string;
  name: string;
  slug: string;
  role: Role;
  status: OrganizationStatus;
}

/** A member of one organization (what an administrator sees on the Team page). */
export interface MemberView {
  userId: string;
  email: string;
  displayName: string | null;
  role: Role;
  status: "active" | "disabled";
  joinedAt: string;
}

/** Removing or demoting this person would leave the organization without an owner. */
export class LastOwnerError extends Error {
  constructor() {
    super("An organization must keep at least one owner. Make someone else an owner first.");
    this.name = "LastOwnerError";
  }
}

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function slugify(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return base || "workspace";
}

export class IdentityRepository {
  constructor(private readonly db: Database.Database) {}

  // ── Users ──

  /** `temporaryUntil` makes the password a temporary one that must be replaced at the first sign-in and stops working at that time. */
  createUser(input: { email: string; passwordHash: string; displayName?: string | null; isPlatformAdmin?: boolean; temporaryUntil?: string }): UserRow {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO users (id, email, password_hash, display_name, is_platform_admin, must_change_password, temp_password_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, normalizeEmail(input.email), input.passwordHash, input.displayName?.trim() || null, input.isPlatformAdmin ? 1 : 0, input.temporaryUntil ? 1 : 0, input.temporaryUntil ?? null);
    return this.findUserById(id)!;
  }

  findUserByEmail(email: string): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(normalizeEmail(email)) as UserRow | undefined;
  }

  findUserById(id: string): UserRow | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  }

  setPasswordHash(userId: string, passwordHash: string): void {
    this.db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, userId);
  }

  /**
   * The person chose their own password. The previous hash (a temporary password, if that is what it was) is
   * overwritten, so the old password stops working at once, and the "must change" state ends.
   */
  setOwnPassword(userId: string, passwordHash: string, changedAt: string): void {
    this.db
      .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, password_changed_at = ? WHERE id = ?`)
      .run(passwordHash, changedAt, userId);
  }

  /** Gives an account a (new) temporary password and ends every session it had. The caller is the Super Admin, never the account itself. */
  setTemporaryPassword(userId: string, passwordHash: string, expiresAt: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, temp_password_expires_at = ?, password_changed_at = NULL WHERE id = ?`).run(passwordHash, expiresAt, userId);
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
    })();
  }

  /** Makes a still-unreplaced temporary password stop working right now and ends the account's sessions. */
  expireTemporaryPassword(userId: string, at: string): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE users SET temp_password_expires_at = ? WHERE id = ? AND must_change_password = 1`).run(at, userId).changes > 0;
      if (changed) this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
      return changed;
    })();
  }

  setPlatformAdmin(userId: string, value: boolean): void {
    this.db.prepare(`UPDATE users SET is_platform_admin = ? WHERE id = ?`).run(value ? 1 : 0, userId);
  }

  touchLogin(userId: string): void {
    this.db.prepare(`UPDATE users SET last_login_at = ${NOW} WHERE id = ?`).run(userId);
  }

  // ── Organizations ──

  createOrganization(name: string, id: string = randomUUID()): OrganizationRow {
    const base = slugify(name);
    const taken = this.db.prepare(`SELECT 1 FROM organizations WHERE slug = ?`);
    let slug = base;
    for (let n = 2; taken.get(slug); n++) slug = `${base}-${n}`;
    this.db.prepare(`INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)`).run(id, name.trim(), slug);
    return this.getOrganization(id)!;
  }

  getOrganization(id: string): OrganizationRow | undefined {
    return this.db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(id) as OrganizationRow | undefined;
  }

  getOrganizationBySlug(slug: string): OrganizationRow | undefined {
    return this.db.prepare(`SELECT * FROM organizations WHERE slug = ?`).get(slug) as OrganizationRow | undefined;
  }

  /** Suspends or reactivates a workspace. Suspending also ends every session inside it, so access stops at once. */
  setOrganizationStatus(orgId: string, status: OrganizationStatus): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE organizations SET status = ? WHERE id = ?`).run(status, orgId).changes > 0;
      if (changed && status === "suspended") this.db.prepare(`DELETE FROM auth_sessions WHERE org_id = ?`).run(orgId);
      return changed;
    })();
  }

  /** Disables or re-enables an account everywhere. Disabling also ends all of the person's sessions. */
  setUserStatus(userId: string, status: "active" | "disabled"): boolean {
    return this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE users SET status = ? WHERE id = ?`).run(status, userId).changes > 0;
      if (changed && status === "disabled") this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`).run(userId);
      return changed;
    })();
  }

  // ── Memberships ──

  /** Every organization a user belongs to, including suspended ones (see activeOrganizationsOf for the ones they can use). */
  organizationsOf(userId: string): UserOrganization[] {
    return (
      this.db
        .prepare(
          `SELECT o.id AS orgId, o.name, o.slug, m.role, o.status
           FROM memberships m JOIN organizations o ON o.id = m.org_id
           WHERE m.user_id = ? ORDER BY m.created_at, o.name`,
        )
        .all(userId) as UserOrganization[]
    );
  }

  /** The organizations a user can currently work in: suspended workspaces are left out. */
  activeOrganizationsOf(userId: string): UserOrganization[] {
    return this.organizationsOf(userId).filter((o) => o.status === "active");
  }

  getMembership(orgId: string, userId: string): MembershipRow | undefined {
    return this.db.prepare(`SELECT * FROM memberships WHERE org_id = ? AND user_id = ?`).get(orgId, userId) as MembershipRow | undefined;
  }

  addMember(orgId: string, userId: string, role: Role): void {
    this.db.prepare(`INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)`).run(orgId, userId, role);
  }

  listMembers(orgId: string): MemberView[] {
    return (
      this.db
        .prepare(
          `SELECT u.id AS userId, u.email, u.display_name AS displayName, m.role, u.status, m.created_at AS joinedAt
           FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = ? ORDER BY m.created_at, u.email`,
        )
        .all(orgId) as MemberView[]
    );
  }

  ownerCount(orgId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner'`).get(orgId) as { n: number }).n;
  }

  /** Changes someone's role. Throws LastOwnerError rather than leave the organization without an owner. */
  changeRole(orgId: string, userId: string, role: Role): boolean {
    return this.db.transaction(() => {
      const current = this.getMembership(orgId, userId);
      if (!current) return false;
      if (current.role === "owner" && role !== "owner" && this.ownerCount(orgId) <= 1) throw new LastOwnerError();
      this.db.prepare(`UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`).run(role, orgId, userId);
      return true;
    })();
  }

  /** Removes someone from the organization and ends their sessions in it. */
  removeMember(orgId: string, userId: string): boolean {
    return this.db.transaction(() => {
      const current = this.getMembership(orgId, userId);
      if (!current) return false;
      if (current.role === "owner" && this.ownerCount(orgId) <= 1) throw new LastOwnerError();
      this.db.prepare(`DELETE FROM memberships WHERE org_id = ? AND user_id = ?`).run(orgId, userId);
      this.db.prepare(`DELETE FROM auth_sessions WHERE user_id = ? AND org_id = ?`).run(userId, orgId);
      return true;
    })();
  }
}
