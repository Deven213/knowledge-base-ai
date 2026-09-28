import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, rejectCrossSite, zodMessage } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ url: z.string().trim().min(1, "Enter a website URL").max(2000) }).strict();

/** Checks that a website can be crawled (safe URL, reachable, readable) without importing anything. */
export async function POST(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    return NextResponse.json({ result: await getServices().integrations.testWebsite(parsed.data.url) });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/website/test", err);
  }
}
