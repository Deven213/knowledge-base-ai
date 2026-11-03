// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncRunDetailDTO, SyncRunItemDTO, SyncRunSummaryDTO } from "@/lib/integrations";

const apiMock = vi.hoisted(() => ({ syncRunDetail: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { LastSyncCard, RunItem } from "@/components/integrations/parts";
import { SyncHistory } from "@/components/integrations/SyncHistory";

const run = (over: Partial<SyncRunSummaryDTO> = {}): SyncRunSummaryDTO => ({
  id: "run-1",
  integrationId: "int-1",
  integrationType: "website",
  integrationName: "Website Scraper",
  status: "partial",
  startedAt: "2026-09-28T07:40:03.921Z",
  completedAt: "2026-09-28T07:40:12.100Z",
  filesFound: 10,
  filesAdded: 0,
  filesUpdated: 0,
  filesSkipped: 9,
  filesFailed: 1,
  errorMessage: "1 item(s) failed. See the run details.",
  ...over,
});

const failedItem: SyncRunItemDTO = {
  name: "quotes.toscrape.com/missing",
  url: "https://quotes.toscrape.com/missing",
  outcome: "failed",
  message: "The website returned HTTP 404 (page not found).",
  stage: "fetch",
  category: "http_error",
  httpStatus: 404,
  detail: "HTTP 404 Not Found",
  at: "2026-09-28T07:40:05.000Z",
};
const unchangedItem: SyncRunItemDTO = { name: "Quotes to Scrape — quotes.toscrape.com", url: "https://quotes.toscrape.com/", outcome: "skipped", message: "Unchanged", category: "unchanged" };
const emptyItem: SyncRunItemDTO = {
  name: "Quotes to Scrape",
  url: "https://quotes.toscrape.com/login",
  outcome: "skipped",
  stage: "parse",
  category: "no_content",
  message: "No readable content: only 23 characters of text remain after removing navigation, forms and scripts (at least 40 are needed).",
};

const detail = (items: SyncRunItemDTO[], over: Partial<SyncRunSummaryDTO> = {}): SyncRunDetailDTO => ({ ...run(over), items });

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("RunItem", () => {
  it("shows where and why an item failed: stage, category, HTTP status, time, and the original error", () => {
    render(<ul><RunItem item={failedItem} /></ul>);

    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("https://quotes.toscrape.com/missing")).toBeTruthy();
    expect(screen.getByText("The website returned HTTP 404 (page not found).")).toBeTruthy();
    const meta = screen.getByText(/Loading page · HTTP error · HTTP 404/);
    expect(meta.textContent).toMatch(/2026/); // the time it was handled
    expect(screen.getByText("Technical details")).toBeTruthy();
    expect(screen.getByText("HTTP 404 Not Found")).toBeTruthy();
  });

  it("shows a skipped page with its reason, and nothing for diagnostics that were never recorded", () => {
    render(<ul><RunItem item={{ name: "old/page", outcome: "failed", message: "No readable content was found on this page." }} /></ul>);

    expect(screen.getByText("No readable content was found on this page.")).toBeTruthy();
    expect(screen.queryByText("Technical details")).toBeNull();
    expect(screen.queryByText(/Loading page|HTTP error/)).toBeNull();
  });
});

describe("Last Sync card", () => {
  it("lists exactly which items failed and why, and its counters match the run", async () => {
    apiMock.syncRunDetail.mockResolvedValue(detail([unchangedItem, failedItem, emptyItem]));
    render(<LastSyncCard run={run()} unit="pages" />);

    // Counters straight from the run.
    const counts = (label: string) => screen.getByText(label).parentElement!.textContent;
    expect(counts("Pages found")).toContain("10");
    expect(counts("Added")).toContain("0");
    expect(counts("Skipped")).toContain("9");
    expect(counts("Failed")).toContain("1");

    const list = await screen.findByRole("list", { name: "Failed items" });
    expect(apiMock.syncRunDetail).toHaveBeenCalledWith("int-1", "run-1");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1); // only the failed one
    expect(within(list).getByText("https://quotes.toscrape.com/missing")).toBeTruthy();
    expect(within(list).getByText("The website returned HTTP 404 (page not found).")).toBeTruthy();
    expect(within(list).getByText(/HTTP error · HTTP 404/)).toBeTruthy();
    expect(screen.queryByText(/Unchanged|only 23 characters/)).toBeNull(); // skipped items stay out of the failures list
  });

  it("does not look anything up when nothing failed", () => {
    render(<LastSyncCard run={run({ status: "success", filesSkipped: 10, filesFailed: 0, errorMessage: null })} unit="pages" />);
    expect(apiMock.syncRunDetail).not.toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Failed items" })).toBeNull();
  });

  it("says so, and keeps the summary, when the failed items can't be loaded", async () => {
    apiMock.syncRunDetail.mockRejectedValue(new Error("Could not reach the server."));
    render(<LastSyncCard run={run()} unit="pages" />);

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the failed items: Could not reach the server.");
    expect(screen.getByText("1 item(s) failed. See the run details.")).toBeTruthy();
  });
});

describe("Sync history details", () => {
  it("shows every item of a run with its outcome and reason", async () => {
    apiMock.syncRunDetail.mockResolvedValue(detail([unchangedItem, failedItem, emptyItem], { filesFailed: 1 }));
    render(<SyncHistory runs={[run()]} unit="pages" />);

    fireEvent.click(screen.getByRole("button", { name: "Details" }));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(3));
    expect(within(dialog).getByText("Unchanged")).toBeTruthy();
    expect(within(dialog).getByText(/No readable content: only 23 characters/)).toBeTruthy();
    expect(within(dialog).getByText(/Reading page · No content/)).toBeTruthy();
    expect(within(dialog).getByText("HTTP 404 Not Found")).toBeTruthy();
  });
});
