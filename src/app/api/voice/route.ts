import { NextResponse } from "next/server";
import { internalError, requireFeature } from "@/server/http";
import { voiceContext } from "@/server/voice/context";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Which voice features this tenant can use (no models, keys or voices are revealed). */
export const GET = withTenant("chat", async (_request, tenant) => {
  const off = requireFeature("chat");
  if (off) return off;
  try {
    const ctx = voiceContext(tenant);
    return NextResponse.json({
      tts: { enabled: ctx.settings.tts.enabled, maxChars: ctx.settings.tts.maxChars },
      stt: { enabled: ctx.settings.stt.enabled },
    });
  } catch (err) {
    return internalError("GET /api/voice", err);
  }
});
