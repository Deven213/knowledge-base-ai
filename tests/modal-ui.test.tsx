// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "@/components/ui";

// The shared dialog (components/ui.tsx). It used to grow with its content: a dialog taller than the screen ran off both the top and the
// bottom, with the header, the fields at the top and the buttons at the bottom out of reach and nothing able to scroll. These tests pin
// down the structure that prevents that, the rules for the page behind it, and the keyboard and screen-reader behaviour.
//
// jsdom has no layout engine, so it cannot measure a dialog against a screen: the structure and the CSS rule are checked here, and the
// measured geometry (top and bottom inside the viewport at 1366x768, 1280x720, 1024x768 and 390x844) was checked in a real browser.

const ROOT = path.resolve(__dirname, "..");
const html = document.documentElement;

const renderModal = (props: Partial<React.ComponentProps<typeof Modal>> = {}, children: React.ReactNode = <p>Body text</p>) =>
  render(
    <Modal open title="A dialog" onClose={() => undefined} footer={<button type="button">Save</button>} {...props}>
      {children}
    </Modal>,
  );

beforeEach(() => {
  html.style.overflow = "";
  document.body.style.paddingRight = "";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a dialog that always fits the screen", () => {
  it("is header, scrolling content, footer: only the content scrolls, and it is allowed to shrink", () => {
    renderModal({}, <div data-testid="content">tall content</div>);
    const dialog = screen.getByRole("dialog");
    const [header, body, footer, ...rest] = [...dialog.children] as HTMLElement[];
    expect(rest).toHaveLength(0);

    expect(dialog.className).toMatch(/\bflex\b/);
    expect(dialog.className).toMatch(/\bflex-col\b/);
    expect(dialog.className).toMatch(/\bmodal-panel\b/);

    // The header and the footer never shrink and never scroll away...
    expect(header!.className).toMatch(/\bshrink-0\b/);
    expect(footer!.className).toMatch(/\bshrink-0\b/);
    expect(header!.querySelector("h2")!.textContent).toBe("A dialog");
    expect(header!.querySelector('[aria-label="Close"]')).toBeTruthy();
    expect(footer!.textContent).toBe("Save");
    // ...the content between them is the one thing that scrolls, and min-h-0 is what lets a flex child shrink below its content.
    expect(body!.className).toMatch(/\boverflow-y-auto\b/);
    expect(body!.className).toMatch(/\bmin-h-0\b/);
    expect(body!.className).toMatch(/\bflex-1\b/);
    expect(body!.className).toMatch(/\boverscroll-contain\b/);
    expect(body!.contains(screen.getByTestId("content"))).toBe(true);
    expect(body!.contains(footer!)).toBe(false);
    expect(body!.contains(header!)).toBe(false);
  });

  it("has no footer when it has no actions, and the content still scrolls", () => {
    renderModal({ footer: undefined });
    expect([...screen.getByRole("dialog").children]).toHaveLength(2);
  });

  it("is centred with 16px around it, and never taller than the screen minus 32px (vh first, dvh where supported)", () => {
    renderModal();
    const overlay = screen.getByRole("dialog").parentElement!;
    expect(overlay.className).toMatch(/\bfixed\b/);
    expect(overlay.className).toMatch(/\binset-0\b/);
    expect(overlay.className).toMatch(/\bitems-center\b/);
    expect(overlay.className).toMatch(/\bjustify-center\b/);
    expect(overlay.className).toMatch(/\bp-4\b/); // 1rem = 16px each side = the 32px in the rule below

    const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(".modal-panel { max-height: calc(100vh - 32px); }");
    expect(css).toContain("@supports (height: 100dvh) { .modal-panel { max-height: calc(100dvh - 32px); } }");
    expect(css.indexOf("calc(100vh - 32px)")).toBeLessThan(css.indexOf("calc(100dvh - 32px)")); // the fallback comes first
  });

  it("is 512px wide by default and 560px when asked, and always shrinks to fit a phone", () => {
    const { rerender } = renderModal();
    expect(screen.getByRole("dialog").className).toMatch(/\bw-full\b/);
    expect(screen.getByRole("dialog").className).toMatch(/\bmax-w-lg\b/);
    rerender(
      <Modal open title="A dialog" size="wide" onClose={() => undefined}>
        x
      </Modal>,
    );
    expect(screen.getByRole("dialog").className).toMatch(/\bmax-w-\[560px\]/);
    expect(screen.getByRole("dialog").className).toMatch(/\bw-full\b/);
  });

  it("renders nothing while closed", () => {
    renderModal({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(html.style.overflow).toBe("");
  });
});

describe("what a screen reader announces", () => {
  it("is a modal dialog named by its visible title", () => {
    renderModal({ title: "New consultation" });
    const dialog = screen.getByRole("dialog", { name: "New consultation" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = screen.getByRole("heading", { name: "New consultation" });
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.id).not.toBe("");
    expect(dialog.hasAttribute("aria-label")).toBe(false); // one source for the name, the visible heading
  });

  it("gives two open dialogs two different title ids", () => {
    render(
      <>
        <Modal open title="First" onClose={() => undefined}>
          a
        </Modal>
        <Modal open title="Second" onClose={() => undefined}>
          b
        </Modal>
      </>,
    );
    const ids = screen.getAllByRole("heading").map((h) => h.id);
    expect(new Set(ids).size).toBe(2);
    expect(screen.getByRole("dialog", { name: "First" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Second" })).toBeTruthy();
  });
});

describe("the page behind the dialog", () => {
  it("does not scroll while a dialog is open, and is released exactly as it was when it closes", () => {
    html.style.overflow = "auto";
    const { rerender } = renderModal();
    expect(html.style.overflow).toBe("hidden");
    rerender(
      <Modal open={false} title="A dialog" onClose={() => undefined}>
        x
      </Modal>,
    );
    expect(html.style.overflow).toBe("auto");
  });

  it("is released when the dialog is removed from the page, too", () => {
    const { unmount } = renderModal();
    expect(html.style.overflow).toBe("hidden");
    unmount();
    expect(html.style.overflow).toBe("");
  });

  it("stays locked until the LAST of several dialogs closes", () => {
    const first = renderModal({ title: "First" });
    const second = renderModal({ title: "Second" });
    expect(html.style.overflow).toBe("hidden");
    second.unmount();
    expect(html.style.overflow).toBe("hidden");
    first.unmount();
    expect(html.style.overflow).toBe("");
  });

  it("pads for the scrollbar it hides, so nothing behind the dialog jumps sideways, and takes the padding away again", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    vi.spyOn(html, "clientWidth", "get").mockReturnValue(1009); // a 15px scrollbar
    document.body.style.paddingRight = "4px";
    const { unmount } = renderModal();
    expect(document.body.style.paddingRight).toBe("15px");
    unmount();
    expect(document.body.style.paddingRight).toBe("4px");
  });

  it("adds no padding when there is no scrollbar to hide (phones, overlay scrollbars)", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    vi.spyOn(html, "clientWidth", "get").mockReturnValue(390);
    renderModal();
    expect(document.body.style.paddingRight).toBe("");
  });
});

describe("keyboard", () => {
  const Host = ({ onClose = () => undefined }: { onClose?: () => void }) => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Opener
        </button>
        <Modal
          open={open}
          title="Keyboard"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
          footer={
            <>
              <button type="button">Cancel</button>
              <button type="button">Save</button>
            </>
          }
        >
          <input aria-label="Name" />
        </Modal>
        <button type="button">Outside</button>
      </>
    );
  };
  const openIt = () => {
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    return opener;
  };

  it("moves focus into the dialog when it opens", () => {
    render(<Host />);
    openIt();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("leaves focus alone when a control inside already asked for it (autoFocus)", () => {
    render(
      <Modal open title="Typed" onClose={() => undefined}>
        <input aria-label="Type here" autoFocus />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Type here"));
  });

  it("cycles: Tab on the last control goes to the first, Shift+Tab on the first goes to the last", () => {
    render(<Host />);
    openIt();
    const dialog = screen.getByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    const save = screen.getByRole("button", { name: "Save" });

    save.focus();
    const forward = fireEvent.keyDown(save, { key: "Tab" });
    expect(forward).toBe(false); // default prevented: the browser does not carry on to the page behind
    expect(document.activeElement).toBe(close);

    const backward = fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(save);

    // In the middle the browser's own Tab order is left alone.
    const name = screen.getByLabelText("Name");
    name.focus();
    expect(fireEvent.keyDown(name, { key: "Tab" })).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("skips controls that are disabled, so the cycle never lands on one", () => {
    render(
      <Modal open title="Disabled" onClose={() => undefined} footer={<><button type="button">Cancel</button><button type="button" disabled>Start</button></>}>
        <input aria-label="Name" />
      </Modal>,
    );
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" }); // Cancel is now the last enabled control
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });

  it("brings focus back when it is moved to the page behind (a click, a screen reader, a script)", () => {
    render(<Host />);
    openIt();
    screen.getByRole("button", { name: "Outside" }).focus();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and hands focus back to the control that opened it", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = openIt();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the close button; a press inside the dialog does not close it, a press on the backdrop does", () => {
    const onClose = vi.fn();
    render(
      <Modal open title="Closing" onClose={onClose}>
        <p>inside</p>
      </Modal>,
    );
    fireEvent.mouseDown(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("with two dialogs open, only the newest holds focus", () => {
    render(
      <>
        <Modal open title="Under" onClose={() => undefined}>
          <button type="button">under</button>
        </Modal>
        <Modal open title="Over" onClose={() => undefined}>
          <button type="button">over</button>
        </Modal>
      </>,
    );
    const over = screen.getByRole("dialog", { name: "Over" });
    const under = screen.getByRole("dialog", { name: "Under" });
    expect(over.contains(document.activeElement)).toBe(true);
    screen.getByRole("button", { name: "under" }).focus();
    expect(over.contains(document.activeElement)).toBe(true);
    expect(under.contains(document.activeElement)).toBe(false);
  });
});
