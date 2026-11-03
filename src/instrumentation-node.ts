// Node.js-only startup work, loaded from instrumentation.ts.
import { ensureBootstrap } from "./server/auth/bootstrap";
import { getConfig } from "./server/config";
import { getDb } from "./server/db/client";
import { SystemMaintenance } from "./server/db/system";
import { startConsultationWorker } from "./server/consultations/worker";

// Fail fast with a readable message if the environment is misconfigured.
const config = getConfig();
const db = getDb();

// Uploads are processed within the request, so anything still 'processing' at boot was interrupted.
// Integration syncs run inside the server process, so any still "running" at boot were interrupted.
// (Housekeeping across all organizations: SystemMaintenance is the only code allowed to do that.)
const maintenance = new SystemMaintenance(db);
maintenance.failStaleProcessing();
maintenance.failInterruptedRuns();

// First owner and (optional) demo account. Safe to repeat on every start.
await ensureBootstrap(db, config);

// Doctor consultations: the background worker for recordings. It starts only when CONSULTATIONS_ENCRYPTION_KEY is set, and it runs no job
// (and sends nothing to any AI service) until the privacy gate in server/consultations/gate.ts is open.
startConsultationWorker(db, config);
