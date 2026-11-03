import type Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canChangeRole, invitableRoles, ORG_ACTIONS, roleCan, ROLE_RANK, type OrgAction, type Role } from "@/server/authz/permissions";
import { resetConfigForTests } from "@/server/config";
import { DocumentRepository } from "@/server/db/repositories";
import { body, call, seedMember, seedOrganization, type Seeded } from "./harness";
import { FakeEmbedder, memoryDb } from "./helpers";

const h = vi.hoisted(() => ({ db: undefined as unknown as Database.Database, embedder: undefined as unknown as FakeEmbedder, generate: vi.fn() }));
vi.mock("@/server/db/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/server/db/client")>()), getDb: () => h.db }));
vi.mock("@/server/knowledge/embedder", () => ({ getEmbedder: () => h.embedder }));
vi.mock("@/server/llm/registry", () => ({ getProvider: () => ({ id: "gemini", generate: h.generate }) }));
vi.mock("@/server/features/service", async () => {
  const { FEATURES } = await import("@/lib/features");
  return {
    getFeatureFlags: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })),
    isFeatureEnabled: () => true,
    getFeatureAvailability: () => Object.fromEntries(FEATURES.map((f) => [f.key, true])),
    getFeatureFlagService: () => ({ setFeatureEnabled: () => FEATURES.map((f) => ({ key: f.key, name: f.name, available: true })) }),
    defaultFeatureFlags: () => [],
  };
});

import * as askRoute from "@/app/api/ask/route";
import * as featureRoute from "@/app/api/features/[key]/route";
import * as featuresRoute from "@/app/api/features/route";
import * as documentRoute from "@/app/api/documents/[id]/route";
import * as documentsRoute from "@/app/api/documents/route";
import * as integrationRoute from "@/app/api/integrations/[id]/route";
import * as integrationsRoute from "@/app/api/integrations/route";
import * as settingsAiRoute from "@/app/api/settings/ai/route";
import * as membersRoute from "@/app/api/org/members/route";
import * as invitationsRoute from "@/app/api/org/invitations/route";

const ROLES: Role[] = ["viewer", "member", "doctor", "admin", "owner"];

describe("permission rules", () => {
  it("grants each role exactly what it should", () => {
    const grants = (role: Role) => ORG_ACTIONS.filter((a) => roleCan(role, a));
    expect(grants("viewer")).toEqual(["chat", "documents:read"]);
    expect(grants("member")).toEqual(["chat", "documents:read", "documents:write"]);
    expect(grants("doctor")).toEqual(["chat", "documents:read", "consultations:use"]);
    // Everything about running a workspace, but NOT patient consultations (see the test below).
    expect(grants("admin")).toEqual(ORG_ACTIONS.filter((a) => a !== "consultations:use"));
    expect(grants("owner")).toEqual(ORG_ACTIONS.filter((a) => a !== "consultations:use"));
  });

  it("only the Doctor role can use consultations: not even an owner or an administrator can open a patient's recording, transcript or note", () => {
    expect(ROLES.filter((r) => roleCan(r, "consultations:use"))).toEqual(["doctor"]);
  });

  it("only administrators and owners can manage members, integrations or delete documents", () => {
    for (const action of ["members:manage", "integrations:manage", "documents:delete"] as OrgAction[]) {
      expect(ROLES.filter((r) => roleCan(r, action))).toEqual(["admin", "owner"]);
    }
  });

  it("nobody can grant a role above their own, and only an owner can create, change or remove an owner", () => {
    // owner: anything
    for (const role of ROLES) expect(canChangeRole("owner", "member", role)).toBe(true);
    expect(canChangeRole("owner", "owner", "admin")).toBe(true);
    // admin: up to admin, never an owner, and not another admin
    expect(canChangeRole("admin", "member", "admin")).toBe(true);
    expect(canChangeRole("admin", "viewer", "member")).toBe(true);
    expect(canChangeRole("admin", "member", "owner")).toBe(false);
    expect(canChangeRole("admin", "owner", "member")).toBe(false);
    expect(canChangeRole("admin", "admin", "member")).toBe(false);
    expect(canChangeRole("admin", "member", null)).toBe(true);
    expect(canChangeRole("admin", "owner", null)).toBe(false);
    // member and viewer: nothing
    for (const actor of ["member", "viewer"] as Role[]) {
      for (const role of ROLES) expect(canChangeRole(actor, "viewer", role), `${actor}→${role}`).toBe(false);
      expect(canChangeRole(actor, "viewer", null)).toBe(false);
    }
  });

  it("invitations can never grant ownership or a role above the inviter's", () => {
    expect(invitableRoles("owner")).toEqual(["admin", "member", "doctor", "viewer"]);
    expect(invitableRoles("admin")).toEqual(["admin", "member", "doctor", "viewer"]);
    expect(invitableRoles("member")).toEqual([]);
    expect(invitableRoles("doctor")).toEqual([]); // a doctor can't invite or change anyone
    expect(invitableRoles("viewer")).toEqual([]);
    expect(ROLE_RANK.owner).toBeGreaterThan(ROLE_RANK.admin);
  });
});

