// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";

// What the browser's API client does when the server says "you are not signed in" (HTTP 401). Normally the person is sent to the sign-in page. But
// while a recording is being sent, leaving the page would throw the recording away: those three calls stay put and let the page explain.

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("window", { location: { assign, pathname: "/admin/consultations/abc", search: "" } });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Sign in to continue.", code: "unauthenticated" }), { status: 401, headers: { "content-type": "application/json" } })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the API client when the sign-in has ended", () => {
  it("sends an ordinary request to the sign-in page, and comes back to this page afterwards", async () => {
    await expect(api.consultations()).rejects.toBeInstanceOf(ApiError);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(String(assign.mock.calls[0]![0])).toMatch(/\/login\?.*admin%2Fconsultations%2Fabc|\/login/);
  });

  it("does NOT leave the page while a recording is being sent: the three upload calls report the problem and stay", async () => {
    const blob = new Blob([new Uint8Array(10)]);
    for (const call of [
      () => api.startRecordingUpload("c1", "audio/webm"),
      () => api.uploadRecordingPart("c1", 1, blob),
      () => api.completeRecording("c1", { totalBytes: 10, partCount: 1, durationMs: 5000, sha256: "a".repeat(64) }),
    ]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 401, code: "unauthenticated" });
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it("carries the status and the server's code on every failed call, so the caller can tell what is worth repeating", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "This recording is larger than the limit.", code: "recording_too_large" }), { status: 413 })));
    const err = await api.uploadRecordingPart("c1", 1, new Blob([new Uint8Array(1)])).catch((e) => e);
    expect(err).toMatchObject({ name: "ApiError", status: 413, code: "recording_too_large", message: "This recording is larger than the limit." });
  });
});
