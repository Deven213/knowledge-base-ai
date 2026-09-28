import {
  Activity,
  Bot,
  BotMessageSquare,
  Cloud,
  Code2,
  FileText,
  FolderOpen,
  Globe,
  HardDrive,
  LayoutDashboard,
  Mail,
  MessageCircle,
  MessageSquareWarning,
  Plug,
  ScrollText,
  Users,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { FeatureKey } from "@/lib/features";
import { INTEGRATION_META } from "@/lib/integrations";

/** A page nested under a section in the sidebar, with its own feature flag. */
export interface AdminSubsection {
  href: string;
  feature: FeatureKey;
  label: string;
  icon: LucideIcon;
}

export interface AdminSection {
  /** URL segment under /admin ("" = the dashboard). */
  slug: string;
  /** Feature flag that controls this section's visibility and access. */
  feature: FeatureKey;
  label: string;
  subtitle: string;
  icon: LucideIcon;
  /** "live" sections are implemented; "soon" sections render a Coming soon page. */
  status: "live" | "soon";
  /** What the section will do once built (shown on its Coming soon page). */
  planned?: string[];
  /** Child pages shown under the section when it is expanded. */
  children?: AdminSubsection[];
}

/** Admin navigation, in the same order as the reference design. */
export const ADMIN_SECTIONS: AdminSection[] = [
  { slug: "", feature: "dashboard", label: "Dashboard", subtitle: "Overview of your knowledge base", icon: LayoutDashboard, status: "live" },
  {
    slug: "documents", feature: "documents",
    label: "Documents",
    subtitle: "Upload and manage the documents your AI answers from",
    icon: FileText,
    status: "live",
  },
  {
    slug: "ai-agents", feature: "ai_agents",
    label: "AI Agents",
    subtitle: "Manage specialised agents and the files each one uses",
    icon: BotMessageSquare,
    status: "soon",
    planned: [
      "Create agents with their own instructions and document sets",
      "Turn agents on or off, globally and per user",
      "Review the files each agent answers from",
    ],
  },
  {
    slug: "integrations", feature: "sync_integrations",
    label: "Integrations",
    subtitle: "Connect external sources to your Knowledge Base",
    icon: Plug,
    status: "live",
    children: [
      { href: INTEGRATION_META.website.href, feature: "website_scraper", label: "Website Scraper", icon: Globe },
      { href: INTEGRATION_META.google_drive.href, feature: "google_drive", label: "Google Drive", icon: HardDrive },
      { href: INTEGRATION_META.onedrive.href, feature: "onedrive", label: "OneDrive", icon: Cloud },
    ],
  },
  {
    slug: "widgets", feature: "widget_management",
    label: "Widget Management",
    subtitle: "Manage embeddable chat widget keys for external domains",
    icon: Code2,
    status: "soon",
    planned: [
      "Create widget keys restricted to a domain",
      "Track usage and last-used time per key",
      "Global switch to disable all widgets",
    ],
  },
  {
    slug: "email-addons", feature: "email_addons",
    label: "Email Add-ons",
    subtitle: "Control Gmail and Outlook add-on access",
    icon: Mail,
    status: "soon",
    planned: ["Enable the email add-on per user", "Daily request limits", "Global email access switch"],
  },
  {
    slug: "whatsapp", feature: "whatsapp_connections",
    label: "WhatsApp Connections",
    subtitle: "Answer questions from your documents over WhatsApp",
    icon: MessageCircle,
    status: "soon",
    planned: ["Connect a WhatsApp Business number", "Choose which documents it can answer from", "Message logs"],
  },
  {
    slug: "channels", feature: "channels",
    label: "Channels",
    subtitle: "Other messaging channels for your assistant",
    icon: Waypoints,
    status: "soon",
    planned: ["Slack and Microsoft Teams connections", "Per-channel document access"],
  },
  {
    slug: "categories", feature: "category_management",
    label: "Category Management",
    subtitle: "Group documents into categories and control access",
    icon: FolderOpen,
    status: "soon",
    planned: [
      "Create categories and assign documents to them",
      "Limit chat answers to selected categories",
      "See file and user counts per category",
    ],
  },
  {
    slug: "users", feature: "user_management",
    label: "User Management",
    subtitle: "Manage and monitor user accounts",
    icon: Users,
    status: "soon",
    planned: [
      "Sign-in with user accounts (requires authentication)",
      "Admin and User roles",
      "Assign categories to users, activate or deactivate accounts",
    ],
  },
  {
    slug: "ai-models", feature: "ai_model_settings",
    label: "AI Model Settings",
    subtitle: "Choose which AI provider answers questions, and configure models",
    icon: Bot,
    status: "live",
  },
  {
    slug: "system-monitoring", feature: "system_monitoring",
    label: "System Monitoring",
    subtitle: "Health and usage of the platform",
    icon: Activity,
    status: "soon",
    planned: ["Provider response times and error rates", "Indexing queue and storage usage", "Questions per day"],
  },
  {
    slug: "feedback", feature: "feedback_report",
    label: "Feedback Report",
    subtitle: "What users think of the answers",
    icon: MessageSquareWarning,
    status: "soon",
    planned: ["Thumbs up / down on every answer", "Review low-rated answers with their sources"],
  },
  {
    slug: "audit-logs", feature: "audit_logs",
    label: "Audit Logs",
    subtitle: "A record of important actions",
    icon: ScrollText,
    status: "soon",
    planned: ["Uploads, deletions and settings changes", "Who did what and when (needs user accounts)"],
  },
];

export const sectionHref = (s: AdminSection) => (s.slug ? `/admin/${s.slug}` : "/admin");

export const COMING_SOON_SLUGS = ADMIN_SECTIONS.filter((s) => s.status === "soon").map((s) => s.slug);

export function sectionBySlug(slug: string): AdminSection | undefined {
  return ADMIN_SECTIONS.find((s) => s.slug === slug);
}
