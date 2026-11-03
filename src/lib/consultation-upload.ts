// Sending a finished recording to the server, in the browser. Shared by the page and its tests; nothing here touches React.
//
// The recording goes to this app's own API in parts (never to a third party), so a failed part is retried on its own instead of
// starting over, an interrupted upload resumes where it stopped, and the server checks the whole thing against a SHA-256 the browser
// computes here before it accepts it. The recording stays in memory until the server has confirmed it: nothing is written to the
// computer's storage.

export interface UploadApi {
  start(id: string, mimeType: string): Promise<{ partBytes: number; receivedParts: number[] }>;
  putPart(id: string, number: number, bytes: Blob, signal?: AbortSignal): Promise<void>;
  complete(id: string, info: { totalBytes: number; partCount: number; durationMs: number; sha256: string }): Promise<void>;
}

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Attempts per part (and per completion) before giving up. */
  maxAttempts?: number;
  /** Replaceable so tests don't wait. */
  sleep?: (ms: number) => Promise<void>;
  digest?: (data: ArrayBuffer) => Promise<ArrayBuffer>;
}

/** An upload that ended without the recording being kept. `retryable` says whether pressing "Try again" with the same recording could work. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Problems worth another try: the network, a busy server, a request that timed out. Anything else (too large, not audio, not allowed) won't change by repeating it. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status !== "number") return !(err instanceof DOMException && err.name === "AbortError"); // no status = the request never got an answer
  return status === 408 || status === 429 || status >= 500;
}

/** The server found the stored parts damaged or incomplete: sending them all again can fix it. */
const REPAIRABLE = new Set(["checksum_mismatch", "part_damaged", "part_changed", "incomplete_upload", "size_mismatch", "bad_part_size"]);

export async function uploadRecording(api: UploadApi, consultationId: string, blob: Blob, durationMs: number, options: UploadOptions = {}): Promise<void> {
  const { onProgress, signal, maxAttempts = 4 } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const digest = options.digest ?? ((data: ArrayBuffer) => crypto.subtle.digest("SHA-256", data));
  const aborted = () => signal?.aborted === true;
  const abortError = () => new UploadError("The upload was cancelled.", true);

  if (blob.size === 0) throw new UploadError("The recording is empty.", false);
  const sha256 = hex(await digest(await blob.arrayBuffer()));

  const withRetries = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      if (aborted()) throw abortError();
      try {
        return await run();
      } catch (err) {
        if (aborted()) throw abortError();
        if (attempt >= maxAttempts || !isTransient(err)) throw err;
        await sleep(1000 * 2 ** (attempt - 1)); // 1 s, 2 s, 4 s
      }
    }
  };

  let started;
  try {
    started = await withRetries(() => api.start(consultationId, blob.type || "audio/webm"));
  } catch (err) {
    throw toUploadError(err, "The recording could not be sent.");
  }
  const partBytes = started.partBytes;
  const partCount = Math.ceil(blob.size / partBytes);
  const have = new Set(started.receivedParts);
  let done = 0;
  const report = (extra = 0) => onProgress?.(Math.min(0.99, (done + extra) / (partCount + 1)));

  const sendParts = async (skip: Set<number>) => {
    for (let n = 1; n <= partCount; n++) {
      if (skip.has(n)) {
        done += 1;
        continue;
      }
      await withRetries(() => api.putPart(consultationId, n, blob.slice((n - 1) * partBytes, Math.min(n * partBytes, blob.size)), signal));
      done += 1;
      report();
    }
  };

  try {
    done = 0;
    report();
    await sendParts(have);
    try {
      await withRetries(() => api.complete(consultationId, { totalBytes: blob.size, partCount, durationMs, sha256 }));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (!code || !REPAIRABLE.has(code)) throw err;
      // The server says what it holds is damaged or incomplete: send every part again, once, then complete again.
      done = 0;
      report();
      await sendParts(new Set());
      await withRetries(() => api.complete(consultationId, { totalBytes: blob.size, partCount, durationMs, sha256 }));
    }
    onProgress?.(1);
  } catch (err) {
    throw toUploadError(err, "The recording could not be sent.");
  }
}

/** What to tell someone whose sign-in ended while a recording was waiting to be sent: the recording is still on this page, so signing in elsewhere and trying again works. */
export const SIGNED_OUT_MESSAGE = "Your sign-in has ended, so the recording could not be sent. It is still on this page. Open this site in another browser tab, sign in again, then press Try again here. Do not close this page.";

function toUploadError(err: unknown, fallback: string): UploadError {
  if (err instanceof UploadError) return err;
  if ((err as { code?: string })?.code === "unauthenticated") return new UploadError(SIGNED_OUT_MESSAGE, true);
  const message = err instanceof Error && err.message ? err.message : fallback;
  return new UploadError(message, isTransient(err) || (err as { code?: string })?.code === "checksum_mismatch");
}
