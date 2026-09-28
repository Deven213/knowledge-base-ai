import "server-only";
import { getConfig } from "./config";
import { getDb } from "./db/client";
import { AppSettingsRepository, ConversationRepository, DocumentRepository } from "./db/repositories";
import { getEmbedder } from "./knowledge/embedder";
import { SqliteVectorStore } from "./knowledge/vector-store";
import { getProvider } from "./llm/registry";
import { IntegrationService } from "./integrations/service";
import { ProviderConfigService } from "./llm/resolve";

/** Wires the concrete implementations used by the API routes. */
export function getServices() {
  const config = getConfig();
  const db = getDb();
  const embedder = getEmbedder();
  const vectorStore = new SqliteVectorStore(db);
  return {
    config,
    db,
    documents: new DocumentRepository(db),
    conversations: new ConversationRepository(db),
    settings: new AppSettingsRepository(db),
    embedder,
    vectorStore,
    integrations: new IntegrationService({ db, config, embedder, vectorStore }),
    providerConfig: new ProviderConfigService(db, config),
    getProvider,
    retrieval: { topK: config.RETRIEVAL_TOP_K, minScore: config.RETRIEVAL_MIN_SCORE },
  };
}

export type Services = ReturnType<typeof getServices>;
