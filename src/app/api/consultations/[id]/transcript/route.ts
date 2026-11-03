import { NextResponse } from "next/server";
import type { TranscriptDTO } from "@/lib/consultations";
import { consultationRoute } from "@/server/consultations/api";
import { ConsultationError } from "@/server/consultations/errors";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** The original transcript of this doctor's consultation, exactly as the speech service returned it. Reading it is written to the audit log. */
export const GET = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("GET /api/consultations/[id]/transcript", tenant, request, id, ({ services, audit }) => {
    const transcript = services.consultations.latestTranscript(id);
    if (!transcript) throw new ConsultationError(404, "no_transcript", "There is no transcript for this consultation yet.");
    audit("consultation.transcript.view", id, { version: transcript.version });
    const body: TranscriptDTO = { consultationId: id, version: transcript.version, provider: transcript.provider, model: transcript.model, createdAt: transcript.createdAt, content: transcript.content };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  });
});
