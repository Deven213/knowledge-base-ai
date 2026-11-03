import { NextResponse } from "next/server";
import { z } from "zod";
import { consultationRoute } from "@/server/consultations/api";
import { notFound } from "@/server/consultations/errors";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** One of this doctor's consultations: its status and what the worker is doing. Not the transcript or the note. */
export const GET = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("GET /api/consultations/[id]", tenant, request, id, ({ services, gate }) => {
    const detail = services.consultations.detail(id, gate);
    if (!detail) throw notFound();
    return NextResponse.json({ consultation: detail }, { headers: { "Cache-Control": "no-store" } });
  });
});

/** Deletes the consultation for good: its audio, transcript, notes and consent record. The doctor must confirm explicitly. */
export const DELETE = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("DELETE /api/consultations/[id]", tenant, request, id, async ({ services, audit }) => {
    const parsed = z.object({ confirm: z.literal(true) }).strict().safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error) || "Confirm the deletion.");
    // Audio first (removing it twice is harmless), then the records: if the second step failed, deleting again finishes the job.
    const hadAudio = await services.recordings.deleteAudio(id);
    const removed = services.consultations.delete(id);
    if (!removed) throw notFound();
    audit("consultation.delete", id, { hadAudio });
    return new NextResponse(null, { status: 204 });
  });
});
