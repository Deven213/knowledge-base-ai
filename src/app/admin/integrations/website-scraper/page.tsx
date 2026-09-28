"use client";

import { IntegrationPage } from "@/components/integrations/IntegrationPage";
import { WebsiteScraperSettings } from "@/components/integrations/WebsiteScraperSettings";

export default function WebsiteScraperPage() {
  return <IntegrationPage type="website">{(ctx) => <WebsiteScraperSettings key={ctx.integration.id} {...ctx} />}</IntegrationPage>;
}
