import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD_MAX_LENGTH as SHARED_MAX, PASSWORD_MIN_LENGTH as SHARED_MIN } from "@/lib/password-policy";
import { ensureBootstrap } from "@/server/auth/bootstrap";
import { IdentityRepository } from "@/server/auth/identity";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, passwordProblem } from "@/server/auth/password";
import type { CreatedCustomerDTO } from "@/lib/types";
import { body, call, FAST_PASSWORDS, seedMember, seedOrganization, type Seeded } from "./harness";
import { memoryDb, testConfig } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/auth/password", async (importOriginal) => (await import("./helpers")).withFastPasswords(await importOriginal<typeof import("@/server/auth/password")>()));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return {
    getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })),
    isFeatureEnabled: () => true,
    getFeatureAvailability: () => ({}),
    getFeatureFlagService: () => ({}),
    defaultFeatureFlags: () => [],
  };
});

import * as acceptRoute from "@/app/api/auth/accept-invite/route";
import * as changePasswordRoute from "@/app/api/auth/change-password/route";
import * as loginRoute from "@/app/api/auth/login/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as orgInvitationsRoute from "@/app/api/org/invitations/route";
import * as platformOrgsRoute from "@/app/api/platform/organizations/route";

let db: Database.Database;
let P: Seeded;
let O: Seeded;
let counter = 0;
const fresh = (prefix: string) => `${prefix}-${++counter}@customer.test`;
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
/** A password of exactly this many characters (never the same character repeated, which is refused separately). */
const ofLength = (n: number) => "a1b2c3d4e5f6g7h8i9j0".repeat(Math.ceil(n / 20)).slice(0, n);
const userRow = (email: string) => db.prepare("SELECT id, password_hash, must_change_password AS m FROM users WHERE email = ?").get(email) as { id: string; password_hash: string; m: number };

const login = (email: string, password: string) => call(loginRoute.POST, "/api/auth/login", { method: "POST", json: { email, password } });
const change = (cookie: string, currentPassword: string, newPassword: string) => call(changePasswordRoute.POST, "/api/auth/change-password", { method: "POST", cookie, json: { currentPassword, newPassword } });

async function firstLogin(name: string) {
  const email = fresh("admin");
  const res = await call(platformOrgsRoute.POST, "/api/platform/organizations", { method: "POST", cookie: P.cookie, json: { name, adminEmail: email } });
  expect(res.status).toBe(201);
  const temporary = (await body<CreatedCustomerDTO>(res)).credentials!.temporaryPassword;
  const signedIn = await login(email, temporary);
  expect(signedIn.status).toBe(200);
  return { email, temporary, cookie: cookieFrom(signedIn) };
}

