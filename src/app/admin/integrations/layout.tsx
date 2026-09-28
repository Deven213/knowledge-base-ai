import { FeatureGate } from "@/components/features/FeatureGate";

export const dynamic = "force-dynamic";

/** The whole Integrations area requires sync_integrations (and, through it, the Knowledge Base). */
export default function Layout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="sync_integrations">{children}</FeatureGate>;
}
