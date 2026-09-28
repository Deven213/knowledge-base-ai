import { notFound } from "next/navigation";
import { ComingSoon } from "@/components/admin/ComingSoon";
import { sectionBySlug } from "@/components/admin/nav";
import { FeatureGate } from "@/components/features/FeatureGate";

// Built sections (documents, ai-models) have their own folders, which take precedence over this route.
// Rendered per request so the feature flag is checked on the server every time.
export const dynamic = "force-dynamic";

export default async function RoadmapSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section: slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.status !== "soon") notFound();
  return (
    <FeatureGate feature={section.feature}>
      <ComingSoon slug={slug} />
    </FeatureGate>
  );
}
