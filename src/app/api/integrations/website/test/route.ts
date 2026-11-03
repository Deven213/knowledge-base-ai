import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, zodMessage } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ url: z.string().trim().min(1, "Enter a website URL").max(2000) }).strict();

/** Checks that a website can be crawled (safe URL, reachable, readable) without importing anything. */
export const POST = withTenant("integrations:manage", async (request, tenant) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    return NextResponse.json({ result: await getTenantServices(tenant).integrations.testWebsite(parsed.data.url) });
  } catch (err) {
    return integrationErrorResponse("POST /api/integrations/website/test", err);
  }
});
