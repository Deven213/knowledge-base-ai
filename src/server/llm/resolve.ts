import "server-only";
import type Database from "better-sqlite3";
import {
  PROVIDER_ENV_VARS,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type AISettingsDTO,
  type ProviderId,
  type ProviderStatusDTO,
  type ValueSource,
} from "@/lib/types";
import { supportsImageInput } from "@/lib/capabilities";
import type { AppConfig } from "../config";
import { AppSettingsRepository, ProviderSettingsRepository } from "../db/repositories";
import { last4 } from "../security/redact";

const ACTIVE_PROVIDER_KEY = "active_provider";

export interface ResolvedProvider {
  apiKey: string | null;
  model: string | null;
  modelSource: ValueSource;
  envModel: string | null;
}

/**
 * - API keys: read only from .env (never stored, never sent to the browser).
 * - Model IDs: UI override (SQLite) → .env → none. No model IDs are built into the code.
 * - Active provider: chosen in AI Model Settings, falling back to DEFAULT_AI_PROVIDER.
 */
export class ProviderConfigService {
  private readonly models: ProviderSettingsRepository;
  private readonly settings: AppSettingsRepository;

  constructor(
    db: Database.Database,
    private readonly config: AppConfig,
  ) {
    this.models = new ProviderSettingsRepository(db);
    this.settings = new AppSettingsRepository(db);
  }

  private env(name: string): string | null {
    const value = this.config[name as keyof AppConfig];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  /** Includes the API key: server-side use only, never serialise this. */
  resolve(provider: ProviderId): ResolvedProvider {
    const vars = PROVIDER_ENV_VARS[provider];
    const envModel = this.env(vars.model);
    const uiModel = this.models.getModel(provider)?.trim() || null;
    return {
      apiKey: this.env(vars.apiKey),
      model: uiModel ?? envModel,
      modelSource: uiModel ? "ui" : envModel ? "env" : "none",
      envModel,
    };
  }

  /** Safe for the browser: reveals only whether a key is set and its last four characters. */
  status(provider: ProviderId): ProviderStatusDTO {
    const r = this.resolve(provider);
    const vars = PROVIDER_ENV_VARS[provider];
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      key: { configured: r.apiKey !== null, last4: r.apiKey ? last4(r.apiKey) || null : null, envVar: vars.apiKey },
      model: { value: r.model, source: r.modelSource, envValue: r.envModel, envVar: vars.model },
      capabilities: { imageInput: supportsImageInput(provider, r.model) },
      ready: r.apiKey !== null && r.model !== null,
    };
  }

  activeProvider(): ProviderId {
    const saved = this.settings.get(ACTIVE_PROVIDER_KEY);
    return saved && (PROVIDER_IDS as readonly string[]).includes(saved)
      ? (saved as ProviderId)
      : this.config.DEFAULT_AI_PROVIDER;
  }

  setActiveProvider(provider: ProviderId): void {
    this.settings.set(ACTIVE_PROVIDER_KEY, provider);
  }

  saveModel(provider: ProviderId, model: string | null): void {
    this.models.saveModel(provider, model?.trim() || null);
  }

  overview(): AISettingsDTO {
    return { activeProvider: this.activeProvider(), providers: PROVIDER_IDS.map((p) => this.status(p)) };
  }
}
