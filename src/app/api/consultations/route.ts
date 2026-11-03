import { NextResponse } from "next/server";
import { z } from "zod";
import { CONSENT_GIVEN_BY, CONSENT_LANGUAGES, CONSENT_METHODS, CONSENT_VERSION } from "@/lib/consultation-consent";
import { AUDIO_MIME_TYPES, LANGUAGE_HINTS, RECORDER_BITS_PER_SECOND, UPLOAD_PART_BYTES, type ConsultationsOverviewDTO } from "@/lib/consultations";
import { consultationRoute } from "@/server/consultations/api";
import { consentFingerprint } from "@/server/consultations/consent";
import { ConsultationError } from "@/server/consultations/errors";
import { getConfig } from "@/server/config";
import { jsonError, zodMessage } from "@/server/http";
import { withTenant } from "@/server/tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z
  .object({
    patientLabel: z.string().trim().min(1, "Enter the patient's name or record number.").max(120),
    languageHint: z.enum(LANGUAGE_HINTS).default("auto"),
    consent: z
      .object({
        version: z.string(),
        language: z.enum(CONSENT_LANGUAGES),
        givenBy: z.enum(CONSENT_GIVEN_BY.map((g) => g.value) as [string, ...string[]]),
        method: z.enum(CONSENT_METHODS.map((m) => m.value) as [string, ...string[]]),
        /** The doctor's explicit confirmation that the patient was told and agreed. Must be literally true. */
        confirmed: z.literal(true, { error: "Consent must be confirmed before a consultation can be recorded." }),
      })
      .strict(),
  })
  .strict();

/** This doctor's consultations, plus the limits the recorder must follow. */
export const GET = withTenant("consultations:use", (request, tenant) =>
  consultationRoute("GET /api/consultations", tenant, request, null, ({ services }) => {
    const config = getConfig();
    const body: ConsultationsOverviewDTO = {
      consultations: services.consultations.list(),
      limits: {
        maxMinutes: config.CONSULTATIONS_MAX_MINUTES,
        maxAudioBytes: Math.floor(config.CONSULTATIONS_MAX_AUDIO_MB * 1024 * 1024),
        partBytes: UPLOAD_PART_BYTES,
        bitsPerSecond: RECORDER_BITS_PER_SECOND,
        mimeTypes: AUDIO_MIME_TYPES,
      },
      consentVersion: CONSENT_VERSION,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  }),
);

/** Starts a consultation. Consent is part of creating it: there is no consultation without a recorded consent. */
export const POST = withTenant("consultations:use", (request, tenant) =>
  consultationRoute("POST /api/consultations", tenant, request, null, async ({ services, gate, audit }) => {
    const parsed = createSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) return jsonError(400, zodMessage(parsed.error));
    const { patientLabel, languageHint, consent } = parsed.data;
    if (consent.version !== CONSENT_VERSION) {
      throw new ConsultationError(409, "consent_outdated", "The consent wording was updated. Reload the page and confirm consent again.");
    }
    const id = services.consultations.create({
      patientLabel,
      languageHint,
      consent: {
        textVersion: CONSENT_VERSION,
        textSha256: consentFingerprint(consent.language),
        language: consent.language,
        givenBy: consent.givenBy as "patient" | "guardian" | "representative",
        method: consent.method as "verbal" | "written",
      },
    });
    audit("consultation.create", id, { languageHint });
    audit("consultation.consent.record", id, { textVersion: CONSENT_VERSION, language: consent.language, givenBy: consent.givenBy, method: consent.method });
    return NextResponse.json({ consultation: services.consultations.detail(id, gate) }, { status: 201, headers: { "Cache-Control": "no-store" } });
  }),
);
