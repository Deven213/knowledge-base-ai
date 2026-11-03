import "server-only";
import { ConsultationError } from "./errors";

/**
 * Reads a request's body, stopping as soon as it goes over `limit` bytes. A declared Content-Length can be missing or wrong (a chunked body has none),
 * so the size is enforced on what actually arrives: an oversized upload is refused after at most `limit` bytes instead of being buffered whole.
 */
export async function readBodyLimited(request: Request, limit: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ConsultationError(413, "part_too_large", "That part is larger than allowed.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
