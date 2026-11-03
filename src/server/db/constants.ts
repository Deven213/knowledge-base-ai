/**
 * The workspace that adopts all data created before organizations existed (migration 10). It has no
 * members until the bootstrap owner is created at startup (server/auth/bootstrap.ts).
 */
export const LEGACY_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const LEGACY_ORG_NAME = "Default workspace";
export const LEGACY_ORG_SLUG = "default";

export const ROLES = ["owner", "admin", "member", "doctor", "viewer"] as const;
export type Role = (typeof ROLES)[number];
