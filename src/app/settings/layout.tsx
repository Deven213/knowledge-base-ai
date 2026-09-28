import { AdminShell } from "@/components/admin/AdminShell";

// Settings are not feature-managed: always reachable, so features can always be turned back on.
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
