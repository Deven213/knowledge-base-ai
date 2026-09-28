"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Menu, X } from "lucide-react";
import { Logo } from "../Logo";

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#sources", label: "Sources" },
  { href: "#ai-models", label: "AI Models" },
];

/** Public header: section links, Sign In and Try Demo (or "Open app" when already signed in). */
export function LandingHeader({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  const actions = signedIn ? (
    <Link href="/app" className="btn btn-dark">
      Open app <ArrowRight className="h-4 w-4" />
    </Link>
  ) : (
    <>
      <Link href="/login" className="btn btn-ghost text-slate-700">
        Sign In
      </Link>
      <Link href="/login" className="btn bg-brand-600 text-white shadow-sm hover:bg-brand-700">
        Try Demo
      </Link>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="Home" onClick={() => setOpen(false)}>
          <Logo />
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <a key={n.href} href={n.href} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900">
              {n.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-2 md:flex">{actions}</div>
        <button
          type="button"
          className="btn btn-ghost p-2 md:hidden"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="landing-menu"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {open && (
        <div id="landing-menu" className="border-t border-slate-200 bg-white px-4 pt-2 pb-4 md:hidden">
          <nav aria-label="Main" className="flex flex-col">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">
                {n.label}
              </a>
            ))}
          </nav>
          <div className="mt-3 grid grid-cols-2 gap-2 [&>a]:justify-center">{actions}</div>
        </div>
      )}
    </header>
  );
}
