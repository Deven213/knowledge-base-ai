import type Database from "better-sqlite3";

export const DEFAULT_ORG_ID: string;
export const PASSWORD_MIN_LENGTH: number;
export const PASSWORD_MAX_LENGTH: number;
export const SCRYPT_PARAMS: { N: number; r: number; p: number };
export const MIN_SCHEMA_VERSION: number;

export function normalizeEmail(email: string): string;
export function maskEmail(email: string): string;
export function hashPassword(password: string, params?: { N: number; r: number; p: number }): string;
export function verifyPassword(password: string, stored: string): boolean;
export function passwordProblem(password: unknown, email: string): string | null;

export interface OwnerFacts {
  exists: boolean;
  userId: string | null;
  status: string | null;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  passwordMatchesEnv: boolean | null;
  workspaces: { id: string; name: string; role: string; status: string }[];
  canSignIn: boolean;
  defaultWorkspace: { name: string; status: string } | null;
  otherSuperAdmins: number;
}
export interface RecoveryPlan {
  steps: { code: string; text: string }[];
  blockers: string[];
  notes: string[];
}
export interface RecoveryResult {
  applied: boolean;
  before: OwnerFacts;
  plan: RecoveryPlan;
  after: OwnerFacts;
}

export function inspectOwner(db: Database.Database, input: { email: string; password: string }): OwnerFacts;
export function planRecovery(facts: OwnerFacts, input: { email: string; password: string; resetPassword?: boolean }): RecoveryPlan;
export function recoverOwner(
  db: Database.Database,
  input: { email: string; password: string; name?: string | null; apply?: boolean; resetPassword?: boolean; params?: { N: number; r: number; p: number } },
): RecoveryResult;
export function main(argv?: string[], env?: Record<string, string | undefined>, print?: (line: string) => void): Promise<number>;
