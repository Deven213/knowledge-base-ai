import "server-only";

// The context every sealed value is bound to (see security/vault.ts). It names the organization, the consultation (or the
// stored audio object) and what the value is, so a sealed value can't be moved to another row, consultation or customer.
export const sealContext = {
  patient: (orgId: string, consultationId: string) => `consultation|${orgId}|${consultationId}|patient`,
  transcript: (orgId: string, consultationId: string, version: number) => `consultation|${orgId}|${consultationId}|transcript|${version}`,
  note: (orgId: string, consultationId: string, version: number) => `consultation|${orgId}|${consultationId}|note|${version}`,
  audio: (orgId: string, storageKey: string, part: number) => `consultation|${orgId}|${storageKey}|audio|${part}`,
};
