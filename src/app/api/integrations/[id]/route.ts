import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, zodMessage } from "@/server/http";
import { integrationErrorResponse, requireSyncIntegrations } from "@/server/integrations/http";
import { getTenantServices } from "@/server/services";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z
  .object({ enabled: z.boolean().optional(), configuration: z.record(z.string(), z.unknown()).optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.configuration !== undefined, "Nothing to update");

/** Turn an integration on/off (non-destructive) and/or change its configuration. */
export const PATCH = withTenant<{ id: string }>("integrations:manage", async (request, tenant, ctx) => {
  const off = requireSyncIntegrations();
  if (off) return off;
  try {
    const parsed = patchSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { id } = await ctx.params;
    return NextResponse.json({ integration: getTenantServices(tenant).integrations.update(id, parsed.data) });
  } catch (err) {
    return integrationErrorResponse("PATCH /api/integrations/[id]", err);
  }
});
