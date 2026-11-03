#!/usr/bin/env node
// Isolated mock testing of Doctor Consultations: the real app, a throwaway database, a throwaway audio folder, and a stand-in for Gemini.
//
//   npm run mock:start                 build nothing, touch nothing of yours: starts the stand-in (scripts/fake-gemini.mjs) and a SECOND copy of
//                                      the app on http://127.0.0.1:3400, then checks that the stand-in really is the AI being used. Stays running.
//   npm run mock:start -- --db copy    the same, but the test database starts as a read-only copy of your real one (default: an empty database)
//   npm run mock:status                is it running, and where
//   npm run mock:check                 records a fake consultation through the running copy and proves what the stand-in received
//   npm run mock:stop                  stops both (Ctrl+C in the window that is running them does the same)
//
// How it keeps your real setup safe (tests/mock-consultations.test.ts covers each point):
//   - It never reads your .env. The app under test is started with an environment BUILT HERE: a short list of harmless variables
//     (PATH and the like) from yours, plus explicit settings. Variables that would carry a real secret or reach a real service are set
//     to empty, which stops the app's own .env loader from filling them in. GEMINI_API_KEY is replaced by a fake key.
//   - The test app's database (DATA_DIR) and audio folder live under data-mock/, never under your data/. They are checked not to overlap.
//     With --db copy your database is opened READ-ONLY, only to write a separate copy; it is never modified, migrated or locked.
//   - The consultation settings (encryption key, provider, review, region) exist only in the environment of the test app's process.
//     Nothing is written to .env, and the feature is switched on only inside the test database.
//   - The AI is the stand-in on 127.0.0.1, which accepts only "fake-" keys and cannot make a network request. The test app and this
//     launcher are also started with scripts/loopback-only.cjs, which refuses any outgoing connection that is not to this computer,
//     so even a misconfigured test could not send a recording anywhere.
//   - Nothing is deleted. The throwaway data stays in data-mock/ (ignored by git) until you remove that folder yourself.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_API_KEY, MOCK_REMARK, NOTE_RESPONSE, TRANSCRIPT_RESPONSE } from "./fake-gemini.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..");
export const GUARD_PATH = path.join(HERE, "loopback-only.cjs");

export const DEFAULT_APP_PORT = 3400;
export const DEFAULT_MOCK_PORT = 3299;
export const MOCK_MODELS = { transcription: "mock-transcription-model", note: "mock-note-model", chat: "mock-chat-model" };

// ── Where things live ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function mockPaths(repoRoot = REPO_ROOT) {
  const root = path.join(repoRoot, "data-mock");
  const run = path.join(root, "run");
  return {
    root,
    db: path.join(root, "db"),
    audio: path.join(root, "audio"),
    run,
    tmp: path.join(run, "tmp"),
    state: path.join(run, "state.json"),
    secrets: path.join(run, "secrets.json"),
    meta: path.join(run, "meta.json"),
    mockRequests: path.join(run, "mock-requests.jsonl"),
    mockOut: path.join(run, "mock.log"),
    appOut: path.join(run, "app.log"),
    credentials: path.join(root, "CREDENTIALS.txt"),
  };
}

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** The test data must not share a single byte of folder with your real data. Throws, naming the problem, if it could. */
export function assertIsolated(paths, realDataDir) {
  const real = path.resolve(realDataDir);
  for (const [label, p] of [["data-mock", paths.root], ["test database folder", paths.db], ["test audio folder", paths.audio]]) {
    if (inside(p, real) || inside(real, p)) throw new Error(`Refusing to start: the ${label} (${p}) overlaps your real data folder (${real}).`);
  }
  if (path.resolve(paths.db) === path.resolve(paths.audio)) throw new Error("Refusing to start: the test database and test audio folders are the same folder.");
}

export function validatePorts(appPort, mockPort) {
  for (const [label, port] of [["app", appPort], ["mock", mockPort]]) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`The ${label} port must be a whole number from 1024 to 65535.`);
  }
  if (appPort === mockPort) throw new Error("The app and the stand-in need different ports.");
  if ([appPort, mockPort].includes(3000)) throw new Error("Port 3000 is where your normal app runs. Choose another port.");
}

