"use client";

import { CloudDriveSettings } from "@/components/integrations/CloudDriveSettings";
import { IntegrationPage } from "@/components/integrations/IntegrationPage";

export default function GoogleDrivePage() {
  return <IntegrationPage type="google_drive">{(ctx) => <CloudDriveSettings {...ctx} />}</IntegrationPage>;
}
