import { describe, expect, it } from "vitest";
import {
  EMPTY_FORM,
  loadProfile,
  markPrompted,
  profileToForm,
  saveProfile,
  validateProfileForm,
  wasPrompted,
  type UserChatProfileForm,
} from "@/lib/chat/user-chat-profile";

const form = (over: Partial<UserChatProfileForm> = {}): UserChatProfileForm => ({ ...EMPTY_FORM, ...over });

/** In-memory stand-in for window.sessionStorage. */
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

describe("validateProfileForm (everything optional)", () => {
  it("accepts a completely empty form as an empty profile", () => {
    expect(validateProfileForm(form())).toEqual({ profile: {}, errors: {} });
  });

  it("cleans and keeps the fields that were filled in", () => {
    const { profile, errors } = validateProfileForm(
      form({
        name: "  Asha   Patel ",
        age: "54",
        mobile: "98765 43210",
        gender: "female",
        condition: " Type 2 diabetes ",
        preferredLanguage: "gu",
        additionalInformation: " Takes medicine after breakfast. ",
      }),
    );
    expect(errors).toEqual({});
    expect(profile).toEqual({
      name: "Asha Patel",
      age: 54,
      countryCode: "+91",
      mobile: "9876543210",
      gender: "female",
      condition: "Type 2 diabetes", // free text is allowed
      preferredLanguage: "gu",
      additionalInformation: "Takes medicine after breakfast.",
    });
  });

  it("rejects invalid ages and mobile numbers only when they are entered", () => {
    expect(validateProfileForm(form({ age: "200" })).errors.age).toMatch(/between 0 and 130/);
    expect(validateProfileForm(form({ age: "4.5" })).errors.age).toBeDefined();
    expect(validateProfileForm(form({ age: "-3" })).errors.age).toBeDefined();
    expect(validateProfileForm(form({ mobile: "12345" })).errors.mobile).toBeDefined();
    expect(validateProfileForm(form({ mobile: "5876543210" })).errors.mobile).toMatch(/Indian/); // +91 numbers start 6–9
    expect(validateProfileForm(form({ countryCode: "+44", mobile: "7911 123456" })).profile.mobile).toBe("7911123456");
    expect(validateProfileForm(form({ countryCode: "+999", mobile: "9876543210" })).errors.countryCode).toBeDefined();
    expect(validateProfileForm(form({ preferredLanguage: "fr" })).errors.preferredLanguage).toBeDefined();
    expect(validateProfileForm(form({ name: "x".repeat(101) })).errors.name).toBeDefined();
  });

  it("round-trips through the form for editing", () => {
    const { profile } = validateProfileForm(form({ name: "A", age: "7", gender: "other" }));
    expect(validateProfileForm(profileToForm(profile)).profile).toEqual(profile);
  });
});

describe("session storage", () => {
  it("saves and loads the profile, and forgets an empty one", () => {
    const s = memoryStorage();
    expect(loadProfile(s)).toBeNull();
    saveProfile({ name: "A", age: 30 }, s);
    expect(loadProfile(s)).toEqual({ name: "A", age: 30 });
    saveProfile({}, s);
    expect(loadProfile(s)).toBeNull();
  });

  it("ignores tampered or invalid stored data", () => {
    const s = memoryStorage();
    s.setItem("kb.chatProfile", "{not json");
    expect(loadProfile(s)).toBeNull();
    s.setItem("kb.chatProfile", JSON.stringify({ age: 999 }));
    expect(loadProfile(s)).toBeNull();
  });

  it("remembers that the sheet was shown, for this session only", () => {
    const s = memoryStorage();
    expect(wasPrompted(s)).toBe(false);
    markPrompted(s);
    expect(wasPrompted(s)).toBe(true);
  });
});
