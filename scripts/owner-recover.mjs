#!/usr/bin/env node
// Recovery for the owner account named in .env (BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD).
//
//   npm run owner:recover                      dry run: says what is wrong and what would change, changes nothing
//   npm run owner:recover -- --apply           makes those changes (after writing a backup copy of the database)
//   npm run owner:recover -- --apply --reset-password
//                                              also replaces the stored password with the one in .env
//
// Why this exists: the application reads BOOTSTRAP_OWNER_* only to CREATE the first owner. Editing them later never
// renames or re-passwords an existing account, and an address that is new to the database becomes a separate account
// that no workspace contains, so it can't sign in (it just shows "Invalid email or password"). This is the explicit,
// reviewed way to fix that: it only ever touches the ONE account named in .env, never another user, a customer's
// workspace, documents, chats or integrations, and it never demotes anybody.
//
// What --apply does, all in one transaction (nothing happens if any step fails), and only for steps that are needed:
//   1. creates the account if the address has none (password from .env, same length rules as the app);
//   2. replaces the stored password with the .env one, ONLY when --reset-password is given and the two differ
//      (the account's other sessions end, a pending "must change password" state is cleared);
//   3. enables the account if it was disabled;
//   4. if the account can't sign in to any workspace, makes it an owner of the Default workspace;
//   5. makes it a Super Admin (platform administrator);
//   6. writes one audit record (no password, no hash).
// It is safe to run again: when nothing is needed it changes nothing and writes nothing.
//
// The scrypt format and the password rules below mirror src/server/auth/password.ts; tests/owner-recovery.test.ts
// proves that hashes made here verify in the application and the other way round.

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 200;
export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1 };
/** The first schema version that has every column this script uses (users.must_change_password). */
export const MIN_SCHEMA_VERSION = 13;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

export const normalizeEmail = (email) => String(email).trim().toLowerCase();

/** "de***@example.org": enough to recognise an address in a log, never the whole thing. */
export function maskEmail(email) {
  const [local = "", domain] = String(email).split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
}

export function hashPassword(password, params = SCRYPT_PARAMS) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY });
  return ["scrypt", params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || expected.length !== KEY_BYTES) return false;
  const actual = crypto.scryptSync(password.normalize("NFKC"), salt, KEY_BYTES, { N, r, p, maxmem: MAX_MEMORY });
  return crypto.timingSafeEqual(actual, expected);
}

/** A message the person can act on, or null when the password is acceptable (same rules as the application). */
export function passwordProblem(password, email) {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < PASSWORD_MIN_LENGTH) return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password.trim().toLowerCase() === String(email).trim().toLowerCase()) return "The password can't be your email address.";
  if (/^(.)\1+$/.test(password)) return "Choose a less repetitive password.";
  return null;
}

/** What is true of the owner account right now. Facts only: no password, no hash. */
export function inspectOwner(db, { email, password }) {
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizeEmail(email));
  const workspaces = user
    ? db.prepare("SELECT o.id, o.name, o.status, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY m.created_at").all(user.id)
    : [];
  const defaultWorkspace = db.prepare("SELECT id, name, status FROM organizations WHERE id = ?").get(DEFAULT_ORG_ID);
  const otherSuperAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_platform_admin = 1 AND status = 'active' AND id IS NOT ?").get(user?.id ?? null).n;
  return {
    exists: !!user,
    userId: user?.id ?? null,
    status: user?.status ?? null,
    isSuperAdmin: user?.is_platform_admin === 1,
    mustChangePassword: user?.must_change_password === 1,
    passwordMatchesEnv: user ? verifyPassword(password, user.password_hash) : null,
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, role: w.role, status: w.status })),
    canSignIn: !!user && user.status === "active" && workspaces.some((w) => w.status === "active"),
    defaultWorkspace: defaultWorkspace ? { name: defaultWorkspace.name, status: defaultWorkspace.status } : null,
    otherSuperAdmins,
  };
}

/**
 * The changes --apply would make, in order. `blockers` are reasons nothing can be done safely (the plan is then empty);
 * `notes` are things worth knowing that need no change.
 */