beforeEach(() => {
  db = memoryDb();
  h.db = db;
  const hq = seedOrganization(db, "Platform HQ");
  P = seedMember(db, hq, "super@platform.test", "owner", { platformAdmin: true });
  O = seedMember(db, seedOrganization(db, "Acme"), "owner@acme.test", "owner");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("the minimum password length is 4", () => {
  it("is one shared constant, used by the server and by the forms", () => {
    expect(SHARED_MIN).toBe(4);
    expect(PASSWORD_MIN_LENGTH).toBe(SHARED_MIN);
    expect(PASSWORD_MAX_LENGTH).toBe(SHARED_MAX);
  });

  it.each([
    [0, false],
    [3, false],
    [4, true],
    [5, true],
    [10, true],
    [200, true],
    [201, false],
  ])("a password of %i characters is accepted: %s", (length, accepted) => {
    const problem = passwordProblem(ofLength(length), "someone@example.test");
    expect(problem === null).toBe(accepted);
    if (!accepted && length < 4) expect(problem).toBe("Use at least 4 characters.");
    if (!accepted && length > 200) expect(problem).toBe("Use at most 200 characters.");
  });

  it("still refuses what was refused before: not a string, your own email address, and one repeated character", () => {
    expect(passwordProblem(undefined, "a@b.test")).toBe("Enter a password.");
    expect(passwordProblem("a@b.test", "A@B.test")).toMatch(/email/);
    expect(passwordProblem("aaaa", "a@b.test")).toMatch(/repetitive/);
    expect(passwordProblem("aaaaaaaaaaaaaaaa", "a@b.test")).toMatch(/repetitive/);
  });
});

describe("choosing a password through the real endpoints", () => {
  it("the forced first change refuses 3 characters (the temporary password stays valid) and accepts exactly 4", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");

    const tooShort = await change(cookie, temporary, ofLength(3));
    expect(tooShort.status).toBe(400);
    expect((await body<{ error: string }>(tooShort)).error).toBe("Use at least 4 characters.");
    expect(userRow(email).m).toBe(1); // nothing changed
    expect((await login(email, temporary)).status).toBe(200); // the temporary password still works

    const ok = await change(cookie, temporary, ofLength(4));
    expect(ok.status).toBe(200);
    expect(userRow(email).m).toBe(0);
    // Everything else about the change still happens: the temporary password is dead, the old sign-ins ended, the new one works.
    expect((await login(email, temporary)).status).toBe(401);
    expect((await call(meRoute.GET, "/api/auth/me", { cookie })).status).toBe(401);
    const signedIn = await login(email, ofLength(4));
    expect(signedIn.status).toBe(200);
    expect(await body(signedIn)).toMatchObject({ passwordChangeRequired: false });
    expect(userRow(email).password_hash).toMatch(/^scrypt\$/);
    expect((db.prepare("SELECT details FROM audit_log WHERE action = 'auth.password.change'").get() as { details: string }).details).toBe('{"forced":true}');
  });

  it("accepts 10 characters as before", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");
    expect((await change(cookie, temporary, ofLength(10))).status).toBe(200);
    expect((await login(email, ofLength(10))).status).toBe(200);
  });

  it("a person who already has a password can change it to 4 characters, and 3 is refused", async () => {
    const { email, temporary, cookie } = await firstLogin("Initech");
    const own = cookieFrom(await change(cookie, temporary, ofLength(8)));

    expect((await change(own, ofLength(8), ofLength(3))).status).toBe(400);
    expect((await login(email, ofLength(8))).status).toBe(200); // unchanged

    expect((await change(own, ofLength(8), "q9x!")).status).toBe(200);
    expect((await login(email, "q9x!")).status).toBe(200);
    expect((await login(email, ofLength(8))).status).toBe(401);
  });

  it("joining through an invitation: 3 characters are refused and the invitation is not used up, 4 are accepted", async () => {
    const invited = fresh("newbie");
    const created = await call(orgInvitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: O.cookie, json: { email: invited, role: "member" } });
    const token = new URL((await body<{ url: string }>(created)).url).searchParams.get("token")!;
    const accept = (password: string) => call(acceptRoute.POST, "/api/auth/accept-invite", { method: "POST", json: { token, password } });

    const tooShort = await accept(ofLength(3));
    expect(tooShort.status).toBe(400);
    expect((await body<{ error: string }>(tooShort)).error).toMatch(/at least 4/);
    expect(db.prepare("SELECT 1 FROM users WHERE email = ?").get(invited)).toBeUndefined();
    expect((await call(acceptRoute.GET, `/api/auth/accept-invite?token=${token}`)).status).toBe(200); // still valid

    expect((await accept(ofLength(4))).status).toBe(200);
    expect((await login(invited, ofLength(4))).status).toBe(200);
  });

  it("the first owner (BOOTSTRAP_OWNER_PASSWORD) follows the same rule", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const owner = { ...testConfig(), BOOTSTRAP_OWNER_EMAIL: "boss@example.test", DEMO_USER_PASSWORD: undefined };
    const tooShort = memoryDb();
    expect((await ensureBootstrap(tooShort, { ...owner, BOOTSTRAP_OWNER_PASSWORD: ofLength(3) }, FAST_PASSWORDS)).owner).toBe("rejected");
    expect(new IdentityRepository(tooShort).findUserByEmail("boss@example.test")).toBeUndefined();

    const ok = memoryDb();
    expect((await ensureBootstrap(ok, { ...owner, BOOTSTRAP_OWNER_PASSWORD: ofLength(4) }, FAST_PASSWORDS)).owner).toBe("created");
    expect(new IdentityRepository(ok).findUserByEmail("boss@example.test")).toBeDefined();
  });
});

describe("temporary passwords are unaffected", () => {
  it("are still long random strings (a short password is only ever a person's own choice), and still expire", async () => {
    const res = await call(platformOrgsRoute.POST, "/api/platform/organizations", { method: "POST", cookie: P.cookie, json: { name: "Initech", adminEmail: fresh("admin") } });
    const { credentials } = await body<CreatedCustomerDTO>(res);
    expect(credentials!.temporaryPassword).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
    expect(credentials!.temporaryPassword.length).toBe(19);
    const hours = (new Date(credentials!.expiresAt).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(71);
    expect(hours).toBeLessThan(73);
  });
});

describe("no other length rule is left in the code", () => {
  const ROOT = process.cwd();
  function walk(dir: string): string[] {
    return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const child = `${dir}/${e.name}`;
      return e.isDirectory() ? walk(child) : /\.(ts|tsx)$/.test(child) ? [child] : [];
    });
  }
  const sources = walk("src");
  const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

  it("the minimum is defined once, and nothing mentions the old 10-character rule", () => {
    expect(sources.filter((f) => /export const PASSWORD_MIN_LENGTH\s*=/.test(read(f)))).toEqual(["src/lib/password-policy.ts"]);
    for (const file of sources) {
      const code = read(file);
      expect(code, file).not.toMatch(/\b10 characters\b|\bat least 10\b/i);
      expect(code, file).not.toMatch(/minLength=\{\s*10\s*\}/);
    }
    for (const doc of ["README.md", ".env.example"]) expect(read(doc), doc).not.toMatch(/at least 10 characters|10 characters/i);
  });

  it("every form that creates or changes a password reads the shared constant instead of a number", () => {
    for (const form of ["src/components/auth/ChangePassword.tsx", "src/components/auth/AcceptInvite.tsx"]) {
      const code = read(form);
      expect(code, form).toMatch(/PASSWORD_MIN_LENGTH/);
      expect(code, form).not.toMatch(/(?:password|next)\.length\s*<\s*\d/);
    }
    expect(read("src/server/auth/password.ts")).toMatch(/password\.length < PASSWORD_MIN_LENGTH/);
  });
});
