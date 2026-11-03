export const REPO_ROOT: string;
export const GUARD_PATH: string;
export const DEFAULT_APP_PORT: number;
export const DEFAULT_MOCK_PORT: number;
export const MOCK_MODELS: { transcription: string; note: string; chat: string };
export const BLOCKED_ENV: string[];

export interface MockPaths {
  root: string;
  db: string;
  audio: string;
  run: string;
  tmp: string;
  state: string;
  secrets: string;
  meta: string;
  mockRequests: string;
  mockOut: string;
  appOut: string;
  credentials: string;
}

export interface MockSecrets {
  encryptionKey: string;
  ownerEmail: string;
  ownerPassword: string;
  doctorEmail: string;
  doctorPassword: string;
  shutdownToken: string;
}

export function mockPaths(repoRoot?: string): MockPaths;
export function assertIsolated(paths: Pick<MockPaths, "root" | "db" | "audio">, realDataDir: string): void;
export function validatePorts(appPort: number, mockPort: number): void;
export function passThroughEnv(parentEnv: Record<string, string | undefined>): Record<string, string>;
/** The environment given to the test app: every value is a string (empty strings are deliberate, they block .env). */
export interface MockEnv {
  [name: string]: string;
  DATA_DIR: string;
  CONSULTATIONS_AUDIO_DIR: string;
  TEMP: string;
  APP_BASE_URL: string;
  GEMINI_API_KEY: string;
  GOOGLE_GEMINI_BASE_URL: string;
  NODE_OPTIONS: string;
  CONSULTATIONS_ENCRYPTION_KEY: string;
  BOOTSTRAP_OWNER_PASSWORD: string;
}
export function buildMockEnv(input: { paths: MockPaths; appPort: number; mockPort: number; secrets: MockSecrets; parentEnv?: Record<string, string | undefined> }): MockEnv;
export function buildMockServerEnv(input: { shutdownToken: string; parentEnv?: Record<string, string | undefined> }): Record<string, string>;
export function generateSecrets(random?: (size: number) => Buffer): MockSecrets;
export function copyRealDatabase(input: { realDataDir: string; destDir: string }): Promise<string>;
export function prepareCopy(input: { dbFile: string; secrets: MockSecrets }): Promise<void>;
export function makeTestWav(options?: { seconds?: number; sampleRate?: number }): Buffer;
export function runChecks(input: { appBase: string; mockBase: string; paths: MockPaths; secrets: MockSecrets; realDataDir: string }): Promise<boolean>;
