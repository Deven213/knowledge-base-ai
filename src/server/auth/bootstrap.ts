import "server-only";
import type Database from "better-sqlite3";
import type { AppConfig } from "../config";
import { LEGACY_ORG_ID } from "../db/constants";
import { IdentityRepository, normalizeEmail } from "./identity";
import { DEFAULT_SCRYPT_PARAMS, hashPassword, passwordProblem, verifyPassword, type ScryptParams } from "./password";

/** Whether the account named in BOOTSTRAP_OWNER_EMAIL can actually sign in (null when no owner is configured or it was rejected). */
export type OwnerAccess = "ok" | "disabled" | "no-workspace" | "workspaces-suspended";

export interface BootstrapSummary {
  owner: "created" | "existing" | "not-configured" | "rejected";
  ownerAccess: OwnerAccess | null;
  /** For an account that already existed: whether BOOTSTRAP_OWNER_PASSWORD is its current password (null otherwise). */
  ownerPasswordMatchesEnv: boolean | null;
  demo: "created" | "existing" | "disabled" | "skipped";
  /** The Default workspace holds data but nobody can sign in to it yet. */
  legacyWorkspaceUnowned: boolean;
}

/** "de***@example.org": enough to recognise an address in a log without printing the whole thing. */
function maskEmail(email: string): string {
  const [local = "", domain] = email.split("@");
  return domain ? `${local.slice(0, 2)}***@${domain}` : "***";
}

const DEMO_ORG_NAME = "Demo workspace";
const DEMO_ORG_SLUG = "demo-workspace";

/**
 * Runs at startup and is safe to repeat. It never logs or returns a password.
 *
 *  1. First owner: BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD create an account that owns the
 *     "Default workspace", the organization that adopted everything created before organizations existed.
 *     That owner also becomes the platform administrator if there isn't one yet, and takes over the
 *     conversations that had no author. They are only used to CREATE the account: an existing account's
 *     password is never changed from the environment, and an address that is new to the database becomes a
 *     separate account that nothing grants anything to. When that account can't sign in (or its password
 *     differs from .env), this says so in the log, once per start, and names `npm run owner:recover`
 *     (scripts/owner-recover.mjs), the explicit, audited way to fix it. It never logs a password.
 *  2. Demo account: only if DEMO_USER_PASSWORD is set. It gets its OWN "Demo workspace", so a public demo
 *     login can never reach a customer's data. There is no built-in default password.
 */
