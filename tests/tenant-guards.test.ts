import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static guards. They read the source (not the running app) and fail when someone adds code that could
// weaken tenant isolation: a route without the tenant wrapper, a repository built without an organization,
// or SQL on a tenant table that doesn't filter by organization. They are the safety net for future changes.

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

function walk(dir: string, filter: (f: string) => boolean): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const child = `${dir}/${e.name}`; // always forward slashes, so the checks behave the same on every OS
    return e.isDirectory() ? walk(child, filter) : filter(child) ? [child] : [];
  });
}

const routeFiles = walk("src/app/api", (f) => f.endsWith("/route.ts"));
const sourceFiles = walk("src", (f) => /\.(ts|tsx)$/.test(f));

/** The only routes that work without a session: they ARE how a session starts or ends. */
const PUBLIC_ROUTES = [
  "src/app/api/auth/accept-invite/route.ts", // an invited person has no account yet
  "src/app/api/auth/demo/route.ts", // one-click demo sign-in (404 unless enabled)
  "src/app/api/auth/login/route.ts",
  "src/app/api/auth/logout/route.ts",
];

describe("every API route is tenant-guarded", () => {
  it("finds the routes (guards against this test silently checking nothing)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(35);
  });

  it("only the four sign-in routes are public, and each says so", () => {
    const declaredPublic = routeFiles.filter((f) => /^\/\/ public-route:/m.test(read(f)));
    expect(declaredPublic.sort()).toEqual([...PUBLIC_ROUTES].sort());
  });

  it("every other route exports its handlers through withTenant(...), never as a bare function", () => {
    const offenders: string[] = [];
    for (const file of routeFiles.filter((f) => !PUBLIC_ROUTES.includes(f))) {
      const source = read(file);
      const bareHandlers = [...source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
      const exported = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*=\s*([A-Za-z]+)(?:<[^>]*>)?\(/g)];
      if (bareHandlers.length > 0) offenders.push(`${file}: bare handler(s) ${bareHandlers.join(", ")}`);
      if (exported.length === 0) offenders.push(`${file}: exports no handler`);
      for (const [, method, wrapper] of exported) {
        // OAuth routes export what connectHandler()/callbackHandler() return; those factories are checked below.
        if (!["withTenant", "connectHandler", "callbackHandler"].includes(wrapper!)) offenders.push(`${file}: ${method} is wrapped in ${wrapper}, not withTenant`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the OAuth connect and callback factories wrap their handlers in withTenant", () => {
    const source = read("src/server/integrations/oauth-routes.ts");
    expect(source.match(/withTenant\("integrations:manage"/g)?.length).toBe(2);
  });

  it("every withTenant call names the permission it needs (null only for 'any signed-in member' routes)", () => {
    const anyMember: string[] = [];
    for (const file of routeFiles) {
      for (const m of read(file).matchAll(/withTenant(?:<[^>]*>)?\(\s*(null|"[^"]+")/g)) if (m[1] === "null") anyMember.push(file);
    }
    // Reading the feature list, the AI settings overview, who-am-I and switching workspace: no organization action applies.
    expect(anyMember.sort()).toEqual(
      [
        "src/app/api/auth/change-password/route.ts",
        "src/app/api/auth/me/route.ts",
        "src/app/api/auth/switch-org/route.ts",
        "src/app/api/features/route.ts",
        "src/app/api/settings/ai/route.ts",
      ].sort(),
    );
  });

  it("withTenant checks the session, the permission and (for mutating methods) the cross-site origin, in that code path", () => {
    const source = read("src/server/tenant.ts");
    expect(source).toMatch(/request\.method !== "GET" && request\.method !== "HEAD"/);
    expect(source).toMatch(/rejectCrossSite\(request\)/);
    expect(source).toMatch(/if \(!tenant\) return unauthenticated\(\)/);
    expect(source).toMatch(/if \(action && !can\(tenant, action\)\) \{[^}]*return forbidden\(\);/);
  });

  it("a refused platform action leaves an audit record before the 403", () => {
    const source = read("src/server/tenant.ts");
    expect(source).toMatch(/if \(action === "platform:admin"\) recordDeniedPlatformAccess\(request, tenant\);\s*return forbidden\(\);/);
  });
});

describe("the Super Admin (platform) code", () => {
  const platformRoutes = routeFiles.filter((f) => f.startsWith("src/app/api/platform/"));
  const platformSources = [...platformRoutes, ...sourceFiles.filter((f) => f.startsWith("src/server/platform/"))];

  it("finds the platform routes (guards against this test silently checking nothing)", () => {
    expect(platformRoutes.length).toBeGreaterThanOrEqual(6);
  });

  it("every platform route needs platform:admin, on every handler", () => {
    const offenders: string[] = [];
    for (const file of platformRoutes) {
      const source = read(file);
      const handlers = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*withTenant(?:<[^>]*>)?\(\s*("[^"]+"|null)/g)];
      if (handlers.length === 0) offenders.push(`${file}: no withTenant handler`);
      for (const [, method, action] of handlers) if (action !== '"platform:admin"') offenders.push(`${file}: ${method} uses ${action}`);
    }
    expect(offenders).toEqual([]);
  });

  it("never touches customer content: no document, chunk, conversation, integration or per-workspace settings tables or services", () => {
    const CONTENT = /\b(documents|chunks|conversations|messages|integration_connections|integration_sync_runs|integration_credentials|oauth_states|org_settings|embedding)\b/i;
    const SERVICES = /\b(DocumentRepository|ConversationRepository|OrgSettingsRepository|SqliteVectorStore|IntegrationRepository|IntegrationService|getTenantServices|getPlatformServices)\b/;
    const offenders: string[] = [];
    for (const file of platformSources) {
      // Look at code, not at the comments that explain the boundary.
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (CONTENT.test(code)) offenders.push(`${file}: mentions a customer-content table`);
      if (SERVICES.test(code)) offenders.push(`${file}: uses a content service`);
    }
    expect(offenders).toEqual([]);
  });

  it("PlatformAdminService is built only by the platform route plumbing, and the audit log is read only by the platform service", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const source = read(file);
      if (/new\s+PlatformAdminService\(/.test(source) && file !== "src/server/platform/context.ts") offenders.push(`${file} builds PlatformAdminService`);
      if (/new\s+AuditReader\(/.test(source) && file !== "src/server/platform/service.ts") offenders.push(`${file} builds AuditReader`);
    }
    expect(offenders).toEqual([]);
  });

  /** Code only: the comments that explain a design may mention anything. */
  const codeOf = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("the Super Admin service never logs (it handles a plaintext temporary password for a moment, so it must not print anything)", () => {
    expect(codeOf("src/server/platform/service.ts")).not.toMatch(/\bconsole\./);
    expect(codeOf("src/server/platform/context.ts")).not.toMatch(/\bconsole\./);
    expect(codeOf("src/server/auth/temporary-password.ts")).not.toMatch(/\bconsole\./);
  });

  it("a temporary password is only ever returned by the three Super Admin credential routes", () => {
    const mentioning = sourceFiles.filter((f) => f.startsWith("src/app/api/") && /\btemporaryPassword\b|\bcredentialsDto\b/.test(codeOf(f))).sort();
    expect(mentioning).toEqual([
      "src/app/api/platform/organizations/[id]/admins/route.ts",
      "src/app/api/platform/organizations/[id]/members/[userId]/credentials/route.ts",
      "src/app/api/platform/organizations/route.ts",
    ]);
  });

  it("a workspace or an account is deleted in one place only: the Super Admin service, behind platform:admin, in one transaction", () => {
    const deletesWorkspaces = sourceFiles.filter((f) => /DELETE\s+FROM\s+(organizations|users)\b/i.test(codeOf(f)));
    expect(deletesWorkspaces).toEqual(["src/server/platform/service.ts"]);
    const service = codeOf("src/server/platform/service.ts");
    const method = service.slice(service.indexOf("deleteOrganization("), service.indexOf("async addCustomerAdmin("));
    expect(method).toContain("this.db.transaction(");
    expect(method).toContain("is_platform_admin = 0"); // a Super Admin account is never removed
    expect(method).toContain("foreign_key_check");
    expect(method).toMatch(/this\.audit\.record\(\{[^}]*"platform\.organization\.delete"/s); // recorded in the same transaction
  });

  it("the helpers the deletion uses to look at customer data are read-only and used by nothing but the Super Admin service", () => {
    const users = sourceFiles.filter((f) => f !== "src/server/db/tenant-erasure.ts" && /tenant-erasure/.test(read(f)));
    expect(users).toEqual(["src/server/platform/service.ts"]);
    const statements = [...codeOf("src/server/db/tenant-erasure.ts").matchAll(/(?:prepare\(|count\(db,)\s*`([^`]*)`/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(statements.length).toBeGreaterThanOrEqual(8);
    for (const sql of statements) expect(sql, "tenant-erasure.ts only reads").toMatch(/^SELECT\b/);
  });

  it("the Super Admin console confirms in the page and never with the browser's native dialog (some browsers never show it, so the button silently did nothing)", () => {
    const files = sourceFiles.filter((f) => f.startsWith("src/components/platform/") || f === "src/components/ConfirmDialog.tsx");
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) expect(codeOf(file), file).not.toMatch(/(?<![\w.$])(window\.)?(confirm|alert|prompt)\(/);
    expect(read("src/components/platform/OrganizationPanel.tsx")).toContain("ConfirmDialog");
  });

  it("nothing in the application creates Customer Admin invitation links any more (new customers get a temporary password)", () => {
    const creators = sourceFiles.filter((f) => /INSERT INTO invitations\b[^`]*grants_owner/.test(read(f)));
    expect(creators).toEqual([]);
    expect(sourceFiles.filter((f) => /createCustomerAdmin/.test(read(f)))).toEqual([]);
  });
});

describe("the temporary-password lock", () => {
  it("only the password change and 'who am I' opt out of it, and withTenant checks it before any permission", () => {
    const optOut = routeFiles.filter((f) => /allowWhilePasswordChangeRequired:\s*true/.test(read(f))).sort();
    expect(optOut).toEqual(["src/app/api/auth/change-password/route.ts", "src/app/api/auth/me/route.ts"]);

    const source = read("src/server/tenant.ts");
    const lock = source.indexOf("if (tenant.mustChangePassword && !options.allowWhilePasswordChangeRequired) return passwordChangeRequired();");
    const permission = source.indexOf("if (action && !can(tenant, action))");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(permission);
  });

  it("the request gate and the page guard know about it too", () => {
    expect(read("src/proxy.ts")).toMatch(/password_change_required/);
    expect(read("src/proxy.ts")).toMatch(/PASSWORD_CHANGE_PATH/);
    expect(read("src/server/auth/service.ts")).toMatch(/if \(session\.mustChangePassword\) redirect\("\/change-password"\)/);
  });

  it("every product layout and page goes through requireSession (which sends a temporary-password session to change it)", () => {
    for (const file of ["src/components/admin/AdminShell.tsx", "src/app/chat/layout.tsx", "src/app/app/page.tsx", "src/app/platform/layout.tsx"]) {
      expect(read(file), file).toMatch(/requireSession\(\)/);
    }
  });
});

describe("data access always goes through an organization-scoped object", () => {
  it("the unscoped getServices() no longer exists", () => {
    const users = sourceFiles.filter((f) => /\bgetServices\b/.test(read(f)));
    expect(users).toEqual([]);
  });

  it("tenant repositories are only constructed by the service wiring (services.ts) and the integration service", () => {
    const allowed: Record<string, string[]> = {
      DocumentRepository: ["src/server/services.ts"],
      ConversationRepository: ["src/server/services.ts"],
      OrgSettingsRepository: ["src/server/services.ts"],
      SqliteVectorStore: ["src/server/services.ts"],
      IntegrationRepository: ["src/server/integrations/service.ts"],
      IntegrationService: ["src/server/services.ts"],
      // Doctor consultations: built for the signed-in doctor (services.ts), or by the worker for the doctor and organization a queued
      // job belongs to (processing.ts). Nowhere else.
      ConsultationRepository: ["src/server/services.ts", "src/server/consultations/processing.ts"],
      RecordingService: ["src/server/services.ts", "src/server/consultations/processing.ts"],
      InvitationRepository: [
        "src/app/api/org/invitations/[id]/route.ts",
        "src/app/api/org/invitations/route.ts",
        "src/server/platform/service.ts", // the Super Admin console; scoped to one workspace per call by construction
      ],
    };
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      for (const [cls, files] of Object.entries(allowed)) {
        if (new RegExp(`new\\s+${cls}\\(`).test(read(file)) && !files.includes(file)) offenders.push(`${file} builds ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("SystemMaintenance (the only code allowed to span all organizations) is used only at startup", () => {
    const users = sourceFiles.filter((f) => f !== "src/server/db/system.ts" && /\bSystemMaintenance\b/.test(read(f)));
    expect(users).toEqual(["src/instrumentation-node.ts"]);
  });

  it("the route handlers never read an organization or user ID from the request", () => {
    const offenders: string[] = [];
    for (const file of routeFiles) {
      const source = read(file);
      if (/(searchParams\.get|headers\.get)\(\s*["'`](org|tenant|user)[-_]?id/i.test(source)) offenders.push(file);
      if (/\.(orgId|tenantId|userId)\b.*(await\s+request\.json|fields|parsed\.data)/.test(source) && !/tenant\.(orgId|userId)/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("SQL on tenant tables always filters by organization", () => {
  // Tables whose rows belong to one organization.
  const TENANT_TABLES = /\b(documents|chunks|conversations|messages|integration_connections|integration_sync_runs|integration_credentials|oauth_states|org_settings|consultations|consultation_[a-z_]+)\b/;
  const FILES = ["src/server/db/repositories.ts", "src/server/knowledge/vector-store.ts", "src/server/integrations/repository.ts", "src/server/consultations/repository.ts"];

  // Statements that touch a tenant table without a literal org_id, each for a stated reason.
  const ALLOWED: { pattern: RegExp; why: string }[] = [
    { pattern: /INSERT INTO messages/, why: "only reached inside addMessages(), after this.get(conversationId) proved the conversation is the caller's" },
    { pattern: /DELETE FROM oauth_states WHERE created_at </, why: "expiry housekeeping: removes stale states of everyone, reads nothing" },
    { pattern: /DELETE FROM oauth_states WHERE state = \?/, why: "only reached after consumeOAuthState() found the state through this organization's connection" },
    { pattern: /DELETE FROM chunks WHERE document_id = \? AND org_id/, why: "(has org_id; listed only to document the pattern)" },
  ];

  /** Every SQL string passed to prepare()/exec(), with a few chars of context. */
  function statements(file: string): string[] {
    const source = read(file);
    return [...source.matchAll(/\b(?:prepare|exec)\(\s*`([^`]*)`/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
  }

  it("finds the SQL (guards against this test silently checking nothing)", () => {
    const minimum: Record<string, number> = {
      "src/server/db/repositories.ts": 15,
      "src/server/knowledge/vector-store.ts": 3,
      "src/server/integrations/repository.ts": 15,
      "src/server/consultations/repository.ts": 30,
    };
    for (const file of FILES) expect(statements(file).length, file).toBeGreaterThanOrEqual(minimum[file]!);
  });

  it("the scoping fragments the repositories reuse really contain the organization", () => {
    const repo = read("src/server/db/repositories.ts");
    expect(repo).toContain('sql: "c.org_id = ? AND c.user_id = ?"');
    expect(read("src/server/integrations/repository.ts")).toContain("(SELECT id FROM integration_connections WHERE org_id = ?)");
  });

  it("no statement on a tenant table lacks an organization filter, except the documented ones", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      for (const sql of statements(file)) {
        // The users' own settings tables hold no customer data.
        if (!TENANT_TABLES.test(sql.replace(/\$\{[^}]*\}/g, (m) => (/SELECT/.test(m) ? "FROM documents" : m)))) continue;
        const scoped = /org_id|OWN_CONNECTIONS|\$\{sql\}|@org/.test(sql);
        const allowed = ALLOWED.some((a) => a.pattern.test(sql));
        if (!scoped && !allowed) offenders.push(`${file}: ${sql.slice(0, 140)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the document and conversation SELECT bases are never used without a scoping condition", () => {
    const repo = read("src/server/db/repositories.ts");
    const uses = [...repo.matchAll(/\$\{(?:Document|Conversation)Repository\.SELECT\}([^`]*)`/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(4);
    for (const suffix of uses) expect(suffix, suffix).toMatch(/org_id|\$\{sql\}/);
  });

  it("every integration run lookup joins through the connection's organization", () => {
    const repo = read("src/server/integrations/repository.ts");
    const uses = [...repo.matchAll(/\$\{IntegrationRepository\.RUN_SELECT\}([^`]*)`/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(1);
    for (const suffix of uses) expect(suffix, suffix).toMatch(/c\.org_id = \?/);
  });
});
