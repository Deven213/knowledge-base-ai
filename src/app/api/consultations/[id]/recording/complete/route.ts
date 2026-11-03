import { NextResponse } from "next/server";
import { z } from "zod";
import { consultationRoute } from "@/server/consultations/api";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { id: string };

const bodySchema = z
  .object({
    totalBytes: z.number().int().positive(),
    partCount: z.number().int().positive(),
    durationMs: z.number().positive(),
    /** SHA-256 of the whole recording, computed in the browser; the server recomputes it and refuses a mismatch. */
    sha256: z.string().length(64),
  })
  .strict();

/**
 * Finishes the upload: the server checks every part is there and the whole recording is unaltered, keeps it, and queues the background
 * processing. This request never waits for transcription: it answers as soon as the recording is safely stored. Safe to repeat.
 */
export const POST = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("POST /api/consultations/[id]/recording/complete", tenant, request, id, async ({ services, gate, audit }) => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { alreadyStored, recording } = await services.recordings.complete(id, parsed.data);
    if (!alreadyStored) audit("consultation.recording.store", id, { sizeBytes: recording.size_bytes, durationMs: recording.duration_ms });
    return NextResponse.json({ consultation: services.consultations.detail(id, gate) }, { headers: { "Cache-Control": "no-store" } });
  });
});
