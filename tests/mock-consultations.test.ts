import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import { getConfig, resetConfigForTests } from "@/server/config";
import { processingGate } from "@/server/consultations/gate";
import { sniffAudio } from "@/server/consultations/recording";
import { openDatabase } from "@/server/db/client";
import { FAST_PASSWORDS } from "./harness";
import * as launcher from "../scripts/mock-consultations.mjs";
import { FAKE_API_KEY } from "../scripts/fake-gemini.mjs";

// The mock-testing launcher (scripts/mock-consultations.mjs) starts a SECOND copy of the app with its own database, its own audio
// folder and a stand-in for Gemini. These tests pin down the promises it makes about your real setup: it never reads .env, it hands the
// test app an environment it built itself, nothing real can leak in, nothing of yours is written to, and the result is a configuration the
// app itself accepts, with the privacy gate open ONLY because of what the launcher sets.

// Every database the code under test opens, with the options it was opened with (the real class still does the work).
const opened = vi.hoisted(() => [] as { file: string; options: unknown }[]);
vi.mock("better-sqlite3", async (importOriginal) => {
  const original = (await importOriginal()) as { default: new (file: string, options?: unknown) => unknown };
  const Original = original.default;
  function Recording(file: string, options?: unknown) {
    opened.push({ file, options });
    return new Original(file, options);
  }
  Recording.prototype = Original.prototype;
  return { ...original, default: Recording };
});

const ROOT = launcher.REPO_ROOT;
const REAL_DATA = path.join(ROOT, "data");
const PORTS = { appPort: 3400, mockPort: 3299 };
const sentinel = (name: string) => `REAL-SECRET-SENTINEL-${name}`;

/** What a developer's shell might contain: real keys, a data folder, a proxy, node flags. None of it may reach the test app. */
const dirtyShell = {
  PATH: process.env.PATH ?? "/usr/bin",
  Path: process.env.PATH ?? "/usr/bin",
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  GEMINI_API_KEY: sentinel("GEMINI"),
  OPENAI_API_KEY: sentinel("OPENAI"),
  ANTHROPIC_API_KEY: sentinel("ANTHROPIC"),
  CONSULTATIONS_ENCRYPTION_KEY: sentinel("VAULT"),
  INTEGRATIONS_ENCRYPTION_KEY: sentinel("INTEGRATIONS"),
  GOOGLE_API_KEY: sentinel("GOOGLE"),
  GOOGLE_OAUTH_CLIENT_SECRET: sentinel("OAUTH"),
  BOOTSTRAP_OWNER_PASSWORD: sentinel("OWNER"),
  DEMO_USER_PASSWORD: sentinel("DEMO"),
  DATA_DIR: REAL_DATA,
  CONSULTATIONS_AUDIO_DIR: path.join(REAL_DATA, "consultation-audio"),
  GOOGLE_GEMINI_BASE_URL: "https://generativelanguage.googleapis.com",
  HTTPS_PROXY: "http://proxy.example:8080",
  HTTP_PROXY: "http://proxy.example:8080",
  NODE_OPTIONS: "--inspect=0.0.0.0:9229",
  CONSULTATIONS_PROVIDER_REVIEW: "a real review",
};

const paths = launcher.mockPaths();
const secrets = launcher.generateSecrets();
const built = () => launcher.buildMockEnv({ paths, ...PORTS, secrets, parentEnv: dirtyShell });

