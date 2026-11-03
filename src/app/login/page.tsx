import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, KeyRound, Sparkles } from "lucide-react";
import { LoginForm } from "@/components/auth/LoginForm";
import { Logo } from "@/components/Logo";
import { safeRedirect } from "@/lib/auth-routes";
import { BRAND } from "@/lib/brand";
import { currentSession } from "@/server/auth/service";
import { getConfig } from "@/server/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Sign in · ${BRAND.name}` };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ redirect?: string | string[] }> }) {
  const raw = (await searchParams).redirect;
  const target = safeRedirect(Array.isArray(raw) ? raw[0] : raw);
  if (await currentSession()) redirect(target); // already signed in

  const { DEMO_SHOW_CREDENTIALS, DEMO_USER_EMAIL, DEMO_USER_PASSWORD } = getConfig();
  // The demo panel exists only when a demo account is deliberately set up (it has no built-in password) AND shown.
  const showDemo = DEMO_SHOW_CREDENTIALS && !!DEMO_USER_PASSWORD;

  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(ellipse_at_top,rgba(20,163,139,0.12),transparent_55%),linear-gradient(to_bottom,#f8fafc,#eef2f7)]">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" aria-label={`${BRAND.name} home`}>
          <Logo />
        </Link>
        <Link href="/" className="btn btn-ghost gap-1.5 text-sm text-slate-600">
          <ArrowLeft className="h-4 w-4" /> Back to home
        </Link>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-md motion-safe:animate-[fade-up_0.5s_ease-out_both]">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">Welcome back</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to your {BRAND.category}</p>
            <LoginForm redirect={target} emailPlaceholder={showDemo ? DEMO_USER_EMAIL : "you@company.com"} />
            <p className="mt-5 border-t border-slate-100 pt-4 text-center text-sm text-slate-500">
              First time here? Sign in with the temporary password you were given. You will be asked to choose your own password before you continue.
            </p>
          </div>

          {showDemo && (
            // Rendered on the server; "Use Demo Account" posts a plain form, so the password is never in client JavaScript.
            <section aria-labelledby="demo-account" className="mt-4 rounded-2xl border border-teal-200 bg-teal-50/70 p-5">
              <h2 id="demo-account" className="flex items-center gap-2 text-sm font-semibold text-teal-900">
                <Sparkles className="h-4 w-4" /> Demo Account
              </h2>
              <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-slate-500">Email</dt>
                <dd className="font-mono break-all text-slate-800 select-all">{DEMO_USER_EMAIL}</dd>
                <dt className="text-slate-500">Password</dt>
                <dd className="font-mono break-all text-slate-800 select-all">{DEMO_USER_PASSWORD}</dd>
              </dl>
              <form action="/api/auth/demo" method="post" className="mt-4">
                <input type="hidden" name="redirect" value={target} />
                <button type="submit" className="btn w-full bg-teal-600 text-white hover:bg-teal-700">
                  <KeyRound className="h-4 w-4" /> Use Demo Account
                </button>
              </form>
              <p className="mt-3 text-xs text-teal-900/70">This demo password only signs in to this app. It is not an AI provider key.</p>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
