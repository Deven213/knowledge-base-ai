import { redirect } from "next/navigation";

/** The old combined page: Website Scraper, Google Drive and OneDrive now have their own pages. */
export default function SyncIntegrationsRedirect() {
  redirect("/admin/integrations");
}
