import "server-only";
import { createHash } from "node:crypto";
import { CONSENT_TEXT, CONSENT_VERSION, type ConsentLanguage } from "@/lib/consultation-consent";

/** A fingerprint of the exact words the patient was given, in the language it was given in. Stored with the consent. */
export function consentFingerprint(language: ConsentLanguage): string {
  const text = CONSENT_TEXT[language];
  return createHash("sha256").update([CONSENT_VERSION, language, text.title, ...text.statements].join("\n")).digest("hex");
}
