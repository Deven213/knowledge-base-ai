#!/usr/bin/env node
// A stand-in for the Gemini API, for testing Doctor Consultations WITHOUT any real AI service.
//
//   node scripts/fake-gemini.mjs [--port 3299] [--log <file.jsonl>] [--fail-first]
//
// The app talks to it through the real @google/genai client: set GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:3299 and any API key that
// starts with "fake-". It answers the three things the consultation pipeline asks of Gemini, always with the same fixed text:
//
//   - transcribe a recording   (POST /v1beta/models/<model>:generateContent, with audio inline or by file reference)
//   - draft a clinical note    (the same URL, no audio, the transcript as text)
//   - the Files API            (start / upload / get / delete), which the app uses for recordings larger than 12 MB
//
// What it guarantees (tests/fake-gemini.test.ts checks each):
//   - It listens on 127.0.0.1 only, whatever options are passed. Requests addressed to any other host name are refused.
//   - It never makes a network request. It has no client code at all (no fetch, no http.request, no sockets of its own) and, when run
//     from the command line, it also loads scripts/loopback-only.cjs, which refuses every outgoing connection. It is not a proxy:
//     a request that is not for one of the routes below gets a 400 and goes nowhere.
//   - It accepts only API keys that start with "fake-". Anything else is refused with a 401, and the key is never stored or written down.
//   - Its request log holds sizes and fingerprints (a SHA-256 of the audio, the number of transcript lines), never the audio, the
//     transcript text or a key, so the log can be read, kept or shared.
//   - Its answers contain no clock, no counter and no randomness: the same request always gets the same answer.
//
// Everything it returns says "MOCK" where a person will read it (the transcript's remarks), so a test result cannot be mistaken for the
// real thing.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only address this program ever listens on. There is deliberately no option to change it. */
const LISTEN_HOST = "127.0.0.1";
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_LOGGED = 2000;

export const FAKE_KEY_PREFIX = "fake-";
/** The key the mock-testing launcher gives the app. Not a secret: it only works against this stand-in. */
export const FAKE_API_KEY = "fake-gemini-key-for-mock-testing";

export const MOCK_REMARK = "MOCK AI: this is a fixed test transcript, not a transcription of the recording.";

/** The same six segments as MIXED_TRANSCRIPT in tests/consultation-helpers.ts (a test keeps them identical): Gujarati, Hindi and English, one uncertain. */
export const TRANSCRIPT_RESPONSE = {
  segments: [
    { speaker: "doctor", text: "નમસ્તે, કહો, શું તકલીફ છે?", language: "gu", uncertain: false },
    { speaker: "patient", text: "ડૉક્ટર સાહેબ, ત્રણ દિવસથી બહુ fever છે અને માથું દુખે છે.", language: "mixed", uncertain: false },
    { speaker: "patient", text: "मुझे sugar की दवा भी चल रही है, metformin 500 mg.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "ઠીક છે. Temperature 101 છે, BP 120/80 છે.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "Paracetamol 650 mg twice a day for three days લો, અને ખૂબ પાણી પીઓ.", language: "mixed", uncertain: false },
    { speaker: "doctor", text: "પાંચ દિવસ પછી ફરી બતાવજો. [inaudible] ના લેતા.", language: "gu", uncertain: true },
  ],
  remarks: [MOCK_REMARK],
  audioQuality: "fair",
};

const item = (text, origin, evidence, quote = "") => ({ text, origin, evidence, quote });

/** The draft note for TRANSCRIPT_RESPONSE: every item cites the segments it came from (a test checks it survives the app's grounding rules untouched). */
export const NOTE_RESPONSE = {
  sections: [
    { key: "chief_complaint", items: [item("Fever and headache for three days.", "patient_reported", [2])] },
    { key: "history", items: [item("Fever for 3 days.", "patient_reported", [2])] },
    { key: "medications_allergies", items: [item("Takes metformin 500 mg for diabetes.", "patient_reported", [3])] },
    { key: "findings", items: [item("Temperature 101. BP 120/80.", "clinician_observation", [4])] },
    { key: "assessment", items: [] },
    { key: "investigations", items: [] },
    { key: "medication_decisions", items: [item("Paracetamol 650 mg twice a day for three days.", "clinician_decision", [5], "Paracetamol 650 mg twice a day for three days")] },
    { key: "counselling_followup", items: [item("Drink plenty of water. Review after five days.", "advice_given", [5, 6])] },
    { key: "open_questions", items: [] },
  ],
  flags: [],
};

