import { FeatureGate } from "@/components/features/FeatureGate";

export const dynamic = "force-dynamic";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="ai_model_settings">{children}</FeatureGate>;
}