// ── The environment of the app under test ───────────────────────────────────────────────────────────────────────────────────────────

/** Variables copied from the launching shell: plumbing the programs need to run at all. Nothing that names a key, a path to your data, or a proxy. */
const PASS_THROUGH = new Set(
  ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMPUTERNAME", "USERNAME", "LANG", "LC_ALL"],
);

export function passThroughEnv(parentEnv) {
  const kept = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && PASS_THROUGH.has(name.toUpperCase())) kept[name] = value;
  }
  return kept;
}

/**
 * Variables set to EMPTY in the test app's environment. Next.js fills a variable from .env only when the process was started without it,
 * and an empty value counts as "started with it", so this keeps your real values out without this launcher ever opening .env.
 * (tests/mock-consultations.test.ts proves that on this operating system, and that every secret-like setting the app knows is covered.)
 */
export const BLOCKED_ENV = [
  "OPENAI_API_KEY", "OPENAI_MODEL", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "GEMINI_STT_MODEL",
  "INTEGRATIONS_ENCRYPTION_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET",
  "DEMO_USER_PASSWORD", "DEMO_SHOW_CREDENTIALS",
  // Read by the Google client library itself.
  "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_VERTEX_BASE_URL",
];

const posix = (p) => p.replace(/\\/g, "/");
const last4 = (value) => value.slice(-4);

/** The complete environment of the app under test. `parentEnv` is only ever filtered through PASS_THROUGH. */
export function buildMockEnv({ paths, appPort, mockPort, secrets, parentEnv = process.env }) {
  return {
    ...passThroughEnv(parentEnv),
    ...Object.fromEntries(BLOCKED_ENV.map((name) => [name, ""])),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    // Quoted with forward slashes: NODE_OPTIONS treats a backslash inside quotes as an escape.
    NODE_OPTIONS: `--require "${posix(GUARD_PATH)}"`,
    TEMP: paths.tmp,
    TMP: paths.tmp,
    // Where the test data lives (never your data/ folder).
    DATA_DIR: paths.db,
    CONSULTATIONS_AUDIO_DIR: paths.audio,
    APP_BASE_URL: `http://127.0.0.1:${appPort}`,
    TRUSTED_PROXY_HOPS: "0",
    // Throwaway sign-in for the test database.
    BOOTSTRAP_OWNER_EMAIL: secrets.ownerEmail,
    BOOTSTRAP_OWNER_PASSWORD: secrets.ownerPassword,
    BOOTSTRAP_OWNER_NAME: "Mock owner",
    // The AI is the stand-in, reached through a fake key and a local address.
    GEMINI_API_KEY: FAKE_API_KEY,
    GEMINI_MODEL: MOCK_MODELS.chat,
    DEFAULT_AI_PROVIDER: "gemini",
    GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${mockPort}`,
    GEMINI_TTS_ENABLED: "false",
    VOICE_INPUT_ENABLED: "false",
    // The consultation settings: they exist only in this process's environment.
    CONSULTATIONS_ENCRYPTION_KEY: secrets.encryptionKey,
    CONSULTATIONS_TRANSCRIPTION_PROVIDER: "gemini",
    CONSULTATIONS_TRANSCRIPTION_MODEL: MOCK_MODELS.transcription,
    CONSULTATIONS_NOTE_MODEL: MOCK_MODELS.note,
    CONSULTATIONS_PROVIDER_REVIEW: "MOCK TEST ONLY: no real provider was reviewed (stand-in on localhost)",
    CONSULTATIONS_PROVIDER_REGION: "none: stand-in on this computer, nothing leaves it",
    CONSULTATIONS_WORKER: "true",
  };
}

/** The stand-in gets even less: no keys, no data paths, only what it needs to run and (optionally) the token that lets `mock:stop` shut it down. */
export function buildMockServerEnv({ shutdownToken, parentEnv = process.env }) {
  return { ...passThroughEnv(parentEnv), NODE_ENV: "production", FAKE_GEMINI_SHUTDOWN_TOKEN: shutdownToken };
}

// ── Throwaway secrets (made once per test folder; they only work in that test database) ────────────────────────────────────────────

export function generateSecrets(random = crypto.randomBytes) {
  const passphrase = () => random(18).toString("base64url");
  return {
    encryptionKey: random(32).toString("base64"),
    ownerEmail: "mock-owner@mock.test",
    ownerPassword: passphrase(),
    doctorEmail: "mock-doctor@mock.test",
    doctorPassword: passphrase(),
    shutdownToken: random(16).toString("hex"),
  };
}

function loadOrCreateSecrets(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.secrets, "utf8"));
  } catch {
    const secrets = generateSecrets();
    fs.mkdirSync(paths.run, { recursive: true });
    fs.writeFileSync(paths.secrets, JSON.stringify(secrets, null, 2));
    return secrets;
  }
}

function writeCredentials(paths, secrets, appPort) {
  fs.writeFileSync(
    paths.credentials,
    [
      `Throwaway accounts for the MOCK-TESTING copy of the app only: http://127.0.0.1:${appPort}`,
      "They do not exist in your real app. This folder (data-mock) is ignored by git. Do not reuse these passwords anywhere.",
      "",
      `Doctor (records consultations)        email: ${secrets.doctorEmail}    password: ${secrets.doctorPassword}`,
      `Owner and Super Admin (team, features) email: ${secrets.ownerEmail}     password: ${secrets.ownerPassword}`,
      "",
    ].join("\n"),
  );
}

