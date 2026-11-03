import { ROLES, type Role } from "../db/constants";

export { ROLES };
export type { Role };

// What each role may do inside its own organization. This is the single source of truth: routes
// declare the action they need and the check happens in one place (server/tenant.ts: withTenant).

export const ORG_ACTIONS = [
  "chat", // ask questions, and manage your own conversations
  "documents:read",
  "documents:write", // upload documents, "add to knowledge base"
  "documents:delete",
  "integrations:manage", // configure, connect and sync website / Drive / OneDrive
  "members:manage", // invite people, change roles, remove people
  // Record doctor-patient consultations and read, edit and approve the notes of the ones you recorded. Held by the Doctor
  // role ONLY, on purpose: health information is limited to the clinician who recorded it, so owners and administrators
  // can run a workspace without being able to open a patient's recording, transcript or note.
  "consultations:use",
] as const;
export type OrgAction = (typeof ORG_ACTIONS)[number];

/** Platform-wide settings (feature flags, the global AI provider) affect every customer, so no organization role grants them. */
export type Action = OrgAction | "platform:admin";

const GRANTS: Record<Role, readonly OrgAction[]> = {
  viewer: ["chat", "documents:read"],
  member: ["chat", "documents:read", "documents:write"],
  doctor: ["chat", "documents:read", "consultations:use"],
  admin: ["chat", "documents:read", "documents:write", "documents:delete", "integrations:manage", "members:manage"],
  owner: ["chat", "documents:read", "documents:write", "documents:delete", "integrations:manage", "members:manage"],
};

export function roleCan(role: Role, action: OrgAction): boolean {
  return GRANTS[role].includes(action);
}

/** Higher number = more authority. */
export const ROLE_RANK: Record<Role, number> = { viewer: 1, member: 2, doctor: 2, admin: 3, owner: 4 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Whether `actor` may give `target` the role `next` (or remove them when `next` is null).
 * - Only people who can manage members may do it at all.
 * - Nobody can grant a role above their own, and only an owner can create or change an owner.
 * - An admin can't change another admin or an owner; an owner can change anyone.
 */
export function canChangeRole(actor: Role, current: Role | null, next: Role | null): boolean {
  if (!roleCan(actor, "members:manage")) return false;
  if (next === "owner" && actor !== "owner") return false;
  if (current === "owner" && actor !== "owner") return false;
  if (current !== null && actor !== "owner" && ROLE_RANK[current] >= ROLE_RANK[actor]) return false;
  if (next !== null && ROLE_RANK[next] > ROLE_RANK[actor]) return false;
  return true;
}

/** Roles an invitation may grant: never 'owner', and never above the inviter's own role. */
export function invitableRoles(actor: Role): Role[] {
  if (!roleCan(actor, "members:manage")) return [];
  return (["admin", "member", "doctor", "viewer"] as const).filter((r) => ROLE_RANK[r] <= ROLE_RANK[actor]);
}
