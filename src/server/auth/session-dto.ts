import "server-only";
import type Database from "better-sqlite3";
import type { SessionDTO } from "@/lib/types";
import { ORG_ACTIONS, roleCan } from "../authz/permissions";
import type { TenantContext } from "../tenant";
import { IdentityRepository } from "./identity";

/** What the browser is told about the signed-in caller (never a password hash, token or other person's data). */
export function sessionDto(db: Database.Database, tenant: TenantContext): SessionDTO {
  const identity = new IdentityRepository(db);
  const organizations = identity.activeOrganizationsOf(tenant.userId).map((o) => ({ id: o.orgId, name: o.name, slug: o.slug, role: o.role }));
  const current = organizations.find((o) => o.id === tenant.orgId) ?? { id: tenant.orgId, name: "", slug: "", role: tenant.role };
  return {
    user: { id: tenant.userId, email: tenant.userEmail, displayName: tenant.displayName, isPlatformAdmin: tenant.isPlatformAdmin },
    passwordChangeRequired: tenant.mustChangePassword,
    organization: current,
    organizations,
    permissions: [...ORG_ACTIONS.filter((a) => roleCan(tenant.role, a)), ...(tenant.isPlatformAdmin ? ["platform:admin"] : [])],
  };
}
