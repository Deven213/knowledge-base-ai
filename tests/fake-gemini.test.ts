import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { groundNote, draftNote } from "@/server/consultations/note-ai";
import { ProcessingError } from "@/server/consultations/processing-error";
import { geminiTranscriber, INLINE_AUDIO_LIMIT_BYTES } from "@/server/consultations/transcription/gemini";
import { normalizeTranscript } from "@/server/consultations/transcription/parse";
import { getProvider } from "@/server/llm/registry";
import * as fake from "../scripts/fake-gemini.mjs";
import { goodDraft, MIXED_TRANSCRIPT } from "./consultation-helpers";

// The stand-in for Gemini (scripts/fake-gemini.mjs) is only worth anything if the REAL client code can talk to it, so these tests don't
// mock the Google SDK: they run the app's actual transcription adapter and note provider against the stand-in, over localhost.
// They also check the promises made for it: fixed answers, fake keys only, nothing forwarded, nothing sensitive written down.

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "fake-gemini.mjs");
const GUARD = path.join(ROOT, "scripts", "loopback-only.cjs");
const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), crypto.randomBytes(4000)]);
const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

let mock: fake.FakeGemini;
let savedBase: string | undefined;

beforeAll(async () => {
  savedBase = process.env.GOOGLE_GEMINI_BASE_URL;
  mock = await fake.startFakeGemini({ port: 0 });
  process.env.GOOGLE_GEMINI_BASE_URL = mock.url; // the Google client reads this when it is created
});
afterAll(async () => {
  if (savedBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
  else process.env.GOOGLE_GEMINI_BASE_URL = savedBase;
  await mock.close();
});

const transcribe = (audio: Buffer, apiKey = fake.FAKE_API_KEY) =>
  geminiTranscriber.transcribe({ audio, mimeType: "audio/wav", languageHint: "mixed", model: "mock-transcription-model", apiKey });

/** The requests the stand-in logged after `seq`. */
const since = (seq: number) => mock.requests().filter((r) => r.seq > seq);
const mark = () => mock.requests().at(-1)?.seq ?? 0;

/** A raw HTTP request to the stand-in with full control of the request line and Host header (what a proxy client or a rebinding page would send). */
function raw(port: number, options: { method?: string; path: string; host: string; headers?: Record<string, string> }) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path, headers: { host: options.host, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the stand-in speaks the app's real Gemini dialect", () => {
  it("transcribes with the real adapter and returns the fixed transcript, the same every time", async () => {
    const first = await transcribe(wav);
    const second = await transcribe(wav);
    expect(first).toEqual(normalizeTranscript(fake.TRANSCRIPT_RESPONSE));
    expect(second).toEqual(first);
    expect(first.segments).toHaveLength(6);
    expect(first.segments[5]).toMatchObject({ uncertain: true });
    expect(first.remarks).toEqual([fake.MOCK_REMARK]); // anything a person reads says it is a mock
  });

  it("records what it received as sizes and a fingerprint, with the fake key and the model asked for", async () => {
    const at = mark();
    await transcribe(wav);
    const [entry] = since(at).filter((r) => r.kind === "transcribe");
    expect(entry).toMatchObject({ kind: "transcribe", via: "inline", audioBytes: wav.length, audioSha256: sha256(wav), mimeType: "audio/wav", model: "mock-transcription-model", apiKey: "fake", keyInUrl: false, answered: 200 });
  });

  it("drafts a note through the real note provider; every statement survives the app's own grounding rules", async () => {
    const at = mark();
    const transcript = normalizeTranscript(fake.TRANSCRIPT_RESPONSE);
    const { note, dropped } = await draftNote({ provider: getProvider("gemini"), model: "mock-note-model", apiKey: fake.FAKE_API_KEY, transcript });
    expect(dropped).toBe(0);
    const texts = note.sections.flatMap((s) => s.items.map((i) => i.text));
    expect(texts).toContain("Paracetamol 650 mg twice a day for three days.");
    expect(texts).toHaveLength(fake.NOTE_RESPONSE.sections.flatMap((s) => s.items).length);
    const [entry] = since(at).filter((r) => r.kind === "note");
    expect(entry).toMatchObject({ hasAudio: false, transcriptLines: 6, apiKey: "fake", answered: 200 }); // the note is written from the transcript alone
  });

  it("stays identical to the fixtures the rest of the test suite uses (they cannot drift apart)", () => {
    expect(fake.TRANSCRIPT_RESPONSE.segments).toEqual(MIXED_TRANSCRIPT.segments);
    expect(fake.NOTE_RESPONSE).toEqual(goodDraft());
    expect(groundNote(fake.NOTE_RESPONSE, MIXED_TRANSCRIPT).dropped).toBe(0);
  });

  it("handles a recording too large to send inline: upload, transcribe by reference, delete the uploaded copy", { timeout: 60_000 }, async () => {
    const big = Buffer.alloc(INLINE_AUDIO_LIMIT_BYTES + 1024, 7); // two upload chunks
    const at = mark();
    const transcript = await transcribe(big);
    expect(transcript).toEqual(normalizeTranscript(fake.TRANSCRIPT_RESPONSE));
    const log = since(at);
    const kinds = log.map((r) => r.kind);
    expect(kinds).toEqual(["file-upload", "transcribe", "file-delete"]);
    expect(log[0]).toMatchObject({ bytes: big.length, audioSha256: sha256(big) });
    expect(log[1]).toMatchObject({ via: "file", audioBytes: big.length, audioSha256: sha256(big), apiKey: "fake" });
    expect(log[2]).toMatchObject({ found: true }); // Google would not be left holding a copy, and neither is the stand-in
    const leftover = await raw(mock.port, { path: `/v1beta/${log[0]?.fileName}`, host: `127.0.0.1:${mock.port}`, headers: { "x-goog-api-key": fake.FAKE_API_KEY } });
    expect(leftover.status).toBe(404);
  });

  it("can fail the first transcription once, like a busy service (--fail-first), then answer normally", async () => {
    const flaky = await fake.startFakeGemini({ port: 0, failFirst: true });
    const saved = process.env.GOOGLE_GEMINI_BASE_URL;
    process.env.GOOGLE_GEMINI_BASE_URL = flaky.url;
    try {
      const failure = await transcribe(wav).catch((e) => e);
      expect(failure).toBeInstanceOf(ProcessingError);
      expect((failure as ProcessingError).retryable).toBe(true);
      expect(await transcribe(wav)).toEqual(normalizeTranscript(fake.TRANSCRIPT_RESPONSE));
      expect(flaky.requests().filter((r) => r.kind === "transcribe").map((r) => r.answered)).toEqual([503, 200]);
    } finally {
      process.env.GOOGLE_GEMINI_BASE_URL = saved;
      await flaky.close();
    }
  });
});

