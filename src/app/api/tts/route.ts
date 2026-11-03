import { NextResponse } from "next/server";
import { z } from "zod";
import { LANGUAGE_CODES } from "@/lib/languages";
import { internalError, jsonError, requireFeature, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";
import { geminiTts } from "@/server/tts/gemini-tts";
import { synthesizeSpeech } from "@/server/tts/service";
import { VoiceError } from "@/server/tts/types";
import { voiceContext } from "@/server/voice/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const bodySchema = z
  .object({
    // Hard cap before any processing; the tenant's (smaller) limit is applied in the service.
    text: z.string().min(1).max(20_000),
    language: z.enum(LANGUAGE_CODES),
    voice: z.string().max(40).optional(),
  })
  .strict();

/**
 * Answer text → speech for the signed-in tenant. Only called when the user clicks "Listen".
 * Returns the audio file directly (private, not cacheable by shared caches).
 */
export const POST = withTenant("chat", async (request, tenant) => {
  const off = requireFeature("chat");
  if (off) return off;
  try {
    const ctx = voiceContext(tenant);
    const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));

    const result = await synthesizeSpeech({ provider: geminiTts, apiKey: ctx.apiKey }, ctx.tenant, ctx.settings, { ...parsed.data, signal: request.signal });
    return new NextResponse(new Uint8Array(result.audio), {
      headers: {
        "Content-Type": result.mimeType,
        "Content-Length": String(result.audio.length),
        "Cache-Control": "private, no-store",
        "X-Speech-Cache": result.cached ? "hit" : "miss",
      },
    });
  } catch (err) {
    if (err instanceof VoiceError) return jsonError(err.status, err.message);
    return internalError("POST /api/tts", err);
  }
});
