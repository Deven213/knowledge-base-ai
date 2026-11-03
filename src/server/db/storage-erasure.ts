import "server-only";
import { getAudioStore } from "../consultations/audio-store";
import type { AppConfig } from "../config";

/**
 * Removes the stored recordings of a workspace that has just been deleted (the folders listed by the deletion helpers' storedObjectKeys,
 * collected before the database rows went). Runs after the deletion commits. A folder that can't be removed is counted, not hidden,
 * and is removed later by the worker's sweep of storage that no recording refers to any more, so nothing lingers.
 */
export async function purgeStoredObjects(config: Pick<AppConfig, "DATA_DIR" | "CONSULTATIONS_AUDIO_DIR">, keys: string[]): Promise<{ removed: number; failed: number }> {
  const store = getAudioStore(config);
  let removed = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      await store.deletePrefix(key);
      removed += 1;
    } catch {
      failed += 1;
    }
  }
  return { removed, failed };
}