describe("only fake keys, and nothing sensitive in the record", () => {
  // Built in the test, clearly not real: it only has to LOOK like the kind of key a real Google account has.
  const realLooking = "AIzaSy" + "x".repeat(33);

  it("refuses a key that does not start with fake- (and writes nothing down about it)", async () => {
    const at = mark();
    const err = await transcribe(wav, realLooking).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessingError);
    const log = since(at);
    expect(log.map((r) => r.kind)).toEqual(["rejected"]);
    expect(log[0]).toMatchObject({ reason: "api-key-not-fake" });
    expect(JSON.stringify(mock.requests())).not.toContain(realLooking);
    expect(JSON.stringify(mock.requests())).not.toContain("xxxxxxxx");
  });

  it("keeps the audio, the transcript text and every key out of its log", async () => {
    await transcribe(wav);
    await draftNote({ provider: getProvider("gemini"), model: "mock-note-model", apiKey: fake.FAKE_API_KEY, transcript: normalizeTranscript(fake.TRANSCRIPT_RESPONSE) });
    const logged = JSON.stringify(mock.requests());
    expect(logged).not.toContain(wav.toString("base64").slice(0, 80));
    expect(logged).not.toContain("inlineData");
    expect(logged).not.toContain(fake.FAKE_API_KEY);
    for (const segment of fake.TRANSCRIPT_RESPONSE.segments) expect(logged).not.toContain(segment.text);
  });

  it("writes its log to a file when asked, with the same content (and still no secrets)", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-")), "requests.jsonl");
    const logged = await fake.startFakeGemini({ port: 0, logFile: file });
    const saved = process.env.GOOGLE_GEMINI_BASE_URL;
    process.env.GOOGLE_GEMINI_BASE_URL = logged.url;
    try {
      await transcribe(wav);
    } finally {
      process.env.GOOGLE_GEMINI_BASE_URL = saved;
      await logged.close();
    }
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["listening", "transcribe"]);
    expect(fs.readFileSync(file, "utf8")).not.toContain(fake.FAKE_API_KEY);
  });
});

