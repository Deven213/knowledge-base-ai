import { NextResponse } from "next/server";
import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/types";
import type { AISettingsDTO } from "@/lib/types";
import { internalError, jsonError, requireFeature, zodMessage } from "@/server/http";
import { getPlatformServices } from "@/server/services";
import { withTenant, type TenantContext } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// API keys are deliberately not accepted here: they are configured only in .env.
const modelId = z
  .string()
  .trim()
  .max(200, "Model ID is too long")
  .regex(/^[\w.:/@-]*$/, "Model ID contains invalid characters")
  .nullable();

const updateSchema = z
  .object({
    activeProvider: z.enum(PROVIDER_IDS).optional(),
    // null or "" clears the UI override so the .env value applies.
    models: z.partialRecord(z.enum(PROVIDER_IDS), modelId).optional(),
  })
  .strict()
  .refine((b) => b.activeProvider !== undefined || b.models !== undefined, "Nothing to update");

/** What the platform's AI keys look like to this caller: only a platform administrator sees any part of a key. */
function visibleTo(tenant: TenantContext, overview: AISettingsDTO): AISettingsDTO {
  if (tenant.isPlatformAdmin) return overview;
  return { ...overview, providers: overview.providers.map((p) => ({ ...p, key: { ...p.key, last4: null } })) };
}

/** Readable by any signed-in member (the chat needs the active model and its image support). */
export const GET = withTenant(null, async (_request, tenant) => {
  try {
    return NextResponse.json(visibleTo(tenant, getPlatformServices().providerConfig.overview()));
  } catch (err) {
    return internalError("GET /api/settings/ai", err);
  }
});

/** The AI provider and models are platform-wide (they serve every customer), so only a platform administrator may change them. */
export const PUT = withTenant("platform:admin", async (request, tenant) => {
  const featureOff = requireFeature("ai_model_settings");
  if (featureOff) return featureOff;
  try {
    const parsed = updateSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    const { providerConfig } = getPlatformServices();
    for (const [provider, model] of Object.entries(parsed.data.models ?? {})) {
      providerConfig.saveModel(provider as (typeof PROVIDER_IDS)[number], model || null);
    }
    if (parsed.data.activeProvider) providerConfig.setActiveProvider(parsed.data.activeProvider);

    return NextResponse.json(visibleTo(tenant, providerConfig.overview()));
  } catch (err) {
    return internalError("PUT /api/settings/ai", err);
  }
});
