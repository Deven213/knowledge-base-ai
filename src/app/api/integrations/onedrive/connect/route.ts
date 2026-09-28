import { connectHandler } from "@/server/integrations/oauth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Redirects to the provider's sign-in page (server-side OAuth; no secrets reach the browser). */
export const GET = connectHandler("onedrive");
