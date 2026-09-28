"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Menu, MessageSquare, Settings, ShieldCheck, X } from "lucide-react";
import { useFeatures } from "../features/FeatureProvider";
import { Logo } from "../Logo";
import { LogoutButton } from "../LogoutButton";
import { INTEGRATION_META } from "@/lib/integrations";
import { ADMIN_SECTIONS, sectionHref, type AdminSection } from "./nav";

const linkClass = (active: boolean) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    active ? "brand-gradient text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
  }`;

/** A section with child pages (e.g. Integrations): parent link, expand/collapse, and the children it allows. */
function SectionGroup({ section, onNavigate }: { section: AdminSection; onNavigate?: () => void }) {
  const pathname = usePathname();
  const features = useFeatures();
  const href = sectionHref(section);
  const inSection = pathname === href || pathname.startsWith(`${href}/`);
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? inSection;
  const Icon = section.icon;
  const children = (section.children ?? []).filter((c) => features[c.feature]);
  return (
    <div>
      <div className="flex items-center gap-1">
        <Link href={href} onClick={onNavigate} aria-current={pathname === href ? "page" : undefined} className={`${linkClass(pathname === href)} flex-1`}>
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate">{section.label}</span>
        </Link>
        {children.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost p-2"
            aria-expanded={open}
            aria-label={`${open ? "Collapse" : "Expand"} ${section.label}`}
            onClick={() => setExpanded(!open)}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${open ? "" : "-rotate-90"}`} />
          </button>
        )}
      </div>
      {open && children.length > 0 && (
        <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-slate-100 pl-2">
          {children.map((c) => {
            const active = pathname === c.href || pathname.startsWith(`${c.href}/`);
            const ChildIcon = c.icon;
            return (
              <Link
                key={c.href}
                href={c.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${
                  active ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                <ChildIcon className="h-4 w-4 shrink-0" />
                {c.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

const SETTINGS_PAGES = [
  { href: "/settings/general", label: "General" },
  { href: "/settings/features", label: "Feature Management" },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const features = useFeatures();
  const inSettings = pathname.startsWith("/settings");
  return (
    <nav className="flex flex-col gap-0.5" aria-label="Admin sections">
      {/* Only sections whose feature is available (switched on and dependencies on). */}
      {ADMIN_SECTIONS.filter((section) => features[section.feature]).map((section) => {
        if (section.children) return <SectionGroup key={section.slug} section={section} onNavigate={onNavigate} />;
        const href = sectionHref(section);
        const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
        const Icon = section.icon;
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active ? "brand-gradient text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="flex-1 truncate">{section.label}</span>
            {section.status === "soon" && (
              <span
                className={`rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase ${
                  active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-400"
                }`}
              >
                Soon
              </span>
            )}
          </Link>
        );
      })}

      {/* Settings is not feature-managed: always visible. */}
      <div className="my-2 border-t border-slate-100" />
      <Link
        href="/settings/features"
        onClick={onNavigate}
        aria-current={inSettings ? "page" : undefined}
        className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
          inSettings ? "brand-gradient text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        <Settings className="h-4 w-4 shrink-0" />
        <span className="flex-1">Settings</span>
      </Link>
      {inSettings && (
        <div className="mt-0.5 ml-5 flex flex-col gap-0.5 border-l border-slate-100 pl-2">
          {SETTINGS_PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              onClick={onNavigate}
              aria-current={pathname === p.href ? "page" : undefined}
              className={`rounded-md px-2.5 py-1.5 text-sm ${
                pathname === p.href ? "bg-brand-50 font-medium text-brand-700" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}

/** On an integration's page, Open Chat starts a chat with that integration's content selected. */
const CHAT_SOURCE_BY_PAGE: [string, string][] = [
  [INTEGRATION_META.website.href, "website"],
  [INTEGRATION_META.google_drive.href, "google_drive"],
  [INTEGRATION_META.onedrive.href, "onedrive"],
];

function SidebarBody({ onNavigate, userEmail }: { onNavigate?: () => void; userEmail: string }) {
  const chatAvailable = useFeatures().chat;
  const pathname = usePathname();
  const source = CHAT_SOURCE_BY_PAGE.find(([href]) => pathname === href || pathname.startsWith(`${href}/`))?.[1];
  const chatHref = source ? `/chat?source=${source}` : "/chat";
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col items-center gap-2 border-b border-slate-100 px-4 py-5">
        <Logo />
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-blue-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
            <ShieldCheck className="h-3 w-3" /> Admin
          </span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800" title="Demo environment">
            Demo
          </span>
        </div>
      </div>
      {chatAvailable && (
        <div className="px-3 pt-4">
          <Link href={chatHref} onClick={onNavigate} className="btn btn-dark w-full">
            <MessageSquare className="h-4 w-4" /> Open Chat
          </Link>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        <NavLinks onNavigate={onNavigate} />
      </div>
      <div className="flex items-center gap-3 border-t border-slate-100 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
          A
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800">Administrator</p>
          <p className="truncate text-xs text-slate-500" title={userEmail}>
            {userEmail}
          </p>
        </div>
        <LogoutButton compact />
      </div>
    </div>
  );
}

export function AdminSidebar({ userEmail }: { userEmail: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {/* Desktop */}
      <aside className="sticky top-0 hidden h-screen w-76 shrink-0 border-r border-slate-200 bg-white lg:block">
        <SidebarBody userEmail={userEmail} />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <Logo />
        <button type="button" className="btn btn-ghost p-2" aria-label="Open menu" onClick={() => setOpen(true)}>
          <Menu className="h-5 w-5" />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <button
              type="button"
              className="btn btn-ghost absolute top-3 right-3 p-1.5"
              aria-label="Close menu"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarBody userEmail={userEmail} onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
