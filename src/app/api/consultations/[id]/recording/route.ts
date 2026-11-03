import { NextResponse } from "next/server";
import { z } from "zod";
import { UPLOAD_PART_BYTES } from "@/lib/consultations";
import { consultationRoute } from "@/server/consultations/api";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** Opens the upload of this consultation's recording, or returns the one in progress with the parts already received (so an interrupted upload resumes). */
export const POST = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("POST /api/consultations/[id]/recording", tenant, request, id, async ({ services, audit }) => {
    const parsed = z.object({ mimeType: z.string().min(1).max(100) }).strict().safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const before = services.consultations.recordingOf(id);
    const { recording, receivedParts } = services.recordings.start(id, parsed.data.mimeType);
    if (!before) audit("consultation.recording.start", id, { mimeType: recording.mime_type });
    return NextResponse.json({ recordingId: recording.id, partBytes: UPLOAD_PART_BYTES, receivedParts }, { headers: { "Cache-Control": "no-store" } });
  });
});

/**
 * Deletes the recording's audio. Before it was completed this just abandons the upload (the doctor can start again); once stored it
 * deletes the audio for good and keeps the transcript and note, if any. Deleting twice is harmless.
 */
export const DELETE = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("DELETE /api/consultations/[id]/recording", tenant, request, id, async ({ services, audit }) => {
    const before = services.consultations.recordingOf(id);
    const deleted = await services.recordings.deleteAudio(id);
    if (deleted) audit(before?.status === "uploading" ? "consultation.recording.discard" : "consultation.audio.delete", id);
    return new NextResponse(null, { status: 204 });
  });
});