// ── The test database ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Writes a separate copy of the real database. The real file is opened READ-ONLY and only read (VACUUM INTO writes the new file, a
 * consistent snapshot even while your app is running); it is never modified, migrated or locked for writing.
 */
export async function copyRealDatabase({ realDataDir, destDir }) {
  const source = path.join(realDataDir, "kb.sqlite");
  if (!fs.existsSync(source)) throw new Error(`No database at ${source}: nothing to copy. Use the default (an empty test database) instead.`);
  const dest = path.join(destDir, "kb.sqlite");
  if (fs.existsSync(dest)) throw new Error(`${dest} already exists; refusing to overwrite it.`);
  fs.mkdirSync(destDir, { recursive: true });
  const { default: Database } = await import("better-sqlite3");
  const real = new Database(source, { readonly: true, fileMustExist: true });
  try {
    real.prepare("VACUUM INTO ?").run(dest);
  } finally {
    real.close();
  }
  return dest;
}

/** Makes the copy usable on its own: the throwaway owner can sign in, and nobody's real sign-in session comes along. Touches the COPY only. */
export async function prepareCopy({ dbFile, secrets }) {
  const { default: Database } = await import("better-sqlite3");
  const { recoverOwner } = await import("./owner-recover.mjs");
  const db = new Database(dbFile);
  try {
    db.prepare("DELETE FROM auth_sessions").run();
    recoverOwner(db, { email: secrets.ownerEmail, password: secrets.ownerPassword, name: "Mock owner", apply: true, resetPassword: true });
  } finally {
    db.close();
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(test, { timeoutMs, everyMs = 400 }) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await test();
      if (value) return value;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) return null;
    await sleep(everyMs);
  }
}

