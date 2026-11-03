import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for health information. Like tests/tenant-guards.test.ts they read the source, not the running app, and fail when someone adds
// code that could weaken what protects a consultation: a route that skips the shared gate, SQL on the consultation tables outside the places
// that are scoped to one doctor, a second way to build the cross-organization queue, a value written unsealed, or a log line that could print
// what a recording, transcript, note or patient says.

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

function walk(dir: string, filter: (f: string) => boolean): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const child = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(child, filter) : filter(child) ? [child] : [];
  });
}

/** Code only: the comments that explain a design may mention anything. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const sourceFiles = walk("src", (f) => /\.(ts|tsx)$/.test(f));
const routeFiles = walk("src/app/api", (f) => f.endsWith("/route.ts"));
const consultationRoutes = routeFiles.filter((f) => f.startsWith("src/app/api/consultations/"));
const moduleFiles = sourceFiles.filter((f) => f.startsWith("src/server/consultations/"));

describe("consultations: the routes", () => {
  it("finds the routes and the module (guards against this test silently checking nothing)", () => {
    expect(consultationRoutes.length).toBeGreaterThanOrEqual(11);
    expect(moduleFiles.length).toBeGreaterThanOrEqual(14);
  });

  it("every route needs the Doctor permission, and every handler runs through the shared gate (feature switch, configuration, clean refusals, audit of refused attempts)", () => {
    const offenders: string[] = [];
    for (const file of consultationRoutes) {
      const source = code(file);
      const handlers = [...source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\s*=\s*withTenant(?:<[^>]*>)?\(\s*("[^"]+"|null)/g)];
      if (handlers.length === 0) offenders.push(`${file}: no withTenant handler`);
      for (const [, method, action] of handlers) if (action !== '"consultations:use"') offenders.push(`${file}: ${method} uses ${action}`);
      const gated = [...source.matchAll(/\bconsultationRoute\(/g)].length;
      if (gated !== handlers.length) offenders.push(`${file}: ${handlers.length} handler(s) but ${gated} consultationRoute call(s)`);
      if (/\bgetDb\(|\bnew\s+ConsultationRepository\(|\bnew\s+RecordingService\(/.test(source)) offenders.push(`${file}: reaches the database or builds a repository itself`);
    }
    expect(offenders).toEqual([]);
  });

  it("the shared gate checks the feature switch and the configuration before it builds anything", () => {
    const source = code("src/server/consultations/api.ts");
    const feature = source.indexOf('requireFeature("consultations")');
    const configured = source.indexOf("consultationsConfigured(config)");
    const services = source.indexOf("getTenantServices(tenant)");
    expect(feature).toBeGreaterThan(0);
    expect(configured).toBeGreaterThan(feature);
    expect(services).toBeGreaterThan(configured);
    expect(source).toMatch(/internalError\(name, err\)/); // an unexpected error becomes a generic 500
  });

  it("the consultation pages (server components) hand nothing but plain values to the client components they render", () => {
    // A server component can't pass a function or a component (an icon, a callback) to a client one: Next refuses at request time with
    // "Functions cannot be passed directly to Client Components", which no jsdom test can see. So the pages and layouts only pass strings.
    const pages = walk("src/app/admin/consultations", (f) => /\.(ts|tsx)$/.test(f));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const offenders = pages.filter((f) => /\bicon=\{|\bonClick=\{|=\{\s*\(/.test(code(f)) || /import\s+\{[^}]*\b(Stethoscope|Mic|Plus)\b[^}]*\}\s+from\s+"lucide-react"/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("no route reads who the caller is, or which workspace, from the request", () => {
    const offenders = consultationRoutes.filter((f) => /(searchParams\.get|headers\.get)\(\s*["'`](org|tenant|user|doctor)[-_]?id/i.test(read(f)) || /\b(orgId|doctorId|userId)\b.*(request\.json|parsed\.data)/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("consultations: the data", () => {
  it("SQL on the consultation tables lives only in the scoped repository, the worker's queue, the deletion helpers and the migrations", () => {
    const allowed = ["src/server/consultations/repository.ts", "src/server/consultations/jobs.ts", "src/server/db/tenant-erasure.ts", "src/server/db/migrate.ts"];
    const touching = sourceFiles.filter((f) => /\b(FROM|INTO|UPDATE|JOIN)\s+consultation(s|_[a-z_]+)\b/i.test(code(f)));
    expect(touching.sort()).toEqual(allowed.sort());
  });

  it("the worker's queue, the one piece that looks across organizations, touches only the job table plus the narrow lookups it needs, and never a content column", () => {
    const source = code("src/server/consultations/jobs.ts");
    const statements = [...source.matchAll(/\bprepare\(\s*`([^`]*)`/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(statements.length).toBeGreaterThanOrEqual(9);
    // The ONE statement that also looks at who the doctor is: it finds work that may still be done (active workspace, active doctor who still
    // holds the Doctor role), reading nothing but ids and statuses.
    const eligibility = statements.filter((sql) => /JOIN organizations o ON o\.id = c\.org_id AND o\.status = 'active'/.test(sql));
    expect(eligibility).toHaveLength(1);
    expect(eligibility[0]).toMatch(/JOIN users u ON u\.id = c\.doctor_user_id AND u\.status = 'active' JOIN memberships m ON m\.org_id = c\.org_id AND m\.user_id = c\.doctor_user_id AND m\.role = 'doctor'/);
    for (const sql of statements) {
      const tables = [...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+(\w+)/gi)].map((m) => m[1]!);
      const allowedTables = eligibility.includes(sql) ? ["consultation_jobs", "consultations", "organizations", "users", "memberships"] : ["consultation_jobs", "consultations", "consultation_recordings"];
      expect(tables.every((t) => allowedTables.includes(t)), sql).toBe(true);
      expect(sql, "a content column").not.toMatch(/patient_label|\bcontent\b|transcript|\bnote\b|password|email|display_name/i);
      // The doctor of a job's consultation is looked up through the JOB's own organization.
      if (/\bFROM consultations\b/.test(sql) && !eligibility.includes(sql)) expect(sql).toBe("SELECT doctor_user_id FROM consultations WHERE org_id = ? AND id = ?");
      // From the recordings table it reads only where audio is and which uploads were abandoned.
      if (/consultation_recordings/.test(sql)) expect(sql).toMatch(/^SELECT (storage_key FROM consultation_recordings$|org_id, consultation_id FROM consultation_recordings WHERE status = 'uploading')/);
    }
  });

  it("the cross-organization queue and the worker are each built in exactly one place", () => {
    const queueUsers = sourceFiles.filter((f) => f !== "src/server/consultations/jobs.ts" && /\bnew\s+ConsultationJobs\(/.test(code(f)));
    expect(queueUsers).toEqual(["src/server/consultations/worker.ts"]);
    const workerUsers = sourceFiles.filter((f) => f !== "src/server/consultations/worker.ts" && /\bnew\s+ConsultationWorker\(|\bstartConsultationWorker\(/.test(code(f)));
    expect(workerUsers).toEqual(["src/instrumentation-node.ts"]);
  });

  it("everything that describes a patient or their care is sealed before it is written, and opened only inside the repository", () => {
    const repo = code("src/server/consultations/repository.ts");
    expect(repo).toMatch(/INSERT INTO consultations \(id, org_id, doctor_user_id, patient_label, language_hint\)[^;]*sealText\(/);
    expect(repo).toMatch(/INSERT INTO consultation_transcripts[^;]*sealJson\(/);
    expect((repo.match(/INSERT INTO consultation_notes[^;]*sealJson\(/g) ?? []).length).toBe(3); // the AI draft, a doctor's edit, a reopened copy
    const openers = moduleFiles.filter((f) => /\.(openJson|openText)\(/.test(code(f)));
    expect(openers).toEqual(["src/server/consultations/repository.ts"]);
  });

  it("audio only ever reaches the store sealed", () => {
    const recording = code("src/server/consultations/recording.ts");
    expect(recording).toMatch(/const sealed = this\.vault\(\)\.seal\(bytes,[\s\S]*?this\.store\.put\(partKey\(recording\.storage_key, number\), sealed\)/);
    const putters = moduleFiles.filter((f) => /\bstore\.put\(/.test(code(f)));
    expect(putters).toEqual(["src/server/consultations/recording.ts"]);
  });

  it("only the Doctor role is granted consultations: the permissions table is the one place that grants it, and everywhere else only checks it", () => {
    const mentions = sourceFiles.filter((f) => /["']consultations:use["']/.test(code(f)) && !f.startsWith("src/app/api/consultations/") && f !== "src/server/authz/permissions.ts");
    for (const file of mentions) {
      // Each other mention is a check of the caller's role ("can this person ...?"), never a list of what a role may do.
      const uses = [...code(file).matchAll(/.{0,40}["']consultations:use["'].{0,10}/g)].map((m) => m[0]);
      for (const use of uses) expect(use, file).toMatch(/\b(roleCan|can)\(|withTenant\(/);
    }
    const grants = code("src/server/authz/permissions.ts").split("\n").filter((l) => /consultations:use/.test(l) && /^\s*(viewer|member|admin|owner)\s*:/.test(l));
    expect(grants).toEqual([]);
    expect(code("src/server/authz/permissions.ts")).toMatch(/doctor:\s*\[[^\]]*"consultations:use"/);
  });

  it("Super Admin code never touches consultation tables or services (it learns how many exist only through the deletion helpers)", () => {
    const platform = sourceFiles.filter((f) => f.startsWith("src/server/platform/") || f.startsWith("src/app/api/platform/"));
    const offenders = platform.filter((f) => /\bconsultation|\bRecordingService\b|audio-store/i.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

describe("consultations: what is logged", () => {
  /** The text of every console call in the module, with fixed sentences blanked out, so only VALUES that are printed remain. */
  function printedValues(file: string): string[] {
    const out: string[] = [];
    for (const m of code(file).matchAll(/console\.(?:log|info|warn|error|debug)\(([\s\S]*?)\);/g)) {
      const withoutSentences = m[1]!.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/`(?:[^`$\\]|\\.|\$(?!\{))*`/g, '""');
      out.push(withoutSentences);
      // A template literal's ${...} pieces are values too: keep them.
      for (const t of m[1]!.matchAll(/\$\{([^}]*)\}/g)) out.push(t[1]!);
    }
    return out;
  }

  it("finds the log calls (guards against this test silently checking nothing)", () => {
    expect(moduleFiles.flatMap(printedValues).length).toBeGreaterThanOrEqual(6);
  });

  it("no log line prints a transcript, a note, a patient, audio, or an error's message (which can quote any of them)", () => {
    const offenders: string[] = [];
    for (const file of moduleFiles) {
      for (const printed of printedValues(file)) {
        if (/\b(transcript|patient|segments?|content|audio|bytes|label|note|raw|text)\b/i.test(printed)) offenders.push(`${file}: ${printed.replace(/\s+/g, " ").slice(0, 100)}`);
        if (/\.message\b/.test(printed) && !/status === |quoting/.test(printed)) offenders.push(`${file}: prints an error message: ${printed.replace(/\s+/g, " ").slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the routes and the audit helper never log at all, except that an audit write failed", () => {
    for (const file of consultationRoutes) expect(code(file), file).not.toMatch(/\bconsole\./);
    const calls = [...code("src/server/consultations/api.ts").matchAll(/console\.\w+\(/g)];
    expect(calls).toHaveLength(1);
  });
});
