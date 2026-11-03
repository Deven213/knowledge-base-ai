import { NextResponse } from "next/server";
import { LANGUAGE_CODES } from "@/lib/languages";
import { internalError, jsonError, requireFeature } from "@/server/http";
import { withTenant } from "@/server/tenant";
import { MAX_RECORDING_BYTES, normalizeAudioType, transcribeSpeech } from "@/server/stt/gemini-stt";
import { VoiceError } from "@/server/tts/types";
import { voiceContext } from "@/server/voice/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

/**
 * Voice input → text, for the chat box only. Separate from /api/ask: nothing is searched or answered
 * here, and the recording is not stored.
 */
export const POST = withTenant("chat", async (request, tenant) => {
  const off = requireFeature("chat");
  if (off) return off;
  try {
    const ctx = voiceContext(tenant);
    if (!ctx.settings.stt.enabled || !ctx.apiKey || !ctx.settings.stt.model) {
      return jsonError(503, "Voice input is unavailable right now.");
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_RECORDING_BYTES + 64 * 1024) {
      return jsonError(413, "That recording is too long. Please keep voice questions under two minutes.");
    }
    const form = await request.formData().catch(() => null);
    const file = form?.get("audio");
    if (!(file instanceof File) || file.size === 0) return jsonError(400, "No audio was received. Please try recording again.");
    if (file.size > MAX_RECORDING_BYTES) return jsonError(413, "That recording is too long. Please keep voice questions under two minutes.");
    const mimeType = normalizeAudioType(file.type);
    if (!mimeType) return jsonError(400, "This recording format isn't supported by your browser setup.");
    const languageRaw = form?.get("language");
    const language = typeof languageRaw === "string" && (LANGUAGE_CODES as readonly string[]).includes(languageRaw) ? languageRaw : "en";

    const text = await transcribeSpeech({
      audio: Buffer.from(await file.arrayBuffer()),
      mimeType,
      language,
      model: ctx.settings.stt.model,
      apiKey: ctx.apiKey,
      signal: request.signal,
    });
    return NextResponse.json({ text }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof VoiceError) return jsonError(err.status, err.message);
    return internalError("POST /api/stt", err);
  }
});