async function request(base, method, pathname, { cookie, body, headers = {}, timeoutMs = 30_000 } = {}) {
  const isRaw = Buffer.isBuffer(body) || typeof body === "string";
  const res = await fetch(base + pathname, {
    method,
    headers: { ...(body !== undefined && !isRaw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : isRaw ? body : JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function signIn(base, email, password) {
  const res = await request(base, "POST", "/api/auth/login", { body: { email, password } });
  if (res.status !== 200) return null;
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ") || null;
}

function portAnswers(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
};

function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

function countFiles(dir) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  return n;
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs);
  }
  return newest;
}

/** A 1.5-second 440 Hz tone as a WAV file: a fake "recording" with nothing of anyone in it, small enough to upload in one part. */
export function makeTestWav({ seconds = 1.5, sampleRate = 8000 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── Checks: is the stand-in really the AI in use? ───────────────────────────────────────────────────────────────────────────────────

function newChecks() {
  const results = [];
  return {
    results,
    check(name, ok, detail = "") {
      results.push({ name, ok: !!ok, detail });
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` (${detail})` : ""}`);
      return !!ok;
    },
  };
}

/**
 * Records a fake consultation through the RUNNING test app and proves, from the stand-in's own record, what it received. Creates and then
 * deletes one consultation labelled "MOCK CHECK". Returns true when every check passed.
 */
export async function runChecks({ appBase, mockBase, paths, secrets, realDataDir }) {
  const { results, check } = newChecks();
  const mockLog = async () => (await request(mockBase, "GET", "/__mock/requests")).json?.requests ?? [];

  // 1. The stand-in answers, says what it is, and refuses anything that is not a fake key.
  const identity = (await request(mockBase, "GET", "/__mock/identity")).json;
  check("the AI on the mock port is the stand-in (fake-gemini), which makes no outgoing connections", identity?.service === "fake-gemini" && identity.outbound === "none");
  const refused = await request(mockBase, "POST", `/v1beta/models/${MOCK_MODELS.note}:generateContent`, { body: {}, headers: { "x-goog-api-key": "AIzaSy-this-is-not-a-real-key-just-a-test-value" } });
  check("the stand-in refuses a key that does not start with fake-", refused.status === 401);

  // 2. The test app can sign in with the throwaway accounts: they exist only in the test database, so this proves which database it uses.
  const owner = await signIn(appBase, secrets.ownerEmail, secrets.ownerPassword);
  check("the test app uses the test database (the throwaway owner can sign in)", !!owner);
  if (!owner) return finish(results);

  // 3. Which AI key does the test app hold? Only the last four characters are ever shown, and they have to be the fake key's.
  const ai = (await request(appBase, "GET", "/api/settings/ai", { cookie: owner })).json;
  const gemini = ai?.providers?.find((p) => p.provider === "gemini");
  const others = (ai?.providers ?? []).filter((p) => p.provider !== "gemini");
  check("the test app's Gemini key is the fake key", gemini?.key?.configured === true && gemini.key.last4 === last4(FAKE_API_KEY), gemini?.key?.last4 ? `ends in ${gemini.key.last4}` : "no key");
  check("no other AI provider has a key in the test app", others.length > 0 && others.every((p) => p.key?.configured === false), `${others.length} others checked`);

  // 4. A fake consultation, end to end.
  const doctor = await signIn(appBase, secrets.doctorEmail, secrets.doctorPassword);
  check("the throwaway doctor can sign in to the test app", !!doctor);
  if (!doctor) return finish(results);

  const overview = (await request(appBase, "GET", "/api/consultations", { cookie: doctor })).json;
  check("the consultations feature is on in the test app", !!overview?.consentVersion);
  if (!overview?.consentVersion) return finish(results);

  const audioBefore = countFiles(paths.audio);
  const realAudioBefore = countFiles(path.join(realDataDir, "consultation-audio"));
  const logBefore = await mockLog();
  const since = logBefore.at(-1)?.seq ?? 0;

  const created = await request(appBase, "POST", "/api/consultations", {
    cookie: doctor,
    body: { patientLabel: "MOCK CHECK (fake patient)", languageHint: "mixed", consent: { version: overview.consentVersion, language: "en", givenBy: "patient", method: "verbal", confirmed: true } },
  });
  const id = created.json?.consultation?.id;
  check("a fake consultation was created with its consent", created.status < 300 && !!id, `HTTP ${created.status}`);
  if (!id) return finish(results);

  const wav = makeTestWav();
  const wavSha = crypto.createHash("sha256").update(wav).digest("hex");
  const started = await request(appBase, "POST", `/api/consultations/${id}/recording`, { cookie: doctor, body: { mimeType: "audio/wav" } });
  const part = await request(appBase, "PUT", `/api/consultations/${id}/recording/parts/1`, { cookie: doctor, body: wav, headers: { "content-type": "application/octet-stream" } });
  const completed = await request(appBase, "POST", `/api/consultations/${id}/recording/complete`, { cookie: doctor, body: { totalBytes: wav.length, partCount: 1, durationMs: 1500, sha256: wavSha } });
  check("the fake recording was uploaded and stored", started.status < 300 && part.status < 300 && completed.status < 300, `${wav.length} bytes`);

  const finalStatus = await waitFor(async () => {
    const detail = (await request(appBase, "GET", `/api/consultations/${id}`, { cookie: doctor })).json?.consultation;
    return detail && ["needs_review", "failed"].includes(detail.status) ? detail.status : null;
  }, { timeoutMs: 120_000, everyMs: 2000 });
  check("the background worker processed it and a draft note is waiting for the doctor", finalStatus === "needs_review", `status: ${finalStatus ?? "timed out"}`);

  // 5. What the stand-in says it received.
  const added = (await mockLog()).filter((e) => e.seq > since);
  const transcribed = added.filter((e) => e.kind === "transcribe");
  const drafted = added.filter((e) => e.kind === "note");
  const last = transcribed.at(-1);
  check("the stand-in was asked to transcribe, with the fake key", transcribed.length >= 1 && transcribed.every((e) => e.apiKey === "fake"), `${transcribed.length} request(s)`);
  check("the stand-in received exactly the recording that was uploaded (same fingerprint and size)", last?.audioSha256 === wavSha && last?.audioBytes === wav.length, last ? `${last.audioBytes} bytes, sent ${last.via}` : "no request");
  check("the stand-in was asked to draft the note from the transcript only (no audio)", drafted.length >= 1 && drafted.every((e) => e.hasAudio === false && e.transcriptLines === TRANSCRIPT_RESPONSE.segments.length), `${drafted.length} request(s)`);
  check("the stand-in refused nothing and was asked nothing it did not understand", !added.some((e) => e.kind === "rejected" || e.kind === "unknown"));

  // 6. What the app stored came from the stand-in.
  const transcript = (await request(appBase, "GET", `/api/consultations/${id}/transcript`, { cookie: doctor })).json;
  const note = (await request(appBase, "GET", `/api/consultations/${id}/note`, { cookie: doctor })).json;
  check(
    "the stored transcript is the stand-in's fixed text, produced by a mock model",
    transcript?.model === MOCK_MODELS.transcription && transcript.content?.segments?.length === TRANSCRIPT_RESPONSE.segments.length && transcript.content.segments[0].text === TRANSCRIPT_RESPONSE.segments[0].text && transcript.content.remarks?.includes(MOCK_REMARK),
    `model: ${transcript?.model ?? "none"}`,
  );
  const items = (note?.content?.sections ?? []).flatMap((s) => s.items);
  const expectedItems = NOTE_RESPONSE.sections.flatMap((s) => s.items).length;
  check("the stored note is the stand-in's fixed draft, waiting for the doctor's approval", note?.source === "ai" && note.needsApproval === true && items.length === expectedItems, `${items.length} items`);

  // 7. Where the audio went.
  check("the test recording was sealed into the TEST audio folder", countFiles(paths.audio) > audioBefore, paths.audio);
  check("nothing was written to your real audio folder", countFiles(path.join(realDataDir, "consultation-audio")) === realAudioBefore);

  // 8. Tidy up the one consultation this check made (the doctor's own delete: audio, transcript and note go with it).
  const removed = await request(appBase, "DELETE", `/api/consultations/${id}`, { cookie: doctor, body: { confirm: true } });
  check("the check's own consultation was deleted again, audio included", removed.status < 300 && countFiles(paths.audio) <= audioBefore, `HTTP ${removed.status}`);

  return finish(results);
}

function finish(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(failed.length === 0 ? `\nAll ${results.length} checks passed: the stand-in is the AI in use, and the test app is isolated.` : `\n${failed.length} of ${results.length} checks FAILED.`);
  return failed.length === 0;
}

// ── Seeding the test app through its own API ────────────────────────────────────────────────────────────────────────────────────────

/** Makes the running test app ready to use: the feature on, and a Doctor account. Uses the same API as the Settings pages; safe to repeat. */
async function seed({ appBase, secrets }) {
  const owner = await signIn(appBase, secrets.ownerEmail, secrets.ownerPassword);
  if (!owner) throw new Error("The throwaway owner cannot sign in to the test app. If data-mock/ was made by an older run with different secrets, remove the data-mock folder (yourself) and start again.");
  const flag = await request(appBase, "PUT", "/api/features/consultations", { cookie: owner, body: { enabled: true } });
  if (flag.status >= 300) throw new Error(`Could not switch the consultations feature on inside the test app (HTTP ${flag.status}).`);
  if (await signIn(appBase, secrets.doctorEmail, secrets.doctorPassword)) return;
  const invite = await request(appBase, "POST", "/api/org/invitations", { cookie: owner, body: { email: secrets.doctorEmail, role: "doctor" } });
  const token = invite.json?.url ? new URL(invite.json.url).searchParams.get("token") : null;
  if (invite.status >= 300 || !token) throw new Error(`Could not invite the throwaway doctor (HTTP ${invite.status}).`);
  const accepted = await request(appBase, "POST", "/api/auth/accept-invite", { body: { token, password: secrets.doctorPassword, name: "Mock doctor" } });
  if (accepted.status >= 300) throw new Error(`The throwaway doctor could not accept the invitation (HTTP ${accepted.status}).`);
}

// ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { command: argv[0], db: "fresh", appPort: DEFAULT_APP_PORT, mockPort: DEFAULT_MOCK_PORT, failFirst: false, realDataDir: path.join(REPO_ROOT, "data") };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") out.db = argv[++i];
    else if (arg === "--app-port") out.appPort = Number(argv[++i]);
    else if (arg === "--mock-port") out.mockPort = Number(argv[++i]);
    else if (arg === "--real-data-dir") out.realDataDir = path.resolve(argv[++i] ?? "");
    else if (arg === "--fail-first") out.failFirst = true;
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (!["fresh", "copy"].includes(out.db)) throw new Error('--db must be "fresh" (an empty test database, the default) or "copy" (a read-only copy of your real database).');
  return out;
}

function readState(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.state, "utf8"));
  } catch {
    return null;
  }
}

async function start(opts) {
  const paths = mockPaths();
  validatePorts(opts.appPort, opts.mockPort);
  assertIsolated(paths, opts.realDataDir);

  const existing = readState(paths);
  if (existing && isAlive(existing.launcherPid)) throw new Error(`Mock testing is already running (process ${existing.launcherPid}). Use "npm run mock:status", or "npm run mock:stop" to stop it.`);
  for (const [label, port] of [["app", opts.appPort], ["stand-in", opts.mockPort]]) {
    if (await portAnswers(port)) throw new Error(`Port ${port} (the ${label}) is already in use by another program. Stop it or choose another port (--app-port / --mock-port).`);
  }

  const buildId = path.join(REPO_ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildId)) throw new Error('There is no production build to run. Build it once with "npm run build" (stop your dev server first if you like; the build writes only to .next).');
  if (newestMtime(path.join(REPO_ROOT, "src")) > fs.statSync(buildId).mtimeMs) console.warn("Note: src/ has changed since the last build, so the test app is running OLDER code than your source. Run \"npm run build\" to refresh it.");

  fs.mkdirSync(paths.run, { recursive: true });
  fs.mkdirSync(paths.tmp, { recursive: true });
  fs.mkdirSync(paths.audio, { recursive: true });
  fs.mkdirSync(paths.db, { recursive: true });

  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(paths.meta, "utf8"));
  } catch {
    /* first run */
  }
  if (meta && meta.mode !== opts.db) throw new Error(`data-mock/ was made with --db ${meta.mode}, not --db ${opts.db}. Keep using --db ${meta.mode}, or remove the data-mock folder yourself (it holds only throwaway test data) and start again.`);

  const secrets = loadOrCreateSecrets(paths);
  const dbFile = path.join(paths.db, "kb.sqlite");
  if (!fs.existsSync(dbFile) && opts.db === "copy") {
    console.log("Copying your real database (read-only) into the test folder...");
    await copyRealDatabase({ realDataDir: opts.realDataDir, destDir: paths.db });
    await prepareCopy({ dbFile, secrets });
  }
  fs.writeFileSync(paths.meta, JSON.stringify({ mode: opts.db, createdAt: meta?.createdAt ?? new Date().toISOString() }, null, 2));
  writeCredentials(paths, secrets, opts.appPort);

  const appBase = `http://127.0.0.1:${opts.appPort}`;
  const mockBase = `http://127.0.0.1:${opts.mockPort}`;
  const children = [];
  let stopping = false;
  const shutdown = (code = 0) => {
    stopping = true;
    for (const child of children) killTree(child);
    try {
      fs.rmSync(paths.state, { force: true });
    } catch {
      /* best effort */
    }
    process.exit(code);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(signal, () => shutdown(0));
  process.on("exit", () => children.forEach(killTree));

  // The stand-in first (it must be answering before the app is asked anything).
  const mockOut = fs.openSync(paths.mockOut, "a");
  const mock = spawn(process.execPath, [path.join(HERE, "fake-gemini.mjs"), "--port", String(opts.mockPort), "--log", paths.mockRequests, ...(opts.failFirst ? ["--fail-first"] : [])], {
    env: buildMockServerEnv({ shutdownToken: secrets.shutdownToken }),
    stdio: ["ignore", mockOut, mockOut],
    windowsHide: true,
  });
  children.push(mock);
  const mockUp = await waitFor(async () => (await request(mockBase, "GET", "/__mock/identity", { timeoutMs: 2000 })).json?.service === "fake-gemini", { timeoutMs: 20_000 });
  if (!mockUp) {
    console.error(`The stand-in did not start.\n${tail(paths.mockOut)}`);
    return shutdown(1);
  }

  const appOut = fs.openSync(paths.appOut, "a");
  const nextBin = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
  const app = spawn(process.execPath, [nextBin, "start", "-p", String(opts.appPort), "-H", "127.0.0.1"], {
    cwd: REPO_ROOT,
    env: buildMockEnv({ paths, appPort: opts.appPort, mockPort: opts.mockPort, secrets }),
    stdio: ["ignore", appOut, appOut],
    windowsHide: true,
  });
  children.push(app);
  for (const child of children) {
    child.once("exit", (code) => {
      if (stopping) return;
      // The stand-in exits with code 0 only when asked to (by "npm run mock:stop"): that is an orderly stop, not a failure.
      if (child === mock && code === 0) {
        console.log("\nStopped by \"npm run mock:stop\". Your test data is still in data-mock/.");
        return shutdown(0);
      }
      console.error(child === app ? `The test app stopped.\n${tail(paths.appOut)}` : `The stand-in stopped unexpectedly.\n${tail(paths.mockOut)}`);
      shutdown(1);
    });
  }
  console.log("Starting the test app (this takes a few seconds)...");
  const appUp = await waitFor(async () => (await request(appBase, "GET", "/login", { timeoutMs: 3000 })).status === 200, { timeoutMs: 120_000, everyMs: 1000 });
  if (!appUp) {
    console.error(`The test app did not come up.\n${tail(paths.appOut)}`);
    return shutdown(1);
  }

  fs.writeFileSync(paths.state, JSON.stringify({ launcherPid: process.pid, mockPid: mock.pid, appPid: app.pid, appPort: opts.appPort, mockPort: opts.mockPort, shutdownToken: secrets.shutdownToken, mode: opts.db, startedAt: new Date().toISOString() }, null, 2));

  try {
    await seed({ appBase, secrets });
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return shutdown(1);
  }

  console.log("\nChecking that the stand-in really is the AI in use...");
  const ok = await runChecks({ appBase, mockBase, paths, secrets, realDataDir: opts.realDataDir });
  if (!ok) {
    console.error("A check failed, so the test setup is NOT trustworthy. Stopping it.");
    return shutdown(1);
  }

  console.log(
    [
      "",
      "Mock testing is running. Your normal app, .env and database were not touched.",
      `  Test app:        ${appBase}   (open this address, not localhost)`,
      `  Fake Gemini:     ${mockBase}   (what it received: ${paths.mockRequests})`,
      `  Test database:   ${paths.db}   (${opts.db === "copy" ? "a read-only copy of your real one" : "empty, created for this test"})`,
      `  Test audio:      ${paths.audio}`,
      `  Sign-in details: ${paths.credentials}   (throwaway accounts)`,
      "",
      "Stop it with Ctrl+C in this window, or run \"npm run mock:stop\" from another terminal.",
    ].join("\n"),
  );
  await new Promise(() => {}); // runs until shutdown() above
}

async function stop() {
  const paths = mockPaths();
  const state = readState(paths);
  if (!state) return console.log("Mock testing is not running (no record of it).");
  const launcherAlive = isAlive(state.launcherPid);
  if (launcherAlive) {
    try {
      await request(`http://127.0.0.1:${state.mockPort}`, "POST", "/__mock/shutdown", { headers: { "x-mock-token": state.shutdownToken }, timeoutMs: 5000 });
    } catch {
      /* the stand-in may already be gone; the launcher notices that too */
    }
    const gone = await waitFor(async () => !isAlive(state.launcherPid), { timeoutMs: 30_000, everyMs: 500 });
    if (!gone) {
      console.error(`It did not stop within 30 seconds. To stop it by hand:\n  ${process.platform === "win32" ? `taskkill /PID ${state.launcherPid} /T /F` : `kill ${state.launcherPid}`}`);
      process.exitCode = 1;
      return;
    }
  }
  const leftovers = [];
  if (await portAnswers(state.appPort)) leftovers.push(`the test app (port ${state.appPort}, process ${state.appPid})`);
  if (await portAnswers(state.mockPort)) leftovers.push(`the stand-in (port ${state.mockPort}, process ${state.mockPid})`);
  fs.rmSync(paths.state, { force: true });
  if (leftovers.length) {
    console.error(`Something is still listening: ${leftovers.join(" and ")}. To stop it by hand: ${process.platform === "win32" ? "taskkill /PID <process> /T /F" : "kill <process>"}`);
    process.exitCode = 1;
    return;
  }
  console.log("Stopped: the test app and the stand-in are no longer running. Your test data is still in data-mock/.");
}

async function status() {
  const paths = mockPaths();
  const state = readState(paths);
  if (!state || !isAlive(state.launcherPid)) return console.log("Mock testing is not running.");
  const mock = (await request(`http://127.0.0.1:${state.mockPort}`, "GET", "/__mock/identity", { timeoutMs: 3000 }).catch(() => null))?.json;
  const app = await request(`http://127.0.0.1:${state.appPort}`, "GET", "/login", { timeoutMs: 3000 }).catch(() => null);
  const calls = (await request(`http://127.0.0.1:${state.mockPort}`, "GET", "/__mock/requests", { timeoutMs: 3000 }).catch(() => null))?.json?.requests ?? [];
  console.log(
    [
      "Mock testing is running.",
      `  Test app:      http://127.0.0.1:${state.appPort}  ${app?.status === 200 ? "(answering)" : "(NOT answering)"}`,
      `  Fake Gemini:   http://127.0.0.1:${state.mockPort}  ${mock?.service === "fake-gemini" ? "(answering; fake keys only, no outgoing connections)" : "(NOT answering)"}`,
      `  Database mode: ${state.mode}   started: ${state.startedAt}`,
      `  The stand-in has handled ${calls.filter((c) => c.kind === "transcribe").length} transcription and ${calls.filter((c) => c.kind === "note").length} note request(s) since it started.`,
    ].join("\n"),
  );
}

async function check(opts) {
  const paths = mockPaths();
  const state = readState(paths);
  if (!state || !isAlive(state.launcherPid)) throw new Error('Mock testing is not running. Start it with "npm run mock:start" (in another terminal), then run this again.');
  const secrets = loadOrCreateSecrets(paths);
  console.log("Checking the running mock-testing setup...");
  const ok = await runChecks({ appBase: `http://127.0.0.1:${state.appPort}`, mockBase: `http://127.0.0.1:${state.mockPort}`, paths, secrets, realDataDir: opts.realDataDir });
  process.exitCode = ok ? 0 : 1;
}

const USAGE = `Usage: node scripts/mock-consultations.mjs <start|stop|status|check> [options]
  start    [--db fresh|copy] [--app-port ${DEFAULT_APP_PORT}] [--mock-port ${DEFAULT_MOCK_PORT}] [--fail-first] [--real-data-dir <folder>]
  stop
  status
  check    [--real-data-dir <folder>]`;

async function main(argv) {
  if (!["start", "stop", "status", "check"].includes(argv[0])) return console.log(USAGE);
  const opts = parseArgs(argv);
  // This launcher only ever talks to this computer; refuse anything else.
  createRequire(import.meta.url)("./loopback-only.cjs");
  if (opts.command === "start") return start(opts);
  if (opts.command === "stop") return stop();
  if (opts.command === "status") return status();
  return check(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