export function planRecovery(facts, { email, password, resetPassword }) {
  const steps = [];
  const blockers = [];
  const notes = [];
  const problem = passwordProblem(password, email);

  if (!facts.exists) {
    if (problem) blockers.push(`BOOTSTRAP_OWNER_PASSWORD can't be used to create the account: ${problem}`);
    steps.push({ code: "create-account", text: "create the account with the password from .env" });
  } else if (!facts.passwordMatchesEnv) {
    if (resetPassword) {
      if (problem) blockers.push(`BOOTSTRAP_OWNER_PASSWORD can't be used as the new password: ${problem}`);
      steps.push({ code: "reset-password", text: "replace the stored password with the one in .env and end the account's open sessions" });
    } else {
      notes.push("The password in .env does NOT match the stored password. The application never changes an existing account's password from .env. Sign in with the password the account actually has, or run with --reset-password to make .env's password the account's password.");
    }
  }
  if (facts.exists && facts.status === "disabled") steps.push({ code: "enable-account", text: "enable the disabled account" });

  const needsWorkspace = !facts.canSignIn || !facts.workspaces.some((w) => w.status === "active");
  if (needsWorkspace) {
    if (!facts.defaultWorkspace) blockers.push("The Default workspace doesn't exist, so there is nowhere to put the account. Nothing was changed.");
    else if (facts.defaultWorkspace.status === "suspended") blockers.push(`The ${facts.defaultWorkspace.name} is suspended. Reactivate it from the Super Admin console (signed in as another Super Admin) first.`);
    else steps.push({ code: "join-default-workspace", text: `make the account an owner of the "${facts.defaultWorkspace.name}"` });
  }
  if (!facts.exists || !facts.isSuperAdmin) steps.push({ code: "make-super-admin", text: "make the account a Super Admin (platform administrator)" });
  if (facts.otherSuperAdmins > 0) notes.push(`${facts.otherSuperAdmins} other active Super Admin account(s) exist and are not changed. Nobody is demoted by this command.`);
  return { steps: blockers.length ? [] : steps, blockers, notes };
}

/**
 * Inspects, and with `apply` makes the planned changes in one transaction. Returns what was found, the plan and what
 * was done. Never reads or writes anything but the owner's own user row, its memberships and sessions, and one audit row.
 */
export function recoverOwner(db, { email, password, name = null, apply = false, resetPassword = false, params = SCRYPT_PARAMS }) {
  email = normalizeEmail(email);
  const before = inspectOwner(db, { email, password });
  const plan = planRecovery(before, { email, password, resetPassword });
  if (!apply || plan.blockers.length || plan.steps.length === 0) return { applied: false, before, plan, after: before };

  db.transaction(() => {
    const done = {};
    const has = (code) => plan.steps.some((s) => s.code === code);
    let userId = before.userId;
    if (has("create-account")) {
      userId = crypto.randomUUID();
      db.prepare("INSERT INTO users (id, email, password_hash, display_name, is_platform_admin, must_change_password, temp_password_expires_at) VALUES (?, ?, ?, ?, 0, 0, NULL)").run(
        userId,
        email,
        hashPassword(password, params),
        name && name.trim() ? name.trim() : null,
      );
      done.created = true;
    }
    if (has("reset-password")) {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0, temp_password_expires_at = NULL, password_changed_at = NULL WHERE id = ?").run(hashPassword(password, params), userId);
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      done.loginReset = true;
    }
    if (has("enable-account")) {
      db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(userId);
      done.enabled = true;
    }
    if (has("join-default-workspace")) {
      db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner') ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner'").run(DEFAULT_ORG_ID, userId);
      done.joinedDefault = true;
    }
    if (has("make-super-admin")) {
      db.prepare("UPDATE users SET is_platform_admin = 1 WHERE id = ?").run(userId);
      done.superAdmin = true;
    }
    // One record, written in the same transaction: the change and its record exist together or not at all.
    db.prepare("INSERT INTO audit_log (action, target_user_id, target_label, outcome, details) VALUES ('platform.owner.recover', ?, ?, 'success', ?)").run(
      userId,
      email,
      JSON.stringify({ ...done, via: "owner-recover command" }),
    );
  }).immediate();

  return { applied: true, before, plan, after: inspectOwner(db, { email, password }) };
}

