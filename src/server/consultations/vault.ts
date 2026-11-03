import "server-only";
import type { AppConfig } from "../config";
import { Vault } from "../security/vault";
import { ConsultationError } from "./errors";

let cached: { key: string; vault: Vault } | undefined;

/** The vault for this deployment, or a clear refusal when the key hasn't been set (consultations are then simply unavailable). */
export function consultationVault(config: Pick<AppConfig, "CONSULTATIONS_ENCRYPTION_KEY">): Vault {
  const key = config.CONSULTATIONS_ENCRYPTION_KEY;
  if (!key) throw new ConsultationError(503, "not_configured", "Consultations are not set up on this server yet. Ask your administrator.");
  if (!cached || cached.key !== key) cached = { key, vault: new Vault(key) };
  return cached.vault;
}
