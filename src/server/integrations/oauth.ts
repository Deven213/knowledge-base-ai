import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config";
import { decryptSecret, encryptSecret } from "../security/crypto";
import { redactSecrets } from "../security/redact";
import { IntegrationAuthError, IntegrationError } from "./errors";
import type { IntegrationRepository, IntegrationRow } from "./repository";

// OAuth 2.0 authorization-code flow with PKCE for Google Drive and OneDrive.
// Client secrets and tokens stay on the server; tokens are stored AES-256-GCM encrypted.

export type OAuthType = "google_drive" | "onedrive";

interface ProviderSpec {
  label: string;
  callbackSlug: string;
  envVars: (keyof AppConfig)[];
  clientId: (c: AppConfig) => string | undefined;
  clientSecret: (c: AppConfig) => string | undefined;
  authorizeUrl: (c: AppConfig) => string;
  tokenUrl: (c: AppConfig) => string;
  scope: string;
  extraAuthParams: Record<string, string>;
}

const PROVIDERS: Record<OAuthType, ProviderSpec> = {
  google_drive: {
    label: "Google Drive",
    callbackSlug: "google-drive",
    envVars: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"],
    clientId: (c) => c.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: (c) => c.GOOGLE_OAUTH_CLIENT_SECRET,
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    // Read-only access to Drive files (list folders, download files).
    scope: "https://www.googleapis.com/auth/drive.readonly",
    // offline + consent: returns a refresh token so syncs work later without signing in again.
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
  onedrive: {
    label: "OneDrive",
    callbackSlug: "onedrive",
    envVars: ["MICROSOFT_OAUTH_CLIENT_ID", "MICROSOFT_OAUTH_CLIENT_SECRET"],
    clientId: (c) => c.MICROSOFT_OAUTH_CLIENT_ID,
    clientSecret: (c) => c.MICROSOFT_OAUTH_CLIENT_SECRET,
    authorizeUrl: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.MICROSOFT_OAUTH_TENANT)}/oauth2/v2.0/authorize`,
    tokenUrl: (c) => `https://login.microsoftonline.com/${encodeURIComponent(c.MICROSOFT_OAUTH_TENANT)}/oauth2/v2.0/token`,
    // Read-only file access + profile (for the account name); offline_access returns a refresh token.
    scope: "offline_access Files.Read User.Read",
    extraAuthParams: { response_mode: "query", prompt: "select_account" },
  },
};

export const providerLabel = (type: OAuthType) => PROVIDERS[type].label;

export function redirectUri(type: OAuthType, config: AppConfig): string {
  return `${config.APP_BASE_URL}/api/integrations/${PROVIDERS[type].callbackSlug}/callback`;
}

/** Whether the server can run this OAuth flow, and which environment variables are missing (names only). */
export function oauthStatus(type: OAuthType, config: AppConfig): { configured: boolean; missingConfig: string[]; redirectUri: string } {
  const missing: string[] = PROVIDERS[type].envVars.filter((k) => !config[k]);
  if (!config.INTEGRATIONS_ENCRYPTION_KEY) missing.push("INTEGRATIONS_ENCRYPTION_KEY");
  return { configured: missing.length === 0, missingConfig: missing, redirectUri: redirectUri(type, config) };
}

const base64url = (b: Buffer) => b.toString("base64url");

