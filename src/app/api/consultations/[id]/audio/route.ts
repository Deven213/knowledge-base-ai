import { consultationRoute } from "@/server/consultations/api";
import { parseRange } from "@/server/consultations/recording";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { id: string };

/**
 * The doctor listening to their own consultation (to check a passage the transcript was unsure about). The audio is opened from its sealed
 * parts here, for the signed-in doctor who owns the consultation only, and is never cached. Every listen is written to the audit log.
 * It supports byte ranges so the player can seek, and it streams: only the parts a request touches are opened, one at a time, so a long
 * recording (or a player that seeks a lot) never holds more than about one part in memory.
 */
export const GET = withTenant<Params>("consultations:use", async (request, tenant, ctx) => {
  const { id } = await ctx.params;
  return consultationRoute("GET /api/consultations/[id]/audio", tenant, request, id, async ({ services, audit }) => {
    const { size, mimeType } = services.recordings.audioMeta(id);
    const headers = { "Content-Type": mimeType, "Cache-Control": "no-store, private", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" };
    const range = parseRange(request.headers.get("range"), size);
    if (range === "unsatisfiable") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    const body = await services.recordings.audioStream(id, range ?? undefined); // opens the first part now: damaged storage is refused cleanly
    audit("consultation.audio.listen", id, range ? { partial: true } : undefined);
    if (!range) return new Response(body, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
    return new Response(body, { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) } });
  });
});
