import { IdentityRepository } from "@/server/auth/identity";
import { requireSession } from "@/server/auth/service";
import { roleCan } from "@/server/authz/permissions";
import { getDb } from "@/server/db/client";
import { AdminSidebar } from "./AdminSidebar";

const ROLE_LABEL = { owner: "Owner", admin: "Administrator", member: "Member", doctor: "Doctor", viewer: "Viewer" } as const;

/** Sidebar + content frame shared by the admin and settings areas. Signed-in users only. */
export async function AdminShell({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const identity = new IdentityRepository(getDb());
  const organizations = identity.activeOrganizationsOf(session.userId);
  const workspace = {
    currentId: session.orgId,
    name: organizations.find((o) => o.orgId === session.orgId)?.name ?? "Workspace",
    roleLabel: ROLE_LABEL[session.role],
    all: organizations.map((o) => ({ id: o.orgId, name: o.name })),
    isPlatformAdmin: session.isPlatformAdmin,
    canConsult: roleCan(session.role, "consultations:use"),
  };
  return (
    <div className="min-h-screen lg:flex">
      <AdminSidebar userEmail={session.email} workspace={workspace} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
