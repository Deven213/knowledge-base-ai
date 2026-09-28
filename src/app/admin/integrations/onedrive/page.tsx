"use client";

import { CloudDriveSettings } from "@/components/integrations/CloudDriveSettings";
import { IntegrationPage } from "@/components/integrations/IntegrationPage";

export default function OneDrivePage() {
  return <IntegrationPage type="onedrive">{(ctx) => <CloudDriveSettings {...ctx} />}</IntegrationPage>;
}
