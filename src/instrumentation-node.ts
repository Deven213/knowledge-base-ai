// Node.js-only startup work, loaded from instrumentation.ts.
import { getConfig } from "./server/config";
import { getDb } from "./server/db/client";
import { DocumentRepository } from "./server/db/repositories";
import { IntegrationRepository } from "./server/integrations/repository";

// Fail fast with a readable message if the environment is misconfigured.
getConfig();

// Uploads are processed within the request, so anything still 'processing' at boot was interrupted.
new DocumentRepository(getDb()).failStaleProcessing();

// Integration syncs run inside the server process, so any still "running" at boot were interrupted.
new IntegrationRepository(getDb()).failInterruptedRuns();
