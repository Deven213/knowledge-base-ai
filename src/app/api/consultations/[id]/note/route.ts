import { NextResponse } from "next/server";
import { z } from "zod";
import type { NoteDTO } from "@/lib/consultations";
import { consultationRoute } from "@/server/consultations/api";
import { ConsultationError } from "@/server/consultations/errors";
import { applyDoctorEdit, noteSchema } from "@/server/consultations/note-rules";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/** The newest version of the clinical note (the AI draft until the doctor edits it). Reading it is written to the audit log. */
export const GET = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("GET /api/consultations/[id]/note", tenant, request, id, ({ services, audit }) => {
    const note = services.consultations.latestNote(id);
    if (!note) throw new ConsultationError(404, "no_note", "There is no draft note for this consultation yet.");
    audit("consultation.note.view", id, { version: note.row.version });
    const body: NoteDTO = {
      consultationId: id,
      version: note.row.version,
      source: note.row.source,
      createdAt: note.row.created_at,
      approvedAt: note.row.approved_at,
      content: note.content,
      versions: note.versions,
      needsApproval: note.row.approved_at === null,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  });
});

const putSchema = z.object({ baseVersion: z.number().int().positive(), note: noteSchema }).strict();

/** Saves the doctor's edit as a NEW version (earlier versions are kept). `baseVersion` must be the newest, so two windows can't overwrite each other. */
export const PUT = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("PUT /api/consultations/[id]/note", tenant, request, id, async ({ services, audit }) => {
    const parsed = putSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const latest = services.consultations.latestNote(id);
    if (!latest) throw new ConsultationError(409, "no_draft", "There is no draft note to edit yet.");
    const transcript = services.consultations.latestTranscript(id);
    const content = applyDoctorEdit(latest.content, parsed.data.note, transcript?.content.segments.length ?? 0);
    const version = services.consultations.addDoctorVersion(id, parsed.data.baseVersion, content);
    audit("consultation.note.edit", id, { version });
    return NextResponse.json({ version }, { headers: { "Cache-Control": "no-store" } });
  });
});
