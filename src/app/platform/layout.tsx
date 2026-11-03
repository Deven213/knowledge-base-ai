import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { requireSession } from "@/server/auth/service";

/**
 * The Super Admin's customer console. The check here is authoritative for the page (the proxy only checks
 * that a session exists); everyone else gets the same "not found" as for a page that doesn't exist. The
 * data itself is protected separately: every /api/platform route requires the platform:admin permission.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (!session.isPlatformAdmin) notFound();
  return <AdminShell>{children}</AdminShell>;
}
