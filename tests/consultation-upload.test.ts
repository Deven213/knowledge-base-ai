// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { SIGNED_OUT_MESSAGE, UploadError, uploadRecording, type UploadApi } from "@/lib/consultation-upload";

const PART = 1000;
const blobOf = (size: number, type = "audio/webm;codecs=opus") => new Blob([Uint8Array.from({ length: size }, (_, i) => (i * 7 + 3) % 256)], { type });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A recording-server stand-in that notes everything it is sent. */
function fakeApi(overrides: Partial<UploadApi> = {}) {
  const sent: { n: number; size: number }[] = [];
  const completions: Parameters<UploadApi["complete"]>[1][] = [];
  const api: UploadApi = {
    start: vi.fn(async () => ({ partBytes: PART, receivedParts: [] as number[] })),
    putPart: vi.fn(async (_id, n, bytes) => void sent.push({ n, size: bytes.size })),
    complete: vi.fn(async (_id, info) => void completions.push(info)),
    ...overrides,
  };
  return { api, sent, completions };
}
const instant = { sleep: vi.fn(async () => undefined) };
const http = (status: number, code?: string, message = `HTTP ${status}`) => new ApiError(message, status, code);
const network = () => new Error("Could not reach the server.");

describe("sending a recording", () => {
  it("sends it in parts of the size the server asked for, then confirms the size, the number of parts, the length and the SHA-256 of the whole thing", async () => {
    const { api, sent, completions } = fakeApi();
    const blob = blobOf(2500);
    await uploadRecording(api, "c1", blob, 91_000, instant);
    expect(sent).toEqual([{ n: 1, size: 1000 }, { n: 2, size: 1000 }, { n: 3, size: 500 }]);
    expect(completions).toEqual([{ totalBytes: 2500, partCount: 3, durationMs: 91_000, sha256: sha(new Uint8Array(await blob.arrayBuffer())) }]);
    expect(api.start).toHaveBeenCalledWith("c1", "audio/webm;codecs=opus");
  });

  it("sends the right bytes in each part", async () => {
    const received: Uint8Array[] = [];
    const { api } = fakeApi({ putPart: vi.fn(async (_id, _n, bytes) => void received.push(new Uint8Array(await bytes.arrayBuffer()))) });
    const blob = blobOf(2200);
    await uploadRecording(api, "c1", blob, 5000, instant);
    const whole = new Uint8Array(await blob.arrayBuffer());
    expect(Buffer.concat(received).equals(Buffer.from(whole))).toBe(true);
  });

  it("reports steady progress that only reaches 100% when the server has confirmed", async () => {
    const { api } = fakeApi();
    const progress: number[] = [];
    await uploadRecording(api, "c1", blobOf(3500), 5000, { ...instant, onProgress: (f) => progress.push(f) });
    expect(progress.length).toBeGreaterThanOrEqual(5);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(progress.slice(0, -1).every((f) => f < 1)).toBe(true);
    expect(progress.at(-1)).toBe(1);
  });

  it("resumes an interrupted upload: parts the server already has are not sent again", async () => {
    const { api, sent } = fakeApi({ start: vi.fn(async () => ({ partBytes: PART, receivedParts: [1, 2] })) });
    await uploadRecording(api, "c1", blobOf(3200), 5000, instant);
    expect(sent.map((s) => s.n)).toEqual([3, 4]);
  });

  it("uses the SHA-256 the server can check, and nothing else leaves the browser except to the API it was given", async () => {
    const { api, completions } = fakeApi();
    const digest = vi.fn(async () => new Uint8Array(32).fill(0xab).buffer);
    await uploadRecording(api, "c1", blobOf(10), 5000, { ...instant, digest });
    expect(completions[0]!.sha256).toBe("ab".repeat(32));
  });

  it("refuses to send an empty recording", async () => {
    const { api } = fakeApi();
    await expect(uploadRecording(api, "c1", new Blob([]), 5000, instant)).rejects.toMatchObject({ retryable: false });
    expect(api.start).not.toHaveBeenCalled();
  });
});

