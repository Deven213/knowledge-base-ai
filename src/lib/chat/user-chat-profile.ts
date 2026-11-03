import { LANGUAGES } from "../languages";

// Optional "a few details" for a chat session. Kept apart from the AI/RAG types on purpose: it is
// stored only in this browser tab's sessionStorage and is never sent to an AI provider or put in a URL.

export const GENDERS = [
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
  { value: "other", label: "Other" },
] as const;
export type Gender = (typeof GENDERS)[number]["value"];

export interface UserChatProfile {
  name?: string;
  age?: number;
  /** Country calling code, e.g. "+91" (stored with the number, never shown in the transcript). */
  countryCode?: string;
  mobile?: string;
  gender?: Gender;
  condition?: string;
  /** Answer language code from lib/languages.ts. */
  preferredLanguage?: string;
  additionalInformation?: string;
}

/** Calling codes offered in the selector; the first is the default. Extend freely. */
export const COUNTRY_CODES = [
  { code: "+91", label: "India" },
  { code: "+1", label: "United States / Canada" },
  { code: "+44", label: "United Kingdom" },
  { code: "+971", label: "United Arab Emirates" },
  { code: "+61", label: "Australia" },
] as const;

/**
 * Suggestions for "Condition / Purpose". Generic purposes only (no medical conditions are built in);
 * any free text is accepted. Change this list to fit the knowledge base.
 */
export const PURPOSE_SUGGESTIONS: readonly string[] = [
  "General information",
  "Understanding a document",
  "Usage instructions",
  "Side effects or warnings",
  "Other",
];

/** Preferred languages = the app's answer languages, so adding one in lib/languages.ts adds it here. */
export const PREFERRED_LANGUAGES = LANGUAGES.map((l) => ({ code: l.code, label: l.label, nativeName: l.nativeName }));

export const LIMITS = { name: 100, condition: 120, additionalInformation: 1000, ageMax: 130 } as const;

/** Raw form values (everything is a string in inputs). */
export interface UserChatProfileForm {
  name: string;
  age: string;
  countryCode: string;
  mobile: string;
  gender: "" | Gender;
  condition: string;
  preferredLanguage: string;
  additionalInformation: string;
}

export const EMPTY_FORM: UserChatProfileForm = {
  name: "",
  age: "",
  countryCode: COUNTRY_CODES[0].code,
  mobile: "",
  gender: "",
  condition: "",
  preferredLanguage: "",
  additionalInformation: "",
};

export type ProfileErrors = Partial<Record<keyof UserChatProfileForm, string>>;

/**
 * Validates only what was filled in (every field is optional) and returns the cleaned profile.
 * Empty fields are simply left out.
 */
export function validateProfileForm(form: UserChatProfileForm): { profile: UserChatProfile; errors: ProfileErrors } {
  const errors: ProfileErrors = {};
  const profile: UserChatProfile = {};

  const name = form.name.trim().replace(/\s+/g, " ");
  if (name) {
    if (name.length > LIMITS.name) errors.name = `Use ${LIMITS.name} characters or fewer.`;
    else profile.name = name;
  }

  const age = form.age.trim();
  if (age) {
    const n = Number(age);
    if (!/^\d{1,3}$/.test(age) || !Number.isInteger(n) || n < 0 || n > LIMITS.ageMax) errors.age = `Enter an age between 0 and ${LIMITS.ageMax}.`;
    else profile.age = n;
  }

  const digits = form.mobile.replace(/[\s()-]/g, "");
  if (digits) {
    const code = COUNTRY_CODES.find((c) => c.code === form.countryCode)?.code;
    if (!code) errors.countryCode = "Choose a country code.";
    else if (!/^\d{6,15}$/.test(digits)) errors.mobile = "Enter a valid mobile number (6–15 digits).";
    else if (code === "+91" && !/^[6-9]\d{9}$/.test(digits)) errors.mobile = "Enter a 10-digit Indian mobile number.";
    else {
      profile.countryCode = code;
      profile.mobile = digits;
    }
  }

  if (form.gender) {
    if (GENDERS.some((g) => g.value === form.gender)) profile.gender = form.gender;
    else errors.gender = "Choose an option.";
  }

  const condition = form.condition.trim();
  if (condition) {
    if (condition.length > LIMITS.condition) errors.condition = `Use ${LIMITS.condition} characters or fewer.`;
    else profile.condition = condition;
  }

  if (form.preferredLanguage) {
    if (PREFERRED_LANGUAGES.some((l) => l.code === form.preferredLanguage)) profile.preferredLanguage = form.preferredLanguage;
    else errors.preferredLanguage = "Choose a language from the list.";
  }

  const info = form.additionalInformation.trim();
  if (info) {
    if (info.length > LIMITS.additionalInformation) errors.additionalInformation = `Use ${LIMITS.additionalInformation} characters or fewer.`;
    else profile.additionalInformation = info;
  }

  return { profile, errors };
}

/** Back to form values (for editing a saved profile). */
export function profileToForm(p: UserChatProfile | null): UserChatProfileForm {
  if (!p) return { ...EMPTY_FORM };
  return {
    name: p.name ?? "",
    age: p.age !== undefined ? String(p.age) : "",
    countryCode: p.countryCode ?? EMPTY_FORM.countryCode,
    mobile: p.mobile ?? "",
    gender: p.gender ?? "",
    condition: p.condition ?? "",
    preferredLanguage: p.preferredLanguage ?? "",
    additionalInformation: p.additionalInformation ?? "",
  };
}

// ── Session storage (this tab/browser session only; never localStorage) ──

const PROFILE_KEY = "kb.chatProfile";
const PROMPTED_KEY = "kb.chatProfilePrompted";

type SessionStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function store(s?: SessionStore): SessionStore | null {
  if (s) return s;
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null; // storage disabled
  }
}

export function loadProfile(s?: SessionStore): UserChatProfile | null {
  try {
    const raw = store(s)?.getItem(PROFILE_KEY);
    if (!raw) return null;
    // Re-validate whatever is stored (it could have been edited by hand).
    const { profile, errors } = validateProfileForm(profileToForm(JSON.parse(raw) as UserChatProfile));
    return Object.keys(errors).length === 0 && Object.keys(profile).length > 0 ? profile : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: UserChatProfile, s?: SessionStore): void {
  try {
    const target = store(s);
    if (Object.keys(profile).length === 0) target?.removeItem(PROFILE_KEY);
    else target?.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    /* storage full or disabled: the chat works without it */
  }
}

/** Whether the details sheet was already shown (closed, skipped or submitted) in this session. */
export function wasPrompted(s?: SessionStore): boolean {
  try {
    return store(s)?.getItem(PROMPTED_KEY) === "1";
  } catch {
    return true; // can't remember → don't nag
  }
}

export function markPrompted(s?: SessionStore): void {
  try {
    store(s)?.setItem(PROMPTED_KEY, "1");
  } catch {
    /* ignore */
  }
}
