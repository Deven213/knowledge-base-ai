import type { Metadata } from "next";
import Link from "next/link";
import { ChangePassword } from "@/components/auth/ChangePassword";
import { LogoutButton } from "@/components/LogoutButton";
import { Logo } from "@/components/Logo";
import { BRAND } from "@/lib/brand";
import { requireSessionAllowingPasswordChange } from "@/server/auth/service";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Choose a new password · ${BRAND.name}`, robots: { index: false } };

/**
 * Where someone with a temporary password is sent (by the login, the proxy, every product layout and the API client).
 * Also reachable by anyone signed in who wants to change their password. It uses its own plain layout: no sidebar,
 * nothing from the product is on this page.
 */
export default async function ChangePasswordPage() {
  const session = await requireSessionAllowingPasswordChange();
  const forced = session.mustChangePassword;

  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(ellipse_at_top,rgba(20,163,139,0.12),transparent_55%),linear-gradient(to_bottom,#f8fafc,#eef2f7)]">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Logo />
        {forced ? <LogoutButton compact /> : (
          <Link href="/admin" className="btn btn-ghost text-sm text-slate-600">
            Back to the app
          </Link>
        )}
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
          <ChangePassword forced={forced} email={session.email} />
        </div>
      </main>
    </div>
  );
}