describe("when the network or the server misbehaves", () => {
  it("retries a failed part, waiting 1 s, 2 s, 4 s, and the recording still goes through", async () => {
    let failures = 3;
    const sleep = vi.fn(async (_ms: number) => undefined);
    const { api, sent } = fakeApi({
      putPart: vi.fn(async (_id, n, bytes) => {
        if (n === 2 && failures-- > 0) throw network();
        sent.push({ n, size: bytes.size });
      }),
    });
    await uploadRecording(api, "c1", blobOf(2500), 5000, { sleep });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000, 4000]);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3]);
  });

  it.each([[500], [502], [503], [408], [429]])("treats HTTP %i as temporary and tries again", async (status) => {
    let first = true;
    const { api } = fakeApi({ putPart: vi.fn(async () => { if (first) { first = false; throw http(status); } }) });
    await expect(uploadRecording(api, "c1", blobOf(900), 5000, instant)).resolves.toBeUndefined();
    expect(api.putPart).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempts allowed and says it can be tried again with the same recording", async () => {
    const { api } = fakeApi({ putPart: vi.fn(async () => { throw network(); }) });
    const err = await uploadRecording(api, "c1", blobOf(900), 5000, { ...instant, maxAttempts: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err).toMatchObject({ retryable: true, message: "Could not reach the server." });
    expect(api.putPart).toHaveBeenCalledTimes(3);
    expect(api.complete).not.toHaveBeenCalled();
  });

  it.each([[400, "not_audio"], [403, "forbidden"], [404, "not_found"], [409, "not_uploading"], [413, "recording_too_large"]])("does not repeat a request the server refused for good (HTTP %i)", async (status, code) => {
    const { api } = fakeApi({ putPart: vi.fn(async () => { throw http(status, code, "refused"); }) });
    const err = await uploadRecording(api, "c1", blobOf(900), 5000, instant).catch((e) => e);
    expect(err).toMatchObject({ retryable: false, message: "refused" });
    expect(api.putPart).toHaveBeenCalledTimes(1);
  });

  it("retries the completion too, and stops on a refusal of it", async () => {
    let first = true;
    const retried = fakeApi({ complete: vi.fn(async () => { if (first) { first = false; throw http(503); } }) });
    await uploadRecording(retried.api, "c1", blobOf(900), 5000, instant);
    expect(retried.api.complete).toHaveBeenCalledTimes(2);

    const refused = fakeApi({ complete: vi.fn(async () => { throw http(413, "too_long", "Recordings can be at most 45 minutes long."); }) });
    await expect(uploadRecording(refused.api, "c1", blobOf(900), 5000, instant)).rejects.toMatchObject({ retryable: false, message: "Recordings can be at most 45 minutes long." });
    expect(refused.api.complete).toHaveBeenCalledTimes(1);
  });

  it("an upload that arrived damaged is repaired: every part is sent again once and the completion repeated", async () => {
    let attempt = 0;
    const { api, sent } = fakeApi({
      complete: vi.fn(async () => {
        if (attempt++ === 0) throw http(409, "checksum_mismatch", "The recording arrived damaged. Please upload it again.");
      }),
    });
    await uploadRecording(api, "c1", blobOf(2100), 5000, instant);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 3, 1, 2, 3]);
    expect(api.complete).toHaveBeenCalledTimes(2);
  });

  it.each(["part_damaged", "part_changed", "incomplete_upload", "size_mismatch", "bad_part_size"])("treats '%s' as repairable too", async (code) => {
    let attempt = 0;
    const { api, sent } = fakeApi({ complete: vi.fn(async () => { if (attempt++ === 0) throw http(409, code); }) });
    await uploadRecording(api, "c1", blobOf(1500), 5000, instant);
    expect(sent.map((s) => s.n)).toEqual([1, 2, 1, 2]);
  });

  it("repairs only once: if it is still damaged the person is told, not left in a loop", async () => {
    const { api } = fakeApi({ complete: vi.fn(async () => { throw http(409, "checksum_mismatch", "The recording arrived damaged. Please upload it again."); }) });
    const err = await uploadRecording(api, "c1", blobOf(1500), 5000, instant).catch((e) => e);
    expect(err).toMatchObject({ retryable: true, message: "The recording arrived damaged. Please upload it again." });
    expect(api.complete).toHaveBeenCalledTimes(2);
  });

  it("can't start because the consultation was already recorded: a clear message, no retries", async () => {
    const { api } = fakeApi({ start: vi.fn(async () => { throw http(409, "already_recorded", "This consultation already has a recording."); }) });
    await expect(uploadRecording(api, "c1", blobOf(900), 5000, instant)).rejects.toMatchObject({ retryable: false, message: "This consultation already has a recording." });
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("when the sign-in has ended it says what to do (the recording is still on the page), tries only once, and says it can be tried again", async () => {
    const { api } = fakeApi({ putPart: vi.fn(async () => { throw http(401, "unauthenticated", "Sign in to continue."); }) });
    const err = await uploadRecording(api, "c1", blobOf(900), 5000, instant).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err).toMatchObject({ retryable: true, message: SIGNED_OUT_MESSAGE });
    expect(err.message).toMatch(/still on this page/);
    expect(api.putPart).toHaveBeenCalledTimes(1); // no pointless retries of a request that can't succeed
  });

  it("stops at once when cancelled, without sending anything more", async () => {
    const controller = new AbortController();
    const { api, sent } = fakeApi({
      putPart: vi.fn(async (_id, n, bytes) => {
        sent.push({ n, size: bytes.size });
        if (n === 1) controller.abort();
      }),
    });
    const err = await uploadRecording(api, "c1", blobOf(3000), 5000, { ...instant, signal: controller.signal }).catch((e) => e);
    expect(err).toMatchObject({ message: "The upload was cancelled.", retryable: true });
    expect(sent.map((s) => s.n)).toEqual([1]);
    expect(api.complete).not.toHaveBeenCalled();
  });
});