describe("the environment given to the test app", () => {
  it("contains nothing from the launching shell except harmless plumbing (no real key, proxy, data path or node flag)", () => {
    const env = built();
    const everything = JSON.stringify(env);
    expect(everything).not.toContain("SENTINEL");
    expect(everything).not.toContain("proxy.example");
    expect(everything).not.toContain("--inspect");
    expect(everything).not.toContain("a real review");
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.PATH).toBe(dirtyShell.PATH); // the programs still run
  });

  it("points the data, the audio and the app's own address at the test setup, never at the real data folder", () => {
    const env = built();
    expect(env.DATA_DIR).toBe(paths.db);
    expect(env.CONSULTATIONS_AUDIO_DIR).toBe(paths.audio);
    expect(env.TEMP).toBe(paths.tmp);
    expect(env.APP_BASE_URL).toBe("http://127.0.0.1:3400");
    for (const dir of [env.DATA_DIR, env.CONSULTATIONS_AUDIO_DIR, env.TEMP]) {
      const rel = path.relative(REAL_DATA, dir);
      expect(rel.startsWith("..") || path.isAbsolute(rel)).toBe(true);
    }
  });

  it("gives the AI client a fake key and a local address, and every web address in it is 127.0.0.1", () => {
    const env = built();
    expect(env.GEMINI_API_KEY).toBe(FAKE_API_KEY);
    expect(env.GEMINI_API_KEY.startsWith("fake-")).toBe(true);
    expect(env.GOOGLE_GEMINI_BASE_URL).toBe("http://127.0.0.1:3299");
    const addresses = Object.values(env).filter((v) => /^https?:\/\//.test(v));
    expect(addresses.length).toBeGreaterThan(1);
    for (const address of addresses) expect(new URL(address).hostname).toBe("127.0.0.1");
  });

  it("sets every secret-like setting the app knows to a generated or fake value, or to empty so .env cannot fill it in", () => {
    const names = [...fs.readFileSync(path.join(ROOT, "src/server/config.ts"), "utf8").matchAll(/^\s+([A-Z][A-Z0-9_]*(?:KEY|SECRET|PASSWORD|TOKEN))\s*:/gm)].map((m) => m[1] as string);
    expect(names).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_OAUTH_CLIENT_SECRET", "CONSULTATIONS_ENCRYPTION_KEY", "BOOTSTRAP_OWNER_PASSWORD", "DEMO_USER_PASSWORD"]));
    const env = built();
    const supplied: Record<string, string> = { GEMINI_API_KEY: FAKE_API_KEY, CONSULTATIONS_ENCRYPTION_KEY: secrets.encryptionKey, BOOTSTRAP_OWNER_PASSWORD: secrets.ownerPassword };
    for (const name of names) {
      expect(Object.hasOwn(env, name), `${name} is not set by the launcher, so a value in .env would reach the test app`).toBe(true);
      expect(env[name], name).toBe(supplied[name] ?? "");
    }
  });

  it("is a configuration the app itself accepts, with the privacy gate open only because of what the launcher sets", () => {
    const saved = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, built());
      resetConfigForTests();
      const config = getConfig();
      expect(config.DATA_DIR).toBe(paths.db);
      expect(config.CONSULTATIONS_AUDIO_DIR).toBe(paths.audio);
      expect(config.DEFAULT_AI_PROVIDER).toBe("gemini");
      expect(config.GEMINI_API_KEY).toBe(FAKE_API_KEY);
      expect([config.OPENAI_API_KEY, config.ANTHROPIC_API_KEY, config.INTEGRATIONS_ENCRYPTION_KEY, config.GOOGLE_OAUTH_CLIENT_SECRET, config.DEMO_USER_PASSWORD]).toEqual([undefined, undefined, undefined, undefined, undefined]);
      expect(config.CONSULTATIONS_TRANSCRIPTION_MODEL).toMatch(/^mock-/);
      expect(config.CONSULTATIONS_NOTE_MODEL).toMatch(/^mock-/);
      expect(config.CONSULTATIONS_PROVIDER_REVIEW).toMatch(/MOCK TEST ONLY/);
      expect(processingGate(config, config.GEMINI_API_KEY)).toEqual({ open: true, reason: null });
      // ...and without the launcher's settings the same gate is shut: the "open" above is not an accident of the defaults.
      expect(processingGate({ ...config, CONSULTATIONS_PROVIDER_REVIEW: undefined }, config.GEMINI_API_KEY).open).toBe(false);
      expect(processingGate({ ...config, CONSULTATIONS_ENCRYPTION_KEY: undefined }, config.GEMINI_API_KEY).open).toBe(false);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
      resetConfigForTests();
    }
  });

  it("really does keep .env values out: the app's own env loader, run on this operating system, leaves the blanks blank", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-env-"));
    fs.writeFileSync(path.join(dir, ".env"), [`OPENAI_API_KEY=${sentinel("OPENAI-FILE")}`, `GEMINI_API_KEY=${sentinel("GEMINI-FILE")}`, `DATA_DIR=${REAL_DATA}`, `GOOGLE_API_KEY=${sentinel("GOOGLE-FILE")}`, "UNRELATED_SETTING=kept"].join("\n"));
    const probe = path.join(dir, "probe.cjs");
    fs.writeFileSync(
      probe,
      `const { loadEnvConfig } = require(${JSON.stringify(path.join(ROOT, "node_modules", "@next", "env"))});
loadEnvConfig(process.argv[2], false, { info() {}, error() {} });
const e = process.env;
console.log(JSON.stringify({ openai: e.OPENAI_API_KEY || null, google: e.GOOGLE_API_KEY || null, gemini: e.GEMINI_API_KEY, data: e.DATA_DIR, unrelated: e.UNRELATED_SETTING }));`,
    );
    // Exactly how the launcher starts the app: an environment object, spawned as a child process.
    const out = execFileSync(process.execPath, [probe, dir], { env: built() as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
    expect(JSON.parse(out.trim())).toEqual({ openai: null, google: null, gemini: FAKE_API_KEY, data: paths.db, unrelated: "kept" });
    expect(out).not.toContain("SENTINEL");
  });

  it("loads the outgoing-connection guard into the app, with a path Node can parse on Windows", () => {
    const env = built();
    expect(env.NODE_OPTIONS).toBe(`--require "${launcher.GUARD_PATH.replace(/\\/g, "/")}"`);
    expect(fs.existsSync(launcher.GUARD_PATH)).toBe(true);
    expect(env.NODE_OPTIONS).not.toContain("\\");
  });
});

