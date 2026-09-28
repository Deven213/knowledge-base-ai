import { redirect } from "next/navigation";
import { requireSession } from "@/server/auth/service";
import { getFeatureAvailability } from "@/server/features/service";

export const dynamic = "force-dynamic";

// Entry point of the product: the Dashboard, or if that is disabled the first available main screen.
export default async function AppHome() {
  await requireSession();
  const available = getFeatureAvailability();
  if (available.dashboard) redirect("/admin");
  if (available.chat) redirect("/chat");
  if (available.documents) redirect("/admin/documents");
  redirect("/settings/features");
}