describe("it cannot be used to reach anything else", () => {
  it("listens on 127.0.0.1 only, and an option to listen elsewhere does nothing", async () => {
    expect((mock.server.address() as { address: string }).address).toBe("127.0.0.1");
    const wide = await fake.startFakeGemini({ port: 0, host: "0.0.0.0" } as never);
    try {
      expect((wide.server.address() as { address: string }).address).toBe("127.0.0.1");
    } finally {
      await wide.close();
    }
  });

  it("is not a proxy: a request for another site is refused and goes nowhere", async () => {
    const at = mark();
    const res = await raw(mock.port, { path: "http://example.com/v1beta/models/x:generateContent", host: "example.com", headers: { "x-goog-api-key": fake.FAKE_API_KEY } });
    expect(res.status).toBe(403);
    expect(since(at)).toEqual([expect.objectContaining({ kind: "rejected", reason: "proxy-style-request" })]);
  });

  it("refuses requests addressed to any host name other than localhost (a web page cannot reach it through a rebinding name)", async () => {
    const at = mark();
    const res = await raw(mock.port, { path: "/__mock/identity", host: "evil.example" });
    expect(res.status).toBe(403);
    expect(since(at)).toEqual([expect.objectContaining({ kind: "rejected", reason: "host-not-loopback" })]);
    expect((await raw(mock.port, { path: "/__mock/identity", host: `127.0.0.1:${mock.port}` })).status).toBe(200);
    expect((await raw(mock.port, { path: "/__mock/identity", host: `localhost:${mock.port}` })).status).toBe(200);
  });

  it("answers anything it does not know with a 400 and records that it did not know it", async () => {
    const at = mark();
    const res = await raw(mock.port, { path: "/v1beta/models/mock:streamGenerateContent", method: "POST", host: `127.0.0.1:${mock.port}`, headers: { "x-goog-api-key": fake.FAKE_API_KEY } });
    expect(res.status).toBe(400);
    expect(since(at)).toEqual([expect.objectContaining({ kind: "unknown", method: "POST" })]);
  });

  it("only shuts down for the holder of the token", async () => {
    let stopped = 0;
    const guarded = await fake.startFakeGemini({ port: 0, token: "t0ken", onShutdown: () => void (stopped += 1) });
    try {
      const host = `127.0.0.1:${guarded.port}`;
      expect((await raw(guarded.port, { path: "/__mock/shutdown", method: "POST", host })).status).toBe(403);
      expect((await raw(guarded.port, { path: "/__mock/shutdown", method: "POST", host, headers: { "x-mock-token": "wrong" } })).status).toBe(403);
      expect(stopped).toBe(0);
      expect((await raw(guarded.port, { path: "/__mock/shutdown", method: "POST", host, headers: { "x-mock-token": "t0ken" } })).status).toBe(200);
      await new Promise((r) => setImmediate(r));
      expect(stopped).toBe(1);
    } finally {
      await guarded.close();
    }
  });

  // The strongest form of "it cannot forward": the program contains no code that could. A future edit that adds some fails here.
  describe("its source has no way to make a network request", () => {
    const code = fs
      .readFileSync(SCRIPT, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");

    it("imports only modules that cannot open a connection", () => {
      const imports = [...code.matchAll(/from\s+"(node:[a-z_/]+)"/g)].map((m) => m[1]).sort();
      expect(imports).toEqual(["node:crypto", "node:fs", "node:http", "node:module", "node:path", "node:url"]);
      expect(code).not.toMatch(/\bimport\s*\(/); // no dynamic imports
      expect(code).not.toMatch(/\brequire\(\s*[^"'.]/); // the only require() is the fixed "./loopback-only.cjs"
    });

    it("has no client code: no fetch, no http.request/get, no connect, no WebSocket, no child process", () => {
      expect(code).not.toMatch(/\bfetch\s*\(/);
      expect(code).not.toMatch(/\bhttps?\.(request|get)\b/);
      expect(code).not.toMatch(/\.connect\s*\(/);
      expect(code).not.toMatch(/WebSocket|XMLHttpRequest|EventSource|child_process|\bnet\./);
    });

    it("listens on a fixed loopback address and, from the command line, loads the outgoing-connection guard first", () => {
      expect(code).toMatch(/const LISTEN_HOST = "127\.0\.0\.1";/);
      expect([...code.matchAll(/\.listen\(([^)]*)\)/g)].map((m) => m[1]?.split(",")[1]?.trim())).toEqual(["LISTEN_HOST"]);
      const main = code.slice(code.indexOf("async function main"));
      expect(main.indexOf('createRequire(import.meta.url)("./loopback-only.cjs")')).toBeGreaterThan(-1);
      expect(main.indexOf("loopback-only.cjs")).toBeLessThan(main.indexOf("startFakeGemini("));
    });
  });
});

describe("the outgoing-connection guard (scripts/loopback-only.cjs)", () => {
  it("lets a process talk to itself and refuses everything else, before any lookup", { timeout: 30_000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loopback-guard-"));
    const script = path.join(dir, "probe.cjs");
    fs.writeFileSync(
      script,
      `
const http = require("node:http");
const net = require("node:net");
const out = {};
const server = http.createServer((req, res) => res.end("hello")).listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  out.local = await fetch("http://127.0.0.1:" + port).then((r) => r.text());
  const attempts = {
    fetchByName: () => fetch("https://example.com/"),
    fetchByAddress: () => fetch("http://93.184.216.34/"),
    httpGet: () => new Promise((resolve, reject) => http.get("http://example.org/", resolve).on("error", reject)),
    netConnect: () => new Promise((resolve, reject) => { const s = net.connect(80, "example.net"); s.on("error", reject); s.on("connect", resolve); }),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    try { await attempt(); out[name] = "CONNECTED"; } catch (e) { const c = e.cause ?? e; out[name] = c.code + ":" + String(c.message).includes("loopback-only"); }
  }
  console.log(JSON.stringify(out));
  server.close();
});
`,
    );
    const output = execFileSync(process.execPath, ["--require", GUARD, script], { encoding: "utf8", timeout: 25_000 });
    const result = JSON.parse(output.trim().split("\n").at(-1)!);
    expect(result).toEqual({ local: "hello", fetchByName: "ECONNBLOCKED:true", fetchByAddress: "ECONNBLOCKED:true", httpGet: "ECONNBLOCKED:true", netConnect: "ECONNBLOCKED:true" });
  });
});

describe("run from the command line", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill();
  });

  it("starts, says what it is, and stops cleanly through its shutdown route", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, [SCRIPT, "--port", "0"], { env: { PATH: process.env.PATH ?? "", FAKE_GEMINI_SHUTDOWN_TOKEN: "cli-token" } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const line = await new Promise<string>((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (d) => {
        text += d;
        if (text.includes("\n")) resolve(text);
      });
      child.once("error", reject);
      child.once("exit", () => reject(new Error("exited early")));
    });
    expect(line).toMatch(/fake-gemini listening on http:\/\/127\.0\.0\.1:\d+: fake keys only, no outgoing connections/);
    const port = Number(line.match(/127\.0\.0\.1:(\d+)/)![1]);

    const identity = JSON.parse((await raw(port, { path: "/__mock/identity", host: `127.0.0.1:${port}` })).body);
    expect(identity).toMatchObject({ service: "fake-gemini", outbound: "none", pid: child.pid });

    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect((await raw(port, { path: "/__mock/shutdown", method: "POST", host: `127.0.0.1:${port}`, headers: { "x-mock-token": "cli-token" } })).status).toBe(200);
    expect(await exited).toBe(0);
  });

  it("rejects options it does not know instead of ignoring them (there is no --host)", () => {
    expect(() => execFileSync(process.execPath, [SCRIPT, "--host", "0.0.0.0"], { encoding: "utf8", stdio: "pipe" })).toThrow(/Unknown option --host/);
  });
});
