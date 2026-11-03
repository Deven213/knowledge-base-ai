// Feature flags: which modules are visible and available. Shared by server and browser.
// Flags control availability only; they are never used for secrets or static configuration.

export const FEATURE_KEYS = [
  "chat",
  "dashboard",
  "documents",
  "knowledge_base",
  "ai_agents",
  "ai_model_settings",
  "sync_integrations",
  "website_scraper",
  "google_drive",
  "onedrive",
  "widget_management",
  "email_addons",
  "whatsapp_connections",
  "channels",
  "category_management",
  "user_management",
  "feedback_report",
  "audit_logs",
  "system_monitoring",
  "consultations",
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

export type FeatureCategory = "Core" | "AI" | "Integrations" | "Administration";
export const FEATURE_CATEGORIES: FeatureCategory[] = ["Core", "AI", "Integrations", "Administration"];

export interface FeatureDefinition {
  key: FeatureKey;
  name: string;
  description: string;
  category: FeatureCategory;
  /** Must be available for this feature to be available. */
  dependsOn: FeatureKey | null;
  /**
   * Used when the flag is missing or can't be loaded: existing functionality keeps working (true),
   * roadmap / unreleased modules stay off (false).
   */
  defaultEnabled: boolean;
  /** Roadmap modules are placeholders ("Coming soon") until they are built. */
  roadmap: boolean;
}

export const FEATURES: readonly FeatureDefinition[] = [
  // Core
  { key: "chat", name: "Chat", description: "Ask questions about your documents and attach files or images.", category: "Core", dependsOn: null, defaultEnabled: true, roadmap: false },
  { key: "dashboard", name: "Dashboard", description: "Overview of documents, chunks, conversations and questions.", category: "Core", dependsOn: null, defaultEnabled: true, roadmap: false },
  { key: "documents", name: "Documents", description: "Upload, list and delete Knowledge Base documents.", category: "Core", dependsOn: "knowledge_base", defaultEnabled: true, roadmap: false },
  { key: "knowledge_base", name: "Knowledge Base", description: "Indexed documents that chat searches (RAG) to answer with citations.", category: "Core", dependsOn: null, defaultEnabled: true, roadmap: false },
  { key: "consultations", name: "Doctor Consultations", description: "Record a doctor-patient consultation, transcribe it and draft a clinical note for the doctor to review and approve.", category: "Core", dependsOn: null, defaultEnabled: false, roadmap: false },
  // AI
  { key: "ai_agents", name: "AI Agents", description: "Create and manage specialized AI agents.", category: "AI", dependsOn: "knowledge_base", defaultEnabled: false, roadmap: true },
  { key: "ai_model_settings", name: "AI Model Settings", description: "Choose the active AI provider and configure model IDs.", category: "AI", dependsOn: "chat", defaultEnabled: true, roadmap: false },
  // Integrations
  { key: "sync_integrations", name: "Integrations", description: "Connect external sources (websites, Google Drive, OneDrive) to the Knowledge Base.", category: "Integrations", dependsOn: "knowledge_base", defaultEnabled: false, roadmap: false },
  { key: "website_scraper", name: "Website Scraper", description: "Crawl website pages into the Knowledge Base.", category: "Integrations", dependsOn: "sync_integrations", defaultEnabled: true, roadmap: false },
  { key: "google_drive", name: "Google Drive", description: "Sync files from a Google Drive folder.", category: "Integrations", dependsOn: "sync_integrations", defaultEnabled: true, roadmap: false },
  { key: "onedrive", name: "OneDrive", description: "Sync files from a Microsoft OneDrive folder.", category: "Integrations", dependsOn: "sync_integrations", defaultEnabled: true, roadmap: false },
  { key: "widget_management", name: "Widget Management", description: "Embeddable chat widget keys for external websites.", category: "Integrations", dependsOn: "chat", defaultEnabled: false, roadmap: true },
  { key: "email_addons", name: "Email Add-ons", description: "Gmail and Outlook add-ons that answer from your documents.", category: "Integrations", dependsOn: "chat", defaultEnabled: false, roadmap: true },
  { key: "whatsapp_connections", name: "WhatsApp Connections", description: "Answer questions from your documents over WhatsApp.", category: "Integrations", dependsOn: "chat", defaultEnabled: false, roadmap: true },
  { key: "channels", name: "Channels", description: "Slack, Microsoft Teams and other messaging channels.", category: "Integrations", dependsOn: "chat", defaultEnabled: false, roadmap: true },
  // Administration
  { key: "category_management", name: "Category Management", description: "Group documents into categories and control access.", category: "Administration", dependsOn: "knowledge_base", defaultEnabled: false, roadmap: true },
  { key: "user_management", name: "User Management", description: "User accounts, roles and access.", category: "Administration", dependsOn: null, defaultEnabled: false, roadmap: true },
  { key: "feedback_report", name: "Feedback Report", description: "Thumbs up/down on answers and a report of low-rated ones.", category: "Administration", dependsOn: "chat", defaultEnabled: false, roadmap: true },
  { key: "audit_logs", name: "Audit Logs", description: "A record of uploads, deletions and settings changes.", category: "Administration", dependsOn: null, defaultEnabled: false, roadmap: true },
  { key: "system_monitoring", name: "System Monitoring", description: "Provider response times, errors and storage usage.", category: "Administration", dependsOn: null, defaultEnabled: false, roadmap: true },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));

