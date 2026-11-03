import { NextResponse } from "next/server";
import { UPLOAD_PART_BYTES } from "@/lib/consultations";
import { consultationRoute } from "@/server/consultations/api";
import { readBodyLimited } from "@/server/consultations/body";
import { ConsultationError } from "@/server/consultations/errors";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { id: string; n: string };

/** Receives one part of the recording as raw bytes. The same part may be sent again (a retry) without harm. */
export const PUT = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id, n } = await ctx.params;
  return consultationRoute("PUT /api/consultations/[id]/recording/parts/[n]", tenant, request, id, async ({ services }) => {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > UPLOAD_PART_BYTES) throw new ConsultationError(413, "part_too_large", "That part is larger than allowed.");
    // The size is enforced on what actually arrives, not on the declared length (a chunked request declares none).
    const bytes = await readBodyLimited(request, UPLOAD_PART_BYTES);
    const number = /^\d{1,6}$/.test(n) ? Number(n) : NaN;
    const result = await services.recordings.putPart(id, number, bytes);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  });
});
