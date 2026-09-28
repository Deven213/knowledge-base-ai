"use client";

import Link from "next/link";
import { Settings, SlidersHorizontal } from "lucide-react";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { EmptyState, PageHeader } from "@/components/ui";

export default function GeneralSettingsPage() {
  return (
    <>
      <PageHeader back icon={Settings} title="Settings" subtitle="Application settings for administrators" />
      <SettingsTabs />
      <section className="card">
        <EmptyState icon={SlidersHorizontal} title="No general settings yet">
          General options will appear here. To turn modules on or off, use{" "}
          <Link href="/settings/features" className="font-medium text-brand-600 hover:underline">
            Feature Management
          </Link>
          . API keys stay in the server&apos;s <code className="font-mono">.env</code> file.
        </EmptyState>
      </section>
    </>
  );
}