export function isFeatureKey(value: string): value is FeatureKey {
  return BY_KEY.has(value as FeatureKey);
}

export function featureDefinition(key: FeatureKey): FeatureDefinition {
  return BY_KEY.get(key)!;
}

export type FeatureStatus = "on" | "off" | "unavailable";

/** A feature's full state, as shown on the Feature Management page. */
export interface FeatureState {
  key: FeatureKey;
  name: string;
  description: string;
  category: FeatureCategory;
  dependsOn: FeatureKey | null;
  roadmap: boolean;
  /** The administrator's switch. */
  enabled: boolean;
  /** Enabled AND every dependency (transitively) available. This is what the app obeys. */
  available: boolean;
  /** "unavailable" = switched on, but a dependency is off. */
  status: FeatureStatus;
  /** The nearest dependency that is not available, if any. */
  blockedBy: FeatureKey | null;
}

/** Availability map sent to the browser. */
export type FeatureAvailability = Record<FeatureKey, boolean>;

/**
 * Resolves switches into availability, following dependencies.
 * Missing switches fall back to each feature's safe default.
 */
export function resolveFeatures(enabled: Partial<Record<FeatureKey, boolean>>): FeatureState[] {
  const isOn = (key: FeatureKey) => enabled[key] ?? featureDefinition(key).defaultEnabled;

  // Available = switched on and every dependency up the chain available. Cycles resolve to unavailable.
  const isAvailable = (key: FeatureKey, seen = new Set<FeatureKey>()): boolean => {
    if (seen.has(key)) return false;
    seen.add(key);
    const dep = featureDefinition(key).dependsOn;
    return isOn(key) && (dep === null || isAvailable(dep, seen));
  };

  // The nearest dependency up the chain whose switch is off (the reason this feature can't run).
  const blockingDependency = (key: FeatureKey): FeatureKey | null => {
    const seen = new Set<FeatureKey>([key]);
    for (let dep = featureDefinition(key).dependsOn; dep && !seen.has(dep); dep = featureDefinition(dep).dependsOn) {
      if (!isOn(dep)) return dep;
      seen.add(dep);
    }
    return null;
  };

  return FEATURES.map((def) => {
    const available = isAvailable(def.key);
    const blockedBy = blockingDependency(def.key);
    return {
      key: def.key,
      name: def.name,
      description: def.description,
      category: def.category,
      dependsOn: def.dependsOn,
      roadmap: def.roadmap,
      enabled: isOn(def.key),
      available,
      status: !isOn(def.key) ? "off" : available ? "on" : "unavailable",
      blockedBy,
    };
  });
}

export function toAvailability(states: FeatureState[]): FeatureAvailability {
  return Object.fromEntries(states.map((s) => [s.key, s.available])) as FeatureAvailability;
}

/** Features that list `key` as their direct dependency. */
export function dependentsOf(key: FeatureKey): FeatureKey[] {
  return FEATURES.filter((f) => f.dependsOn === key).map((f) => f.key);
}

export const FEATURE_DISABLED_MESSAGE = "This feature is currently disabled by the administrator.";
