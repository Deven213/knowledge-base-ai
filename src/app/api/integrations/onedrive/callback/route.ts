import { callbackHandler } from "@/server/integrations/oauth-routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OAuth redirect URI: validates the state, exchanges the code and stores the tokens encrypted. */
export const GET = callbackHandler("onedrive");