describe("the stand-in's environment", () => {
  it("has no keys and no data paths: only plumbing and the token that lets mock:stop shut it down", () => {
    const env = launcher.buildMockServerEnv({ shutdownToken: "tok", parentEnv: dirtyShell });
    const allowed = new Set(["PATH", "SYSTEMROOT", "NODE_ENV", "FAKE_GEMINI_SHUTDOWN_TOKEN"]);
    const names = Object.keys(env).map((k) => k.toUpperCase());
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    expect(names).toContain("FAKE_GEMINI_SHUTDOWN_TOKEN");
    expect(JSON.stringify(env)).not.toContain("SENTINEL");
    expect(env.FAKE_GEMINI_SHUTDOWN_TOKEN).toBe("tok");
  });
});

describe("keeping the test data apart from yours", () => {
  it("keeps the test database and audio inside data-mock/, a sibling of data/", () => {
    expect(paths.root).toBe(path.join(ROOT, "data-mock"));
    expect(() => launcher.assertIsolated(paths, REAL_DATA)).not.toThrow();
  });

  it.each([
    ["the real data folder is the test folder", paths.root],
    ["the real data folder is inside the test folder", paths.db],
    ["the test folder would be inside the real data folder", path.resolve(ROOT, "..")],
  ])("refuses to start when %s", (_name, realDir) => {
    expect(() => launcher.assertIsolated(paths, realDir)).toThrow(/overlaps your real data folder/);
  });

  it("refuses when the test audio would land inside the real data folder", () => {
    expect(() => launcher.assertIsolated({ ...paths, audio: path.join(REAL_DATA, "consultation-audio") }, REAL_DATA)).toThrow(/overlaps/);
  });

  it("refuses port 3000 (your normal app), equal ports and privileged ports", () => {
    expect(() => launcher.validatePorts(3400, 3299)).not.toThrow();
    expect(() => launcher.validatePorts(3000, 3299)).toThrow(/3000/);
    expect(() => launcher.validatePorts(3400, 3000)).toThrow(/3000/);
    expect(() => launcher.validatePorts(3400, 3400)).toThrow(/different ports/);
    expect(() => launcher.validatePorts(80, 3299)).toThrow(/1024/);
  });

  it("git ignores the test folder, and eslint skips it", () => {
    expect(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/)).toContain("data-mock/");
    expect(fs.readFileSync(path.join(ROOT, "eslint.config.mjs"), "utf8")).toContain('"data-mock/**"');
  });
});

