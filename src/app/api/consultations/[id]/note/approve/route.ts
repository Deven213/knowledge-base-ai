import { NextResponse } from "next/server";
import { z } from "zod";
import { consultationRoute } from "@/server/consultations/api";
import { ConsultationError } from "@/server/consultations/errors";
import { unresolvedFlags } from "@/server/consultations/note-rules";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

const bodySchema = z
  .object({
    version: z.number().int().positive(),
    /** The doctor's explicit statement that they have read the whole note. Nothing is ever approved by default or automatically. */
    confirm: z.literal(true, { error: "Confirm that you have reviewed the note." }),
  })
  .strict();

/**
 * Approves one version of the note, once. Only a doctor can do it, only for their own consultation, only for the newest version, and only
 * once every safety flag has been marked as reviewed. An approved version is final: later changes are a new version.
 */
export const POST = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("POST /api/consultations/[id]/note/approve", tenant, request, id, async ({ services, audit }) => {
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const latest = services.consultations.latestNote(id);
    if (!latest) throw new ConsultationError(409, "no_draft", "There is no draft note to approve yet.");
    const open = unresolvedFlags(latest.content);
    if (latest.row.version === parsed.data.version && open.length > 0) {
      throw new ConsultationError(409, "flags_unresolved", `Review ${open.length === 1 ? "the flagged item" : `all ${open.length} flagged items`} before approving.`);
    }
    services.consultations.approve(id, parsed.data.version);
    audit("consultation.note.approve", id, { version: parsed.data.version });
    return NextResponse.json({ approved: true, version: parsed.data.version }, { headers: { "Cache-Control": "no-store" } });
  });
});
