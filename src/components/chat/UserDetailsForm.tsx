"use client";

import { useId, useState } from "react";
import {
  COUNTRY_CODES,
  GENDERS,
  LIMITS,
  PREFERRED_LANGUAGES,
  PURPOSE_SUGGESTIONS,
  validateProfileForm,
  type ProfileErrors,
  type UserChatProfile,
  type UserChatProfileForm,
} from "@/lib/chat/user-chat-profile";

/**
 * The optional details. Every field may be left empty; only what is filled in is validated.
 * Submitting calls `onSubmit` with the cleaned profile (nothing is sent anywhere from here).
 */
export function UserDetailsForm({
  id,
  initial,
  onSubmit,
}: {
  /** Form id, so buttons outside the scrolling area can submit it. */
  id: string;
  initial: UserChatProfileForm;
  onSubmit: (profile: UserChatProfile) => void;
}) {
  const [form, setForm] = useState<UserChatProfileForm>(initial);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const uid = useId();
  const fid = (name: string) => `${uid}-${name}`;

  function set<K extends keyof UserChatProfileForm>(key: K, value: UserChatProfileForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = validateProfileForm(form);
    if (Object.keys(result.errors).length > 0) {
      setErrors(result.errors);
      // Move focus to the first field that needs attention.
      const first = (Object.keys(result.errors) as (keyof UserChatProfileForm)[])[0]!;
      document.getElementById(fid(first))?.focus();
      return;
    }
    onSubmit(result.profile);
  }

  const describedBy = (key: keyof UserChatProfileForm) => (errors[key] ? fid(`${key}-error`) : undefined);
  const fieldError = (key: keyof UserChatProfileForm) =>
    errors[key] ? (
      <p id={fid(`${key}-error`)} className="mt-1 text-xs font-medium text-red-600">
        {errors[key]}
      </p>
    ) : null;
  const invalid = (key: keyof UserChatProfileForm) => (errors[key] ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : "");

  return (
    <form id={id} onSubmit={submit} noValidate className="grid gap-x-4 gap-y-4 sm:grid-cols-2">
      <div>
        <label htmlFor={fid("name")} className="label">
          Patient&apos;s Name <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <input
          id={fid("name")}
          className={`input ${invalid("name")}`}
          placeholder="Enter patient's name"
          autoComplete="off"
          maxLength={LIMITS.name + 20}
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          aria-invalid={!!errors.name}
          aria-describedby={describedBy("name")}
        />
        {fieldError("name")}
      </div>

      <div>
        <label htmlFor={fid("age")} className="label">
          Age <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <div className="relative">
          <input
            id={fid("age")}
            className={`input pr-14 ${invalid("age")}`}
            placeholder="Enter age"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            maxLength={3}
            value={form.age}
            onChange={(e) => set("age", e.target.value.replace(/[^\d]/g, ""))}
            aria-invalid={!!errors.age}
            aria-describedby={describedBy("age") ?? fid("age-unit")}
          />
          <span id={fid("age-unit")} className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-slate-400">
            years
          </span>
        </div>
        {fieldError("age")}
      </div>

      <div>
        <label htmlFor={fid("mobile")} className="label">
          Mobile Number <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <div className="flex gap-2">
          <select
            id={fid("countryCode")}
            aria-label="Country code"
            className={`input w-[5.5rem] shrink-0 px-2 ${invalid("countryCode")}`}
            value={form.countryCode}
            onChange={(e) => set("countryCode", e.target.value)}
          >
            {COUNTRY_CODES.map((c) => (
              <option key={c.code} value={c.code} title={c.label}>
                {c.code}
              </option>
            ))}
          </select>
          <input
            id={fid("mobile")}
            type="tel"
            className={`input min-w-0 flex-1 ${invalid("mobile")}`}
            placeholder="Enter mobile number"
            inputMode="tel"
            autoComplete="off"
            maxLength={20}
            value={form.mobile}
            onChange={(e) => set("mobile", e.target.value.replace(/[^\d\s()-]/g, ""))}
            aria-invalid={!!errors.mobile}
            aria-describedby={describedBy("mobile")}
          />
        </div>
        {fieldError("countryCode")}
        {fieldError("mobile")}
      </div>

      <fieldset>
        <legend className="label">
          Gender <span className="font-normal text-slate-400">(optional)</span>
        </legend>
        <div className="flex flex-wrap gap-2">
          {GENDERS.map((g) => {
            const checked = form.gender === g.value;
            return (
              <label
                key={g.value}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500/40 ${
                  checked ? "border-brand-500 bg-brand-50 text-brand-800" : "border-slate-200 text-slate-700 hover:bg-slate-50"
                }`}
              >
                <input
                  type="radio"
                  name={fid("gender")}
                  value={g.value}
                  checked={checked}
                  onChange={() => set("gender", g.value)}
                  // Clicking the selected option again clears it (the field is optional).
                  onClick={() => checked && set("gender", "")}
                  className="accent-brand-600"
                />
                {g.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor={fid("condition")} className="label">
          Condition / Purpose <span className="font-normal text-slate-400">(optional)</span>
        </label>
        {/* Free text with suggestions (datalist): nothing is limited to a fixed list. */}
        <input
          id={fid("condition")}
          className={`input ${invalid("condition")}`}
          placeholder="Select or enter"
          list={fid("condition-options")}
          autoComplete="off"
          maxLength={LIMITS.condition + 20}
          value={form.condition}
          onChange={(e) => set("condition", e.target.value)}
          aria-invalid={!!errors.condition}
          aria-describedby={describedBy("condition")}
        />
        <datalist id={fid("condition-options")}>
          {PURPOSE_SUGGESTIONS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        {fieldError("condition")}
      </div>

      <div>
        <label htmlFor={fid("preferredLanguage")} className="label">
          Preferred Language <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <select
          id={fid("preferredLanguage")}
          className={`input ${invalid("preferredLanguage")}`}
          value={form.preferredLanguage}
          onChange={(e) => set("preferredLanguage", e.target.value)}
        >
          <option value="">No preference</option>
          {PREFERRED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label === l.nativeName ? l.label : `${l.label} (${l.nativeName})`}
            </option>
          ))}
        </select>
        {fieldError("preferredLanguage")}
      </div>

      <div className="sm:col-span-2">
        <label htmlFor={fid("additionalInformation")} className="label">
          Additional Information <span className="font-normal text-slate-400">(optional)</span>
        </label>
        <textarea
          id={fid("additionalInformation")}
          rows={3}
          className={`input resize-y ${invalid("additionalInformation")}`}
          placeholder="Any specific details or concerns..."
          maxLength={LIMITS.additionalInformation + 50}
          value={form.additionalInformation}
          onChange={(e) => set("additionalInformation", e.target.value)}
          aria-invalid={!!errors.additionalInformation}
          aria-describedby={describedBy("additionalInformation")}
        />
        {fieldError("additionalInformation")}
      </div>
    </form>
  );
}
