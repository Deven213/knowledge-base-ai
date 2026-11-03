"use client";

import { useState } from "react";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { Spinner } from "../ui";

/** Email + password sign-in. The session cookie is set by the server (httpOnly); nothing is stored in the browser. */
export function LoginForm({ redirect, emailPlaceholder }: { redirect: string; emailPlaceholder: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, redirect }),
      });
      const body = (await res.json().catch(() => ({}))) as { redirect?: string; error?: string };
      if (!res.ok) {
        // 401 wrong details, 403 the workspace is suspended, 429 too many attempts: the server's message is safe to show for these.
        setError([401, 403, 429].includes(res.status) ? (body.error ?? "Invalid email or password.") : "Sign-in is unavailable right now. Please try again.");
        setPassword("");
        return;
      }
      // Full navigation so the product loads with the new session.
      window.location.assign(body.redirect ?? "/admin");
    } catch {
      setError("Sign-in is unavailable right now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="mt-6 space-y-4" noValidate>
      <div>
        <label htmlFor="login-email" className="label">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          className="input"
          placeholder={emailPlaceholder}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor="login-password" className="label">
          Password
        </label>
        <div className="relative">
          <input
            id="login-password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            required
            className="input pr-10"
            placeholder="••••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? "Hide password" : "Show password"}
            className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
          >
            {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy || !email.trim() || !password} className="btn btn-dark w-full py-2.5">
        {busy ? <Spinner /> : <LogIn className="h-4 w-4" />}
        {busy ? "Signing in…" : "Sign In"}
      </button>
    </form>
  );
}
