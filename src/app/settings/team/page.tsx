"use client";

import { Users } from "lucide-react";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { TeamManagement } from "@/components/settings/TeamManagement";
import { PageHeader } from "@/components/ui";

export default function TeamSettingsPage() {
  return (
    <>
      <PageHeader back icon={Users} title="Team" subtitle="People in this workspace and their roles" />
      <SettingsTabs />
      <TeamManagement />
    </>
  );
}