export async function ensureBootstrap(
  db: Database.Database,
  config: Pick<AppConfig, "BOOTSTRAP_OWNER_EMAIL" | "BOOTSTRAP_OWNER_PASSWORD" | "BOOTSTRAP_OWNER_NAME" | "DEMO_USER_EMAIL" | "DEMO_USER_PASSWORD">,
  passwordParams: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<BootstrapSummary> {
  const identity = new IdentityRepository(db);
  const summary: BootstrapSummary = { owner: "not-configured", ownerAccess: null, ownerPasswordMatchesEnv: null, demo: "disabled", legacyWorkspaceUnowned: false };

  // ── 1. First owner ──
  if (config.BOOTSTRAP_OWNER_EMAIL && config.BOOTSTRAP_OWNER_PASSWORD) {
    const email = normalizeEmail(config.BOOTSTRAP_OWNER_EMAIL); // getConfig() already does this; direct callers get the same
    let owner = identity.findUserByEmail(email);
    if (owner) {
      summary.owner = "existing";
    } else {
      const problem = passwordProblem(config.BOOTSTRAP_OWNER_PASSWORD, email);
      if (problem) {
        console.error(`[auth] BOOTSTRAP_OWNER_PASSWORD was not used: ${problem}`);
        summary.owner = "rejected";
      } else {
        owner = identity.createUser({
          email,
          passwordHash: await hashPassword(config.BOOTSTRAP_OWNER_PASSWORD, passwordParams),
          displayName: config.BOOTSTRAP_OWNER_NAME ?? null,
        });
        summary.owner = "created";
      }
    }
    if (owner) {
      db.transaction(() => {
        // Adopt the Default workspace only while it has no owner, so later changes to its members are never undone.
        if (identity.ownerCount(LEGACY_ORG_ID) === 0 && !identity.getMembership(LEGACY_ORG_ID, owner.id)) {
          identity.addMember(LEGACY_ORG_ID, owner.id, "owner");
        }
        const hasPlatformAdmin = db.prepare(`SELECT 1 FROM users WHERE is_platform_admin = 1 AND status = 'active'`).get();
        if (!hasPlatformAdmin) identity.setPlatformAdmin(owner.id, true);
        if (identity.getMembership(LEGACY_ORG_ID, owner.id)?.role === "owner") {
          db.prepare(`UPDATE conversations SET user_id = ? WHERE org_id = ? AND user_id IS NULL`).run(owner.id, LEGACY_ORG_ID);
        }
      })();

      // Say so when this account can't be used (the sign-in page only ever shows the same generic message). Facts only.
      const current = identity.findUserById(owner.id)!;
      const workspaces = identity.organizationsOf(owner.id);
      summary.ownerAccess =
        current.status !== "active" ? "disabled" : workspaces.length === 0 ? "no-workspace" : workspaces.every((w) => w.status === "suspended") ? "workspaces-suspended" : "ok";
      if (summary.owner === "existing") summary.ownerPasswordMatchesEnv = await verifyPassword(config.BOOTSTRAP_OWNER_PASSWORD, current.password_hash);
      const fix = `Run "npm run owner:recover" to see what would fix it (it changes nothing without --apply).`;
      if (summary.ownerAccess === "no-workspace") {
        console.warn(`[auth] The BOOTSTRAP_OWNER_EMAIL account (${maskEmail(email)}) cannot sign in: it belongs to no workspace. The environment only creates the owner; it never adds an address to a workspace or makes it a Super Admin once another owner exists. ${fix}`);
      } else if (summary.ownerAccess === "disabled") {
        console.warn(`[auth] The BOOTSTRAP_OWNER_EMAIL account (${maskEmail(email)}) cannot sign in: the account is disabled. ${fix}`);
      } else if (summary.ownerAccess === "workspaces-suspended") {
        console.warn(`[auth] The BOOTSTRAP_OWNER_EMAIL account (${maskEmail(email)}) cannot sign in: every workspace it belongs to is suspended. Reactivate one in the Super Admin console.`);
      }
      if (summary.ownerPasswordMatchesEnv === false) {
        console.warn(
          `[auth] BOOTSTRAP_OWNER_PASSWORD no longer matches the password of the account ${maskEmail(email)}. It is only used when the account is created, so changing it in .env has no effect on an existing account. Sign in with the password the account has now, or run "npm run owner:recover -- --apply --reset-password" to make the .env password the account's password.`,
        );
      }
    }
  }

  // ── 2. Demo account (its own workspace) ──
  if (config.DEMO_USER_PASSWORD) {
    const email = normalizeEmail(config.DEMO_USER_EMAIL);
    const demoOrg = identity.getOrganizationBySlug(DEMO_ORG_SLUG);
    let demo = identity.findUserByEmail(email);
    // The demo account must be a dedicated one. If the address already belongs to a real person (the owner,
    // a platform administrator, or anyone who is in another workspace) it is left alone: this code must never
    // overwrite their password or put them in the public demo workspace.
    const repurposesRealAccount =
      !!demo && (email === normalizeEmail(config.BOOTSTRAP_OWNER_EMAIL ?? "") || demo.is_platform_admin === 1 || identity.organizationsOf(demo.id).some((o) => o.orgId !== demoOrg?.id));
    if (repurposesRealAccount) {
      console.error("[auth] DEMO_USER_EMAIL belongs to an existing real account, so no demo account was set up. Use a different address for the demo.");
      summary.demo = "skipped";
    } else {
      if (!demo) {
        const problem = passwordProblem(config.DEMO_USER_PASSWORD, email);
        if (problem) {
          console.error(`[auth] DEMO_USER_PASSWORD was not used: ${problem}`);
          summary.demo = "skipped";
        } else {
          demo = identity.createUser({ email, passwordHash: await hashPassword(config.DEMO_USER_PASSWORD, passwordParams), displayName: "Demo" });
          summary.demo = "created";
        }
      } else {
        // The environment is the source of truth for the demo password.
        if (!(await verifyPassword(config.DEMO_USER_PASSWORD, demo.password_hash))) {
          identity.setPasswordHash(demo.id, await hashPassword(config.DEMO_USER_PASSWORD, passwordParams));
        }
        summary.demo = "existing";
      }
      if (demo) {
        const org = demoOrg ?? identity.createOrganization(DEMO_ORG_NAME);
        if (!identity.getMembership(org.id, demo.id)) identity.addMember(org.id, demo.id, "owner");
      }
    }
  }

  const legacyData = (db.prepare(`SELECT (SELECT COUNT(*) FROM documents WHERE org_id = ?) + (SELECT COUNT(*) FROM conversations WHERE org_id = ?) AS n`).get(LEGACY_ORG_ID, LEGACY_ORG_ID) as { n: number }).n;
  summary.legacyWorkspaceUnowned = legacyData > 0 && identity.ownerCount(LEGACY_ORG_ID) === 0;
  if (summary.legacyWorkspaceUnowned) {
    console.warn("[auth] The Default workspace holds data but has no owner, so nobody can open it. Set BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD and restart.");
  }
  return summary;
}
