"use client";

import { Building2 } from "lucide-react";
import { PlatformConsole } from "@/components/platform/PlatformConsole";
import { PageHeader } from "@/components/ui";

export default function PlatformPage() {
  return (
    <>
      <PageHeader icon={Building2} title="Customers" subtitle="Customer workspaces, their administrators and the audit trail" />
      <PlatformConsole />
    </>
  );
}
