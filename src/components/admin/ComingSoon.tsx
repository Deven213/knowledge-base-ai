"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CheckCircle2, Clock } from "lucide-react";
import { Badge, PageHeader } from "../ui";
import { ADMIN_SECTIONS } from "./nav";

/** Placeholder page for a section that appears in the navigation but is not built yet. */
export function ComingSoon({ slug }: { slug: string }) {
  const section = ADMIN_SECTIONS.find((s) => s.slug === slug && s.status === "soon");
  if (!section) notFound();

  return (
    <>
      <PageHeader back icon={section.icon} title={section.label} subtitle={section.subtitle} />

      <section className="card mx-auto max-w-2xl px-6 py-10 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <Clock className="h-7 w-7" />
        </div>
        <div className="mb-2 flex justify-center">
          <Badge tone="amber">Coming soon</Badge>
        </div>
        <h2 className="text-xl font-semibold">{section.label} isn&apos;t available yet</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          This section is part of the roadmap and is shown here so the navigation matches the full product. Nothing on
          this page is active.
        </p>

        {section.planned && (
          <div className="mx-auto mt-6 max-w-md rounded-lg border border-slate-200 bg-slate-50 p-4 text-left">
            <p className="mb-2 text-xs font-semibold tracking-wide text-slate-500 uppercase">Planned</p>
            <ul className="space-y-2">
              {section.planned.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link href="/admin" className="btn btn-outline">
            <ArrowLeft className="h-4 w-4" /> Back to Dashboard
          </Link>
          <Link href="/admin/documents" className="btn btn-dark">
            Manage Documents
          </Link>
        </div>
      </section>
    </>
  );
}