export function createPkce(): { state: string; verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { state: base64url(randomBytes(24)), verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

export function buildAuthorizeUrl(type: OAuthType, config: AppConfig, state: string, codeChallenge: string): string {
  const p = PROVIDERS[type];
  const url = new URL(p.authorizeUrl(config));
  const params: Record<string, string> = {
    client_id: p.clientId(config) ?? "",
    redirect_uri: redirectUri(type, config),
    response_type: "code",
    scope: p.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...p.extraAuthParams,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

/** Constant-time comparison of the state returned by the provider and the one in our cookie. */
export function statesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

async function tokenRequest(type: OAuthType, config: AppConfig, body: Record<string, string>): Promise<StoredTokens & { raw: Record<string, unknown> }> {
  const p = PROVIDERS[type];
  let res: Response;
  try {
    res = await fetch(p.tokenUrl(config), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: p.clientId(config) ?? "", client_secret: p.clientSecret(config) ?? "", ...body }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new IntegrationError(`${p.label} authentication failed: the sign-in service could not be reached.`, 502);
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof json.access_token !== "string") {
    // Log the provider's error code/description only (never tokens or secrets).
    const detail = redactSecrets(`${String(json.error ?? res.status)}: ${String(json.error_description ?? "")}`.slice(0, 300), [p.clientSecret(config) ?? ""]);
    console.error(`[integrations:${type}] token request failed — ${detail}`);
    if (json.error === "invalid_grant") throw new IntegrationAuthError(`${p.label} connection expired or was revoked. Reconnect ${p.label}.`);
    throw new IntegrationError(`${p.label} authentication failed.`, 502);
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    raw: json,
  };
}

export async function exchangeCode(type: OAuthType, config: AppConfig, code: string, codeVerifier: string): Promise<StoredTokens> {
  const t = await tokenRequest(type, config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(type, config),
    code_verifier: codeVerifier,
    ...(type === "onedrive" ? { scope: PROVIDERS.onedrive.scope } : {}),
  });
  if (!t.refreshToken) throw new IntegrationError(`${PROVIDERS[type].label} did not grant offline access. Try connecting again.`, 502);
  return { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt };
}

/** Stores and refreshes an integration's tokens; plaintext tokens only ever exist in memory. */
export class TokenStore {
  constructor(
    private readonly repo: IntegrationRepository,
    private readonly config: AppConfig,
  ) {}

  private key(): string {
    if (!this.config.INTEGRATIONS_ENCRYPTION_KEY) {
      throw new IntegrationError("INTEGRATIONS_ENCRYPTION_KEY is not set, so OAuth connections can't be stored securely.", 503);
    }
    return this.config.INTEGRATIONS_ENCRYPTION_KEY;
  }

  save(integrationId: string, tokens: StoredTokens): void {
    this.repo.saveCredentials(integrationId, encryptSecret(JSON.stringify(tokens), this.key()));
  }

  load(integrationId: string): StoredTokens | null {
    const secret = this.repo.getCredentials(integrationId);
    if (!secret) return null;
    try {
      return JSON.parse(decryptSecret(secret, this.key())) as StoredTokens;
    } catch (err) {
      throw new IntegrationAuthError(err instanceof Error ? err.message : "Stored credentials are unreadable. Reconnect the integration.");
    }
  }

  /** A valid access token, refreshed (and re-saved) when it is about to expire or `forceRefresh` is set. */
  async getAccessToken(row: IntegrationRow, forceRefresh = false): Promise<string> {
    const type = row.type as OAuthType;
    const tokens = this.load(row.id);
    if (!tokens) throw new IntegrationAuthError(`${PROVIDERS[type].label} is not connected.`);
    if (!forceRefresh && tokens.expiresAt - 60_000 > Date.now()) return tokens.accessToken;
    if (!tokens.refreshToken) throw new IntegrationAuthError(`${PROVIDERS[type].label} connection expired. Reconnect ${PROVIDERS[type].label}.`);
    const fresh = await tokenRequest(type, this.config, {
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      ...(type === "onedrive" ? { scope: PROVIDERS.onedrive.scope } : {}),
    });
    // Microsoft rotates refresh tokens; Google usually doesn't return a new one.
    this.save(row.id, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken ?? tokens.refreshToken, expiresAt: fresh.expiresAt });
    return fresh.accessToken;
  }
}

/** Best-effort token revocation on disconnect (Google supports it; Microsoft has no equivalent endpoint). */
export async function revokeTokens(type: OAuthType, tokens: StoredTokens | null): Promise<void> {
  if (type !== "google_drive" || !tokens) return;
  const token = tokens.refreshToken ?? tokens.accessToken;
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}
