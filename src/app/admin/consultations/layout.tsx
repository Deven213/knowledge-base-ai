import { FeatureGate } from "@/components/features/FeatureGate";
import { NotADoctor } from "@/components/consultations/NotADoctor";
import { requireSession } from "@/server/auth/service";
import { roleCan } from "@/server/authz/permissions";

export const dynamic = "force-dynamic";

/**
 * Doctor consultations are health information, so the page itself is closed to everyone but a doctor (the API refuses them too: this only
 * saves them a screen that can't work), and to everyone while the platform administrator has the feature switched off.
 */
export default async function Layout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  return <FeatureGate feature="consultations">{roleCan(session.role, "consultations:use") ? children : <NotADoctor />}</FeatureGate>;
}