describe("what each role can do through the real routes", () => {
  let db: Database.Database;
  let org: string;
  let people: Record<Role, Seeded>;

  beforeAll(() => {
    Object.assign(process.env, { GEMINI_API_KEY: "test-key-not-real-1234", GEMINI_MODEL: "test-model", DEFAULT_AI_PROVIDER: "gemini" });
    resetConfigForTests();
  });
  afterAll(() => {
    for (const k of ["GEMINI_API_KEY", "GEMINI_MODEL", "DEFAULT_AI_PROVIDER"]) delete process.env[k];
    resetConfigForTests();
  });
  beforeEach(() => {
    db = memoryDb();
    h.db = db;
    h.embedder = new FakeEmbedder(["policy"]);
    h.generate.mockReset();
    org = seedOrganization(db, "Acme");
    people = Object.fromEntries(ROLES.map((r) => [r, seedMember(db, org, `${r}@acme.test`, r)])) as Record<Role, Seeded>;
  });

  /** The status each role gets for one request; "allowed" means anything except 401/403. */
  async function statuses(run: (who: Seeded) => Promise<Response>): Promise<Record<Role, "allowed" | 403>> {
    const out = {} as Record<Role, "allowed" | 403>;
    for (const role of ROLES) {
      const res = await run(people[role]);
      expect(res.status, `${role} must be signed in`).not.toBe(401);
      out[role] = res.status === 403 ? 403 : "allowed";
    }
    return out;
  }
  const only = (...allowed: Role[]) => Object.fromEntries(ROLES.map((r) => [r, allowed.includes(r) ? "allowed" : 403]));

  it("reading documents and chatting: every role", async () => {
    expect(await statuses((who) => call(documentsRoute.GET, "/api/documents", { cookie: who.cookie }))).toEqual(only(...ROLES));
    expect(await statuses((who) => call(askRoute.POST, "/api/ask", { method: "POST", cookie: who.cookie, json: { question: "hello" } }))).toEqual(only(...ROLES));
  });

  it("uploading documents: members, administrators and owners, not viewers", async () => {
    const upload = (who: Seeded) => {
      const form = new FormData();
      form.append("file", new File(["Policy text."], `${who.role}.txt`, { type: "text/plain" }));
      return call(documentsRoute.POST, "/api/documents", { method: "POST", cookie: who.cookie, form });
    };
    expect(await statuses(upload)).toEqual(only("member", "admin", "owner"));
    const stored = new DocumentRepository(db, org).list().map((d) => d.filename).sort();
    expect(stored).toEqual(["admin.txt", "member.txt", "owner.txt"]); // nothing from the viewer
  });

  it("deleting documents: administrators and owners only, and the document survives a refusal", async () => {
    const results: Record<string, number> = {};
    for (const role of ROLES) {
      const documents = new DocumentRepository(db, org);
      const id = `doc-${role}`;
      documents.create({ id, filename: `${role}.txt`, mimeType: "text/plain", sizeBytes: 1 });
      const res = await call(documentRoute.DELETE, `/api/documents/${id}`, { method: "DELETE", cookie: people[role].cookie, params: { id } });
      results[role] = res.status;
      expect(documents.get(id) === undefined, `${role}: deleted?`).toBe(res.status === 204);
    }
    expect(results).toEqual({ viewer: 403, member: 403, doctor: 403, admin: 204, owner: 204 });
  });

  it("managing integrations: administrators and owners only", async () => {
    expect(await statuses((who) => call(integrationsRoute.GET, "/api/integrations", { cookie: who.cookie }))).toEqual(only("admin", "owner"));
    const id = (db.prepare("SELECT id FROM integration_connections WHERE org_id = ?").get(org) as { id: string } | undefined)?.id ?? (await seedIntegrationId());
    expect(await statuses((who) => call(integrationRoute.PATCH, `/api/integrations/${id}`, { method: "PATCH", cookie: who.cookie, params: { id }, json: { enabled: true } }))).toEqual(only("admin", "owner"));
  });

  async function seedIntegrationId(): Promise<string> {
    await call(integrationsRoute.GET, "/api/integrations", { cookie: people.owner.cookie }); // creates the organization's connections
    return (db.prepare("SELECT id FROM integration_connections WHERE org_id = ?").get(org) as { id: string }).id;
  }

  it("managing members and invitations: administrators and owners only", async () => {
    expect(await statuses((who) => call(membersRoute.GET, "/api/org/members", { cookie: who.cookie }))).toEqual(only("admin", "owner"));
    expect(await statuses((who) => call(invitationsRoute.GET, "/api/org/invitations", { cookie: who.cookie }))).toEqual(only("admin", "owner"));
    expect(
      await statuses((who) => call(invitationsRoute.POST, "/api/org/invitations", { method: "POST", cookie: who.cookie, json: { email: `new-${who.role}@acme.test`, role: "member" } })),
    ).toEqual(only("admin", "owner"));
  });

  it("platform-wide settings are not an organization right: even an owner can't change feature flags or the AI provider", async () => {
    const flag = (who: Seeded) => call(featureRoute.PUT, "/api/features/website_scraper", { method: "PUT", cookie: who.cookie, params: { key: "website_scraper" }, json: { enabled: true } });
    expect(await statuses(flag)).toEqual(only()); // all four organization roles are refused
    const ai = (who: Seeded) => call(settingsAiRoute.PUT, "/api/settings/ai", { method: "PUT", cookie: who.cookie, json: { activeProvider: "openai" } });
    expect(await statuses(ai)).toEqual(only());

    const operator = seedMember(db, org, "operator@acme.test", "member", { platformAdmin: true });
    expect((await flag(operator)).status).toBe(200);
    expect((await ai(operator)).status).toBe(200);
    expect((db.prepare("SELECT value FROM app_settings WHERE key = 'active_provider'").get() as { value: string }).value).toBe("openai");
  });

  it("every member can read the feature list, but only the platform administrator sees any part of an AI key", async () => {
    expect((await call(featuresRoute.GET, "/api/features", { cookie: people.viewer.cookie })).status).toBe(200);

    const asViewer = await body<{ providers: { provider: string; key: { configured: boolean; last4: string | null } }[] }>(await call(settingsAiRoute.GET, "/api/settings/ai", { cookie: people.viewer.cookie }));
    const gemini = (data: typeof asViewer) => data.providers.find((p) => p.provider === "gemini")!.key;
    expect(gemini(asViewer)).toMatchObject({ configured: true, last4: null });

    const operator = seedMember(db, org, "operator@acme.test", "viewer", { platformAdmin: true });
    const asOperator = await body<typeof asViewer>(await call(settingsAiRoute.GET, "/api/settings/ai", { cookie: operator.cookie }));
    expect(gemini(asOperator).last4).toBe("1234");
  });

  it("a refused request is always JSON with a code, and changes nothing", async () => {
    const before = JSON.stringify(db.prepare("SELECT id, status FROM documents").all());
    const res = await call(documentRoute.DELETE, "/api/documents/whatever", { method: "DELETE", cookie: people.viewer.cookie, params: { id: "whatever" } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You don't have permission to do that.", code: "forbidden" });
    expect(JSON.stringify(db.prepare("SELECT id, status FROM documents").all())).toBe(before);
  });
});