describe("the launcher's own code", () => {
  const code = fs
    .readFileSync(path.join(ROOT, "scripts", "mock-consultations.mjs"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");

  it("never reads .env, and never passes its own environment through to a program it starts", () => {
    expect(code).not.toMatch(/dotenv|loadEnvConfig|readFileSync\([^)]*\.env|\.env["'`]/);
    expect(code).not.toMatch(/\.\.\.process\.env|env:\s*process\.env|Object\.assign\([^)]*process\.env/);
    // Every program it starts gets an environment from one of the two builders, and there are exactly two programs.
    expect(code.match(/\benv:/g)).toHaveLength(2);
    expect(code).toContain("env: buildMockServerEnv(");
    expect(code).toContain("env: buildMockEnv(");
  });

  it("starts nothing but the stand-in and the app, and deletes nothing but its own state file", () => {
    expect([...code.matchAll(/\bspawn\(([^,]+),/g)].map((m) => m[1]?.trim())).toEqual(["process.execPath", "process.execPath"]);
    expect(code).not.toMatch(/\brmSync\((?!paths\.state)/);
    expect(code).not.toMatch(/rmdirSync|unlinkSync|\.rm\(/);
    expect(code).not.toMatch(/writeFileSync\([^)]*(\.env|launch\.json|package\.json)/);
  });

  it("only ever talks to 127.0.0.1, and loads the outgoing-connection guard for itself", () => {
    expect(code).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
    expect(code).toMatch(/createRequire\(import\.meta\.url\)\("\.\/loopback-only\.cjs"\)/);
  });

  it("is wired to npm scripts, and the app is started on the loopback address only", () => {
    const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
    expect(scripts["mock:start"]).toBe("node scripts/mock-consultations.mjs start");
    expect(scripts["mock:stop"]).toBe("node scripts/mock-consultations.mjs stop");
    expect(scripts["mock:status"]).toBe("node scripts/mock-consultations.mjs status");
    expect(scripts["mock:check"]).toBe("node scripts/mock-consultations.mjs check");
    expect(scripts["mock:ai"]).toBe("node scripts/fake-gemini.mjs");
    expect(code).toMatch(/"start", "-p", String\(opts\.appPort\), "-H", "127\.0\.0\.1"/);
  });
});

describe("the fake recording", () => {
  it("is audio the app's own checks accept, small enough for one upload part, and the same every time", () => {
    const wav = launcher.makeTestWav();
    expect(sniffAudio(wav.subarray(0, 16))).toBe("audio/wav");
    expect(wav.length).toBe(44 + 1.5 * 8000 * 2);
    expect(wav.length).toBeLessThan(2 * 1024 * 1024);
    expect(launcher.makeTestWav().equals(wav)).toBe(true);
  });
});

describe("--db copy: a copy of the real database, made without touching it", () => {
  const open: Database.Database[] = [];
  afterEach(() => open.splice(0).forEach((db) => db.close()));
  const hash = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  it("copies a live database, makes the throwaway owner able to sign in, drops sign-in sessions, and leaves the original byte for byte alone", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mock-copy-"));
    const realDir = path.join(tmp, "data");
    fs.mkdirSync(realDir);
    const realFile = path.join(realDir, "kb.sqlite");
    // A "running app": a full-schema database in WAL mode that stays open (and so keeps its recent writes in the -wal file) during the copy.
    const real = openDatabase(realFile);
    open.push(real);
    await ensureBootstrap(real, { BOOTSTRAP_OWNER_EMAIL: "real.owner@real.test", BOOTSTRAP_OWNER_PASSWORD: "real owner passphrase", BOOTSTRAP_OWNER_NAME: "Real Owner", DEMO_USER_EMAIL: "demo@knowledgebase.ai", DEMO_USER_PASSWORD: undefined }, FAST_PASSWORDS);
    const realOwner = real.prepare("SELECT id FROM users WHERE email = 'real.owner@real.test'").get() as { id: string };
    real.prepare("INSERT INTO auth_sessions (token_hash, email, expires_at, user_id, org_id) VALUES ('hash-of-a-real-session', 'real.owner@real.test', '2999-01-01T00:00:00.000Z', ?, '00000000-0000-4000-8000-000000000001')").run(realOwner.id);
    const version = real.pragma("user_version", { simple: true });
    const before = { main: hash(realFile), wal: fs.statSync(realFile + "-wal").size };

    const destDir = path.join(tmp, "data-mock", "db");
    opened.length = 0;
    const dest = await launcher.copyRealDatabase({ realDataDir: realDir, destDir });
    // The original is opened exactly once during the copy, and read-only (SQLite quietly falls back to read-only on a write-protected file,
    // so the way to prove it is to look at how it was opened, not to try to make the write fail).
    expect(opened.filter((o) => path.resolve(o.file) === path.resolve(realFile))).toEqual([{ file: realFile, options: { readonly: true, fileMustExist: true } }]);
    expect(dest).toBe(path.join(destDir, "kb.sqlite"));
    await launcher.prepareCopy({ dbFile: dest, secrets });

    // The original: unchanged. Same file bytes, same journal, same version, no throwaway account, the real session still there.
    expect(hash(realFile)).toBe(before.main);
    expect(fs.statSync(realFile + "-wal").size).toBe(before.wal);
    expect(real.pragma("user_version", { simple: true })).toBe(version);
    expect(real.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(secrets.ownerEmail)).toEqual({ n: 0 });
    expect(real.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });

    // The copy: has the real data, plus the throwaway owner (Super Admin, owner of the Default workspace), and no sessions.
    const copy = openDatabase(dest);
    open.push(copy);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'real.owner@real.test'").get()).toEqual({ n: 1 });
    expect(copy.prepare("SELECT is_platform_admin AS admin FROM users WHERE email = ?").get(secrets.ownerEmail)).toEqual({ admin: 1 });
    expect(copy.prepare("SELECT m.role FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = ?").all(secrets.ownerEmail)).toEqual([{ role: "owner" }]);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
    expect(copy.pragma("user_version", { simple: true })).toBe(version);
  });

  it("refuses to overwrite an existing test database, and says so when there is nothing to copy", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mock-copy-"));
    await expect(launcher.copyRealDatabase({ realDataDir: path.join(tmp, "nothing"), destDir: path.join(tmp, "out") })).rejects.toThrow(/No database at/);
    const realDir = path.join(tmp, "data");
    fs.mkdirSync(realDir);
    openDatabase(path.join(realDir, "kb.sqlite")).close();
    const destDir = path.join(tmp, "out");
    await launcher.copyRealDatabase({ realDataDir: realDir, destDir });
    await expect(launcher.copyRealDatabase({ realDataDir: realDir, destDir })).rejects.toThrow(/already exists/);
  });
});
