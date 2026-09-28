import { FeatureGate } from "@/components/features/FeatureGate";
import { requireSession } from "@/server/auth/service";

export const dynamic = "force-dynamic";

export default async function Layout({ children }: { children: React.ReactNode }) {
  await requireSession(); // signed-in users only (the proxy has already redirected others to /login)
  return <FeatureGate feature="chat">{children}</FeatureGate>;
}
