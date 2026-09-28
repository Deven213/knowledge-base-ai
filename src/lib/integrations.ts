// Integrations: shared types for the API and the UI. No credentials ever appear here.
import type { FeatureKey } from "./features";

export const INTEGRATION_TYPES = ["website", "google_drive", "onedrive"] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export type IntegrationStatus = "not_connected" | "connected" | "syncing" | "success" | "error" | "disabled";
export type SyncRunStatus = "running" | "success" | "partial" | "error";

export const INTEGRATIONS_HREF = "/admin/integrations";

export const INTEGRATION_META: Record<
  IntegrationType,
  { name: string; description: string; summary: string; feature: FeatureKey; sourceLabel: string; slug: string; href: string }
> = {
  website: {
    name: "Website Scraper",
    description: "Crawl website pages into your Knowledge Base.",
    summary: "Crawl websites and index their pages.",
    feature: "website_scraper",
    sourceLabel: "Website",
    slug: "website-scraper",
    href: `${INTEGRATIONS_HREF}/website-scraper`,
  },
  google_drive: {
    name: "Google Drive",
    description: "Sync files from Google Drive into your Knowledge Base.",
    summary: "Sync files from Google Drive.",
    feature: "google_drive",
    sourceLabel: "Google Drive",
    slug: "google-drive",
    href: `${INTEGRATIONS_HREF}/google-drive`,
  },
  onedrive: {
    name: "OneDrive",
    description: "Sync files from Microsoft OneDrive into your Knowledge Base.",
    summary: "Sync files from Microsoft OneDrive.",
    feature: "onedrive",
    sourceLabel: "OneDrive",
    slug: "onedrive",
    href: `${INTEGRATIONS_HREF}/onedrive`,
  },
};

export const CRAWL_DEPTHS = [1, 2, 3] as const;
export const MAX_PAGE_OPTIONS = [10, 25, 50] as const;

export interface WebsiteConfig {
  url?: string;
  /** 1 = the page and the pages it links to; 2 and 3 follow links further. */
  depth?: number;
  maxPages?: number;
}

export interface CloudFolderConfig {
  folderId?: string;
  /** Display path of the selected folder, e.g. "My Drive / Policies". */
  folderName?: string;
  syncMode?: "manual";
}

export type IntegrationConfig = WebsiteConfig & CloudFolderConfig;

export interface SyncRunSummaryDTO {
  id: string;
  integrationId: string;
  integrationType: IntegrationType;
  integrationName: string;
  status: SyncRunStatus;
  startedAt: string;
  completedAt: string | null;
  filesFound: number;
  filesAdded: number;
  filesUpdated: number;
  filesSkipped: number;
  filesFailed: number;
  errorMessage: string | null;
}

export interface SyncRunItemDTO {
  name: string;
  url?: string | null;
  outcome: "added" | "updated" | "skipped" | "failed";
  message?: string | null;
}

export interface SyncRunDetailDTO extends SyncRunSummaryDTO {
  items: SyncRunItemDTO[];
}

export interface IntegrationDTO {
  id: string;
  type: IntegrationType;
  name: string;
  enabled: boolean;
  status: IntegrationStatus;
  configuration: IntegrationConfig;
  /** Connected account (email/name) for OAuth integrations. */
  accountLabel: string | null;
  lastError: string | null;
  lastSyncAt: string | null;
  lastRun: SyncRunSummaryDTO | null;
  /** OAuth integrations: whether the server has the required configuration (see `missingConfig`). */
  oauth: { configured: boolean; missingConfig: string[]; redirectUri: string } | null;
  connected: boolean;
}

export interface CloudFolderDTO {
  id: string;
  name: string;
}
