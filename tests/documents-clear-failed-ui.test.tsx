// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClearFailedDocumentsDTO, DocumentDTO } from "@/lib/types";

const apiMock = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  clearFailedDocuments: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => "/admin/documents",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/admin/UploadDialog", () => ({ UploadDialog: () => null }));

import { ClearFailedButton } from "@/components/admin/ClearFailedButton";
import DocumentsPage from "@/app/admin/documents/page";

const MESSAGE =
  "This will remove 3 failed document records from the current knowledge base. Indexed and processing documents will not be affected.";

const result = (n: number, ids: string[] = []): ClearFailedDocumentsDTO => ({
  deleted: n,
  deletedIds: ids,
  message: `${n} failed document${n === 1 ? "" : "s"} cleared successfully.`,
});

/** A promise the test resolves or rejects by hand, to observe the in-between "Clearing..." state. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled;
const mainButton = (name: RegExp | string) => screen.getByRole("button", { name });
const openDialog = () => fireEvent.click(mainButton(/^Clear \d+ failed$/));
const confirm = () => fireEvent.click(screen.getByRole("button", { name: "Clear Failed Documents" }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("ClearFailedButton", () => {
  it("shows the failed count and is enabled", () => {
    render(<ClearFailedButton failedCount={3} onCleared={vi.fn()} />);
    expect(isDisabled(mainButton("Clear 3 failed"))).toBe(false);
  });

  it("is disabled when there is nothing to clear", () => {
    render(<ClearFailedButton failedCount={0} onCleared={vi.fn()} />);
    const button = mainButton("Clear 0 failed");
    expect(isDisabled(button)).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks for confirmation first, with the exact title, message and buttons, and deletes nothing yet", () => {
    render(<ClearFailedButton failedCount={3} onCleared={vi.fn()} />);
    openDialog();

    const dialog = screen.getByRole("dialog", { name: "Clear failed documents?" });
    expect(within(dialog).getByRole("heading", { name: "Clear failed documents?" })).toBeTruthy();
    expect(dialog.textContent?.replace(/\s+/g, " ")).toContain(MESSAGE);
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Clear Failed Documents" })).toBeTruthy();
    expect(apiMock.clearFailedDocuments).not.toHaveBeenCalled();
  });

  it("Cancel closes the dialog and changes nothing", () => {
    const onCleared = vi.fn();
    render(<ClearFailedButton failedCount={3} onCleared={onCleared} />);
    openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(apiMock.clearFailedDocuments).not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
    expect(isDisabled(mainButton("Clear 3 failed"))).toBe(false);
  });

  it("shows a loading state while the request runs, then reports success", async () => {
    const pending = deferred<ClearFailedDocumentsDTO>();
    apiMock.clearFailedDocuments.mockReturnValue(pending.promise);
    const onCleared = vi.fn();
    render(<ClearFailedButton failedCount={3} onCleared={onCleared} />);
    openDialog();
    confirm();

    const busy = await screen.findByRole("button", { name: "Clearing..." });
    expect(isDisabled(busy)).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onCleared).not.toHaveBeenCalled();

    const done = result(3, ["a", "b", "c"]);
    await act(async () => pending.resolve(done));

    expect(onCleared).toHaveBeenCalledWith(done);
    expect((await screen.findByRole("status")).textContent).toContain("3 failed documents cleared successfully.");
    expect(screen.queryByRole("button", { name: "Clearing..." })).toBeNull();
  });

  it("does not send duplicate requests on repeated clicks", async () => {
    const pending = deferred<ClearFailedDocumentsDTO>();
    apiMock.clearFailedDocuments.mockReturnValue(pending.promise);
    render(<ClearFailedButton failedCount={3} onCleared={vi.fn()} />);
    openDialog();

    // Two clicks land before React re-renders: only the first may go through.
    const confirmButton = screen.getByRole("button", { name: "Clear Failed Documents" });
    act(() => {
      confirmButton.click();
      confirmButton.click();
    });
    // And the main button can't be used again while the request is running.
    fireEvent.click(await screen.findByRole("button", { name: "Clearing..." }));
    fireEvent.click(screen.getByRole("button", { name: "Clearing..." }));

    expect(apiMock.clearFailedDocuments).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => pending.resolve(result(3)));
  });

  it("keeps the records and shows a clear error when the request fails", async () => {
    apiMock.clearFailedDocuments.mockRejectedValue(new Error("Could not reach the server."));
    const onCleared = vi.fn();
    render(<ClearFailedButton failedCount={3} onCleared={onCleared} />);
    openDialog();
    confirm();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Couldn't clear failed documents. Could not reach the server.");
    expect(onCleared).not.toHaveBeenCalled();
    expect(isDisabled(mainButton("Clear 3 failed"))).toBe(false); // usable again for a retry
  });
});

const doc = (id: string, filename: string, status: DocumentDTO["status"]): DocumentDTO => ({
  id,
  filename,
  mimeType: "application/pdf",
  sizeBytes: 2048,
  pageCount: status === "ready" ? 4 : null,
  status,
  error: status === "failed" ? "No selectable text found in this PDF." : null,
  chunkCount: status === "ready" ? 7 : 0,
  indexCurrent: true,
  source: null,
  createdAt: "2026-10-08T10:00:00.000Z",
});

describe("Documents page", () => {
  it("updates the list and the failed count after clearing, with a search filter active", async () => {
    const ready = doc("r1", "Alpha guide.pdf", "ready");
    const busy = doc("p1", "Busy upload.pdf", "processing");
    const failedA = doc("f1", "Alpha scan.pdf", "failed");
    const failedB = doc("f2", "Beta scan.pdf", "failed");
    apiMock.listDocuments
      .mockResolvedValueOnce([ready, busy, failedA, failedB]) // first load
      .mockResolvedValue([ready, busy]); // refresh after clearing
    apiMock.clearFailedDocuments.mockResolvedValue(result(2, ["f1", "f2"]));

    render(<DocumentsPage />);
    expect(isDisabled(await screen.findByRole("button", { name: "Clear 2 failed" }))).toBe(false);

    // Filter the visible rows down to "Alpha": the button still covers every failed document.
    fireEvent.change(screen.getByPlaceholderText("Search files..."), { target: { value: "Alpha" } });
    expect(screen.queryByText("Beta scan.pdf")).toBeNull();
    expect(screen.getByText("Alpha scan.pdf")).toBeTruthy();
    expect(isDisabled(mainButton("Clear 2 failed"))).toBe(false);

    openDialog();
    expect(screen.getByRole("dialog").textContent).toContain("This will remove 2 failed document records");
    confirm();

    await waitFor(() => expect(isDisabled(screen.getByRole("button", { name: "Clear 0 failed" }))).toBe(true));
    expect(apiMock.clearFailedDocuments).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Alpha scan.pdf")).toBeNull();
    expect(screen.getByText("Alpha guide.pdf")).toBeTruthy(); // indexed document stays
    expect(screen.getByRole("status").textContent).toContain("2 failed documents cleared successfully.");
    expect(apiMock.listDocuments).toHaveBeenCalledTimes(2); // re-synced with the server

    // The processing document is untouched too (clear the search to see it).
    fireEvent.change(screen.getByPlaceholderText("Search files..."), { target: { value: "" } });
    expect(screen.getByText("Busy upload.pdf")).toBeTruthy();
  });

  it("leaves the list as it was when clearing fails", async () => {
    apiMock.listDocuments.mockResolvedValue([doc("r1", "Alpha guide.pdf", "ready"), doc("f1", "Alpha scan.pdf", "failed")]);
    apiMock.clearFailedDocuments.mockRejectedValue(new Error("Something went wrong on the server. Check the server logs."));

    render(<DocumentsPage />);
    await screen.findByRole("button", { name: "Clear 1 failed" });
    openDialog();
    confirm();

    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong on the server.");
    expect(screen.getByText("Alpha scan.pdf")).toBeTruthy();
    expect(isDisabled(mainButton("Clear 1 failed"))).toBe(false);
  });
});
