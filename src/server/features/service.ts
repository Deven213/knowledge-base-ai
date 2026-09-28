import "server-only";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  FEATURES,
  featureDefinition,
  resolveFeatures,
  toAvailability,
  type FeatureAvailability,
  type FeatureKey,
  type FeatureState,
} from "@/lib/features";
import { getDb } from "../db/client";

/** Enabling a feature whose dependency is off. */
export class FeatureDependencyError extends Error {}

/**
 * Stores and reads feature flags. The feature list, names and dependencies are defined in code
 * (lib/features.ts); the database holds the administrator's on/off switch per feature.
 */
export class FeatureFlagService {
  private synced = false;

  constructor(private readonly db: Database.Database) {}

  /**
   * Makes sure every feature in code has a row (new features get their safe default) and that
   * names, descriptions, categories and dependencies match the code. Switches are never overwritten.
   */
  private sync(): void {
    if (this.synced) return;
    const insert = this.db.prepare(
      `INSERT INTO feature_flags (id, key, name, description, category, enabled, depends_on)
       VALUES (@id, @key, @name, @description, @category, @enabled, @dependsOn)
       ON CONFLICT(key) DO UPDATE SET
         name = excluded.name, description = excluded.description,
         category = excluded.category, depends_on = excluded.depends_on
       WHERE name IS NOT excluded.name OR description IS NOT excluded.description
          OR category IS NOT excluded.category OR depends_on IS NOT excluded.depends_on`,
    );
    this.db.transaction(() => {
      for (const f of FEATURES) {
        insert.run({
          id: randomUUID(),
          key: f.key,
          name: f.name,
          description: f.description,
          category: f.category,
          enabled: f.defaultEnabled ? 1 : 0,
          dependsOn: f.dependsOn,
        });
      }
    })();
    this.synced = true;
  }

  private switches(): Partial<Record<FeatureKey, boolean>> {
    this.sync();
    const rows = this.db.prepare(`SELECT key, enabled FROM feature_flags`).all() as { key: string; enabled: number }[];
    const out: Partial<Record<FeatureKey, boolean>> = {};
    for (const r of rows) {
      if (FEATURES.some((f) => f.key === r.key)) out[r.key as FeatureKey] = r.enabled === 1;
    }
    return out;
  }

  getFeatureFlags(): FeatureState[] {
    return resolveFeatures(this.switches());
  }

  /** True when the feature is switched on AND all of its dependencies are available. */
  isFeatureEnabled(key: FeatureKey): boolean {
    return this.getFeatureFlags().find((f) => f.key === key)!.available;
  }

  /** Persists a switch. Enabling is refused while a dependency is unavailable. Returns the new states. */
  setFeatureEnabled(key: FeatureKey, enabled: boolean): FeatureState[] {
    const before = this.getFeatureFlags();
    if (enabled) {
      const dep = featureDefinition(key).dependsOn;
      if (dep && !before.find((f) => f.key === dep)!.available) {
        throw new FeatureDependencyError(`${featureDefinition(key).name} depends on ${featureDefinition(dep).name}. Enable ${featureDefinition(dep).name} first.`);
      }
    }
    this.db
      .prepare(`UPDATE feature_flags SET enabled = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key = ?`)
      .run(enabled ? 1 : 0, key);
    return this.getFeatureFlags();
  }
}

/** Safe defaults: existing features on, roadmap features off. Used if the flags can't be loaded. */
export function defaultFeatureFlags(): FeatureState[] {
  return resolveFeatures({});
}

// Module-level (not global) so a dev hot-reload re-syncs rows with changed feature definitions.
let service: FeatureFlagService | undefined;

export function getFeatureFlagService(): FeatureFlagService {
  service ??= new FeatureFlagService(getDb());
  return service;
}

/**
 * All feature states. Never throws: if the database or configuration can't be read, the app keeps
 * running on safe defaults instead of becoming unavailable.
 */
export function getFeatureFlags(): FeatureState[] {
  try {
    return getFeatureFlagService().getFeatureFlags();
  } catch (err) {
    console.error("[features] could not load feature flags; using safe defaults:", err instanceof Error ? err.message : err);
    return defaultFeatureFlags();
  }
}

export function isFeatureEnabled(key: FeatureKey): boolean {
  return getFeatureFlags().find((f) => f.key === key)!.available;
}

export function getFeatureAvailability(): FeatureAvailability {
  return toAvailability(getFeatureFlags());
}
