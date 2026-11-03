import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInvite } from "@/components/auth/AcceptInvite";
import { Logo } from "@/components/Logo";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: `Join a workspace · ${BRAND.name}`, robots: { index: false } };

/** Public page for invitation links: the person has no account (or session) yet. The token is validated by the server. */
export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const raw = (await searchParams).token;
  const token = (Array.isArray(raw) ? raw[0] : raw) ?? "";

  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(ellipse_at_top,rgba(20,163,139,0.12),transparent_55%),linear-gradient(to_bottom,#f8fafc,#eef2f7)]">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" aria-label={`${BRAND.name} home`}>
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/5 sm:p-8">
          <AcceptInvite token={token} />
        </div>
      </main>
    </div>
  );
}