/** Telling the two requests apart: by the instructions the app sends, not by guessing. A change to those prompts fails here, loudly, instead of being answered wrongly. */
const TRANSCRIBE_PROMPT = /You transcribe the recording/;
const NOTE_PROMPT = /You prepare a DRAFT clinical note/;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/** "127.0.0.1:3299" -> "127.0.0.1"; "[::1]:3299" -> "::1". */
function hostName(header) {
  const value = String(header ?? "").trim().toLowerCase();
  const bracketed = value.match(/^\[([^\]]*)\](?::\d+)?$/);
  return bracketed ? bracketed[1] : value.replace(/:\d+$/, "");
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) over = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve({ over, body: Buffer.concat(chunks) }));
    req.on("error", reject);
  });
}

/**
 * Starts the stand-in. Resolves once it is listening. `port: 0` picks a free one (tests).
 * `token`, when given, is required (header x-mock-token) to shut it down through POST /__mock/shutdown.
 */
export function startFakeGemini(options = {}) {
  const { port = 0, logFile, failFirst = false, token, onShutdown } = options;
  const state = { log: [], seq: 0, transcriptions: 0, fileCounter: 0, filesStored: 0, files: new Map(), uploads: new Map() };

  const record = (entry) => {
    const line = { seq: ++state.seq, ...entry };
    state.log.push(line);
    if (state.log.length > MAX_LOGGED) state.log.shift();
    if (logFile) {
      try {
        fs.appendFileSync(logFile, JSON.stringify(line) + "\n");
      } catch {
        /* the in-memory log is the source of truth; a full disk must not break an answer */
      }
    }
  };

  const handle = async (req, res) => {
    const reply = (status, payload, headers = {}) => {
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, { "content-type": "application/json; charset=UTF-8", "content-length": body.length, "x-fake-gemini": "1", ...headers });
      res.end(body);
    };
    const apiError = (status, code, message) => reply(status, { error: { code: status, message, status: code } });

    // Not a proxy: a request line like "GET http://example.com/ HTTP/1.1" is a request to forward somewhere. Refuse it.
    if (!String(req.url).startsWith("/")) {
      record({ kind: "rejected", reason: "proxy-style-request" });
      return apiError(403, "PERMISSION_DENIED", "This stand-in is not a proxy.");
    }
    if (!LOOPBACK_NAMES.has(hostName(req.headers.host))) {
      record({ kind: "rejected", reason: "host-not-loopback" });
      return apiError(403, "PERMISSION_DENIED", "This stand-in only answers requests addressed to localhost.");
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const route = `${req.method} ${url.pathname}`;

    // ── Control routes (this computer only, like everything else) ──
    if (route === "GET /__mock/identity") {
      return reply(200, { service: "fake-gemini", version: 1, pid: process.pid, outbound: "none", acceptsKeys: `${FAKE_KEY_PREFIX}*`, failFirst });
    }
    if (route === "GET /__mock/requests") return reply(200, { requests: state.log });
    if (route === "POST /__mock/shutdown") {
      if (token && req.headers["x-mock-token"] !== token) return apiError(403, "PERMISSION_DENIED", "Wrong shutdown token.");
      reply(200, { stopping: true });
      setImmediate(() => (onShutdown ? onShutdown() : undefined));
      return;
    }

    const { over, body } = await readBody(req);
    if (over) {
      record({ kind: "rejected", reason: "body-too-large" });
      return apiError(413, "INVALID_ARGUMENT", "Request body is too large for this stand-in.");
    }

    // ── Resumable upload data: the URL is the capability (like Google's); the key header is checked when it is present ──
    const uploadMatch = url.pathname.match(/^\/__upload\/([a-z0-9]+)$/);
    if (req.method === "POST" && uploadMatch) return handleUploadChunk(req, reply, apiError, body, uploadMatch[1]);

    // ── Everything else is the Gemini API, which needs a key, and only a fake one ──
    const key = req.headers["x-goog-api-key"];
    if (typeof key !== "string" || !key.startsWith(FAKE_KEY_PREFIX)) {
      record({ kind: "rejected", reason: "api-key-not-fake", path: url.pathname }); // the key itself is never recorded
      return apiError(401, "UNAUTHENTICATED", `API key not valid. This stand-in accepts only keys that start with "${FAKE_KEY_PREFIX}".`);
    }
    const keyInUrl = url.searchParams.has("key");

    const generate = url.pathname.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
    if (req.method === "POST" && generate) return handleGenerate(reply, apiError, body, generate[1], keyInUrl);

    if (route === "POST /upload/v1beta/files" && req.headers["x-goog-upload-command"] === "start") {
      const id = `mockupload${++state.fileCounter}`;
      state.uploads.set(id, { chunks: [], bytes: 0, mimeType: String(req.headers["x-goog-upload-header-content-type"] ?? "") });
      return reply(200, {}, { "x-goog-upload-url": `http://${req.headers.host}/__upload/${id}`, "x-goog-upload-status": "active", "x-goog-upload-chunk-granularity": "8388608" });
    }
    const file = url.pathname.match(/^\/v1beta\/(files\/[a-z0-9-]+)$/);
    if (req.method === "GET" && file) {
      const found = state.files.get(file[1]);
      return found ? reply(200, found.meta) : apiError(404, "NOT_FOUND", "File not found.");
    }
    if (req.method === "DELETE" && file) {
      const existed = state.files.delete(file[1]);
      record({ kind: "file-delete", fileName: file[1], found: existed });
      return existed ? reply(200, {}) : apiError(404, "NOT_FOUND", "File not found.");
    }

    // Anything else is not something the app should be asking for: say so, and go nowhere with it.
    record({ kind: "unknown", method: req.method, path: url.pathname });
    return apiError(400, "INVALID_ARGUMENT", `The stand-in does not know ${route}.`);
  };

  function handleUploadChunk(req, reply, apiError, body, id) {
    const key = req.headers["x-goog-api-key"];
    if (typeof key === "string" && !key.startsWith(FAKE_KEY_PREFIX)) {
      record({ kind: "rejected", reason: "api-key-not-fake", path: "/__upload" });
      return apiError(401, "UNAUTHENTICATED", `API key not valid. This stand-in accepts only keys that start with "${FAKE_KEY_PREFIX}".`);
    }
    const upload = state.uploads.get(id);
    if (!upload) return apiError(404, "NOT_FOUND", "Upload not found.");
    const command = String(req.headers["x-goog-upload-command"] ?? "");
    const offset = Number(req.headers["x-goog-upload-offset"] ?? 0);
    if (offset !== upload.bytes) return apiError(400, "INVALID_ARGUMENT", "Upload offset does not match the bytes received so far.");
    upload.chunks.push(body);
    upload.bytes += body.length;
    if (!/finalize/.test(command)) return reply(200, {}, { "x-goog-upload-status": "active" });

    const bytes = Buffer.concat(upload.chunks);
    state.uploads.delete(id);
    const name = `files/mock-file-${++state.filesStored}`;
    const meta = { name, mimeType: upload.mimeType, sizeBytes: String(bytes.length), state: "ACTIVE", uri: `http://${req.headers.host}/v1beta/${name}` };
    state.files.set(name, { meta, bytes, sha256: sha256(bytes) });
    record({ kind: "file-upload", fileName: name, bytes: bytes.length, audioSha256: sha256(bytes) });
    return reply(200, { file: meta }, { "x-goog-upload-status": "final" });
  }

  function handleGenerate(reply, apiError, body, model, keyInUrl) {
    let request = {};
    try {
      request = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      return apiError(400, "INVALID_ARGUMENT", "Request body is not JSON.");
    }
    const system = request.systemInstruction?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const parts = request.contents?.flatMap((c) => c.parts ?? []) ?? [];
    const answer = (payload) =>
      reply(200, { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(payload) }] }, finishReason: "STOP", index: 0 }], modelVersion: model });

    if (TRANSCRIBE_PROMPT.test(system)) {
      state.transcriptions += 1;
      let audio = null;
      let via = "none";
      let mimeType;
      const inline = parts.find((p) => p.inlineData)?.inlineData;
      const byReference = parts.find((p) => p.fileData)?.fileData;
      if (inline) {
        audio = Buffer.from(String(inline.data ?? ""), "base64");
        via = "inline";
        mimeType = inline.mimeType;
      } else if (byReference) {
        const name = String(byReference.fileUri ?? "").match(/\/v1beta\/(files\/[a-z0-9-]+)$/)?.[1];
        const stored = name ? state.files.get(name) : undefined;
        if (!stored) {
          record({ kind: "rejected", reason: "unknown-file-reference" });
          return apiError(404, "NOT_FOUND", "The referenced file does not exist.");
        }
        audio = stored.bytes;
        via = "file";
        mimeType = byReference.mimeType;
      }
      const failing = failFirst && state.transcriptions === 1;
      record({
        kind: "transcribe",
        model,
        via,
        audioBytes: audio?.length ?? 0,
        audioSha256: audio ? sha256(audio) : null,
        mimeType: mimeType ?? null,
        apiKey: "fake",
        keyInUrl,
        answered: failing ? 503 : 200,
      });
      if (failing) return apiError(503, "UNAVAILABLE", "The model is overloaded. Please try again later.");
      return answer(TRANSCRIPT_RESPONSE);
    }

    if (NOTE_PROMPT.test(system)) {
      const text = parts.map((p) => p.text ?? "").join("");
      record({
        kind: "note",
        model,
        // The note is drafted from the transcript alone. If audio ever shows up here, the check reports it.
        hasAudio: parts.some((p) => p.inlineData || p.fileData),
        transcriptLines: (text.match(/^\[\d+\]/gm) ?? []).length,
        apiKey: "fake",
        keyInUrl,
        answered: 200,
      });
      return answer(NOTE_RESPONSE);
    }

    record({ kind: "unknown", method: "POST", path: `/v1beta/models/${model}:generateContent`, reason: "instructions-not-recognised" });
    return apiError(400, "INVALID_ARGUMENT", "The stand-in does not recognise these instructions (it only knows the transcription and the clinical-note prompts).");
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 500, message: "stand-in error", status: "INTERNAL" } }));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, LISTEN_HOST, () => {
      const actual = server.address().port;
      record({ kind: "listening", failFirst });
      resolve({
        server,
        port: actual,
        url: `http://${LISTEN_HOST}:${actual}`,
        requests: () => [...state.log],
        close: () => new Promise((done) => (server.closeAllConnections?.(), server.close(() => done()))),
      });
    });
  });
}

function parseArgs(argv) {
  const out = { port: 3299, logFile: undefined, failFirst: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg === "--log") out.logFile = argv[++i];
    else if (arg === "--fail-first") out.failFirst = true;
    else throw new Error(`Unknown option ${arg}. Usage: node scripts/fake-gemini.mjs [--port 3299] [--log file.jsonl] [--fail-first]`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error("--port must be a whole number from 0 to 65535.");
  return out;
}

async function main(argv) {
  const options = parseArgs(argv);
  // From the command line the stand-in also refuses every outgoing connection (see scripts/loopback-only.cjs).
  createRequire(import.meta.url)("./loopback-only.cjs");
  let mock;
  const stop = () => {
    (mock ? mock.close() : Promise.resolve()).finally(() => process.exit(0));
  };
  mock = await startFakeGemini({ ...options, token: process.env.FAKE_GEMINI_SHUTDOWN_TOKEN || undefined, onShutdown: stop });
  console.log(`fake-gemini listening on ${mock.url}: fake keys only, no outgoing connections${options.failFirst ? ", first transcription fails once" : ""}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
