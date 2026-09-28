import { requireSession } from "@/server/auth/service";
import { AdminSidebar } from "./AdminSidebar";

/** Sidebar + content frame shared by the admin and settings areas. Signed-in users only. */
export async function AdminShell({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return (
    <div className="min-h-screen lg:flex">
      <AdminSidebar userEmail={session.email} />
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
