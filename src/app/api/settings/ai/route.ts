import { NextResponse } from "next/server";
import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/types";
import { internalError, jsonError, rejectCrossSite, requireFeature, zodMessage } from "@/server/http";
import { getServices } from "@/server/services";

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

export async function GET() {
  try {
    return NextResponse.json(getServices().providerConfig.overview());
  } catch (err) {
    return internalError("GET /api/settings/ai", err);
  }
}

export async function PUT(request: Request) {
  const crossSite = rejectCrossSite(request);
  if (crossSite) return crossSite;
  const featureOff = requireFeature("ai_model_settings");
  if (featureOff) return featureOff;
  try {
    const parsed = updateSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    const { providerConfig } = getServices();
    for (const [provider, model] of Object.entries(parsed.data.models ?? {})) {
      providerConfig.saveModel(provider as (typeof PROVIDER_IDS)[number], model || null);
    }
    if (parsed.data.activeProvider) providerConfig.setActiveProvider(parsed.data.activeProvider);

    return NextResponse.json(providerConfig.overview());
  } catch (err) {
    return internalError("PUT /api/settings/ai", err);
  }
}