// ── command line ──

function describe(facts, email) {
  const lines = [];
  const who = maskEmail(email);
  if (!facts.exists) {
    lines.push(`Owner account ${who}: does NOT exist in the database.`);
  } else {
    const where = facts.workspaces.length ? facts.workspaces.map((w) => `${w.role} of "${w.name}" (${w.status})`).join(", ") : "no workspace at all";
    lines.push(`Owner account ${who}: ${facts.status}, ${facts.isSuperAdmin ? "a Super Admin" : "NOT a Super Admin"}, member of ${where}.`);
    lines.push(`  can sign in: ${facts.canSignIn ? "yes" : "NO"}   password in .env matches the stored one: ${facts.passwordMatchesEnv ? "yes" : "NO"}`);
  }
  return lines;
}

export async function main(argv = process.argv.slice(2), env = process.env, print = console.log) {
  const flags = new Set(argv);
  const unknown = argv.filter((a) => !["--apply", "--reset-password", "--help"].includes(a));
  if (flags.has("--help") || unknown.length) {
    print("Usage: npm run owner:recover [-- --apply] [--reset-password]\n  (no flags) dry run: report only, change nothing\n  --apply           make the changes listed by the dry run\n  --reset-password  also replace the stored password with BOOTSTRAP_OWNER_PASSWORD");
    return unknown.length ? 2 : 0;
  }

  const root = process.cwd();
  if (env === process.env) createRequire(import.meta.url)("@next/env").loadEnvConfig(root, env.NODE_ENV !== "production");
  const email = (env.BOOTSTRAP_OWNER_EMAIL ?? "").trim();
  const password = (env.BOOTSTRAP_OWNER_PASSWORD ?? "").trim();
  if (!email || !password) {
    print("BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD must both be set in .env. Nothing was changed.");
    return 1;
  }

  const file = path.join(path.resolve(root, env.DATA_DIR?.trim() || "./data"), "kb.sqlite");
  if (!fs.existsSync(file)) {
    print(`There is no database at ${file}. Start the application once so that it creates it. Nothing was changed.`);
    return 1;
  }
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const db = new Database(file, { readonly: !flags.has("--apply") }); // a dry run can't write even by accident
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true });
    if (version < MIN_SCHEMA_VERSION) {
      print(`The database is at schema v${version}; this command needs v${MIN_SCHEMA_VERSION}. Start the application once so that it migrates (it backs the database up first). Nothing was changed.`);
      return 1;
    }

    const apply = flags.has("--apply");
    const options = { email, password, name: env.BOOTSTRAP_OWNER_NAME ?? null, resetPassword: flags.has("--reset-password") };
    const dry = recoverOwner(db, { ...options, apply: false });
    for (const line of describe(dry.before, email)) print(line);
    for (const note of dry.plan.notes) print(`Note: ${note}`);
    for (const blocker of dry.plan.blockers) print(`Cannot continue: ${blocker}`);
    if (dry.plan.blockers.length) return 1;
    if (dry.plan.steps.length === 0) {
      print("Nothing to change: the account exists and can already sign in as a Super Admin.");
      return 0;
    }
    print(apply ? "Changes:" : "Would change:");
    for (const step of dry.plan.steps) print(`  - ${step.text}`);
    if (!apply) {
      print("Dry run only: nothing was changed. Re-run with --apply to make these changes.");
      return 0;
    }

    // A consistent copy first (VACUUM INTO is safe while the application is running); restoring it is the rollback.
    const backup = `${file}.pre-owner-recover-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    db.prepare("VACUUM INTO ?").run(backup);
    print(`Backed up the database to ${path.basename(backup)} (in the data folder).`);
    const result = recoverOwner(db, { ...options, apply: true });
    for (const line of describe(result.after, email)) print(line);
    print(result.after.canSignIn ? "Done. Sign in with the email and password from .env (no restart needed)." : "Done, but the account still can't sign in: see the lines above.");
    return result.after.canSignIn ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`owner-recover failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
