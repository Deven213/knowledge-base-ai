import "server-only";
import { getConfig } from "./config";
import { getDb } from "./db/client";
import { AppSettingsRepository, ConversationRepository, DocumentRepository, OrgSettingsRepository } from "./db/repositories";
import { getEmbedder } from "./knowledge/embedder";
import { SqliteVectorStore } from "./knowledge/vector-store";
import { getProvider } from "./llm/registry";
import { IntegrationService } from "./integrations/service";
import { getAudioStore } from "./consultations/audio-store";
import { RecordingService } from "./consultations/recording";
import { ConsultationRepository } from "./consultations/repository";
import { consultationVault } from "./consultations/vault";
import { ProviderConfigService } from "./llm/resolve";
import type { TenantContext } from "./tenant";

/**
 * Wiring for the two kinds of work the server does.
 *
 * Platform services hold nothing that belongs to a customer: configuration, the shared embedding model,
 * AI provider settings. Tenant services are built for ONE signed-in caller: every repository, the vector
 * store and the integrations are bound to that caller's organization (and, for conversations, the caller
 * themself), so request code has no way to reach another customer's data.
 */
export function getPlatformServices() {
  const config = getConfig();
  const db = getDb();
  return {
    config,
    db,
    embedder: getEmbedder(),
    /** Platform-wide values only (the active AI provider); nothing customer-specific lives here. */
    settings: new AppSettingsRepository(db),
    providerConfig: new ProviderConfigService(db, config),
    getProvider,
  };
}

export function getTenantServices(tenant: TenantContext) {
  const platform = getPlatformServices();
  const { db, config, embedder } = platform;
  const documents = new DocumentRepository(db, tenant.orgId);
  const vectorStore = new SqliteVectorStore(db, tenant.orgId);
  // Doctor consultations: this doctor's, in this organization's. The vault is opened lazily, so a deployment that hasn't set
  // CONSULTATIONS_ENCRYPTION_KEY is unaffected until someone actually uses the feature.
  const vault = () => consultationVault(config);
  const consultations = new ConsultationRepository(db, tenant.orgId, tenant.userId, vault);
  return {
    ...platform,
    tenant,
    documents,
    conversations: new ConversationRepository(db, tenant.orgId, tenant.userId),
    consultations,
    recordings: new RecordingService(consultations, getAudioStore(config), vault, tenant.orgId, {
      maxBytes: Math.floor(config.CONSULTATIONS_MAX_AUDIO_MB * 1024 * 1024),
      maxMinutes: config.CONSULTATIONS_MAX_MINUTES,
      quotaBytes: Math.floor(config.CONSULTATIONS_MAX_STORAGE_GB * 1024 * 1024 * 1024),
    }),
    /** This organization's own settings (for example its cached suggested questions). */
    orgSettings: new OrgSettingsRepository(db, tenant.orgId),
    vectorStore,
    integrations: new IntegrationService({ db, config, embedder, vectorStore, documents, orgId: tenant.orgId }),
    retrieval: { topK: config.RETRIEVAL_TOP_K, minScore: config.RETRIEVAL_MIN_SCORE },
  };
}

export type PlatformServices = ReturnType<typeof getPlatformServices>;
export type TenantServices = ReturnType<typeof getTenantServices>;
