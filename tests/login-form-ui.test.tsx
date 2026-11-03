// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/LoginForm";

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

async function submit(fetchMock: ReturnType<typeof respond>) {
  vi.stubGlobal("fetch", fetchMock);
  render(<LoginForm redirect="/admin" emailPlaceholder="you@company.com" />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "boss@initech.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "some password" } });
  fireEvent.click(screen.getByRole("button", { name: /Sign In/ }));
  return screen.findByRole("alert");
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sign-in errors", () => {
  it("tells people their workspace is suspended instead of a vague 'unavailable' message", async () => {
    const alert = await submit(respond(403, { error: "Your workspace is suspended. Please contact your administrator.", code: "workspace_suspended" }));
    expect(alert.textContent).toContain("Your workspace is suspended");
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe(""); // the password is cleared
  });

  it("keeps the generic messages for wrong details and for too many attempts", async () => {
    expect((await submit(respond(401, { error: "Invalid email or password." }))).textContent).toContain("Invalid email or password.");
    cleanup();
    expect((await submit(respond(429, { error: "Too many sign-in attempts. Please wait a few minutes and try again." }))).textContent).toContain("Too many sign-in attempts");
  });

  it("says sign-in is unavailable for a server failure", async () => {
    expect((await submit(respond(500, { error: "Something went wrong." }))).textContent).toContain("Sign-in is unavailable right now");
  });
});

describe("first-time sign-in", () => {
  it("shows the server's explanation when a temporary password has expired", async () => {
    const alert = await submit(respond(403, { error: "Your temporary password has expired. Ask your administrator for new credentials.", code: "temporary_password_expired" }));
    expect(alert.textContent).toContain("temporary password has expired");
  });

  it("the login page tells first-time customers to use their temporary password, and has no separate activation flow", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/login/page.tsx"), "utf8");
    expect(source).toContain("Sign in with the temporary password you were given");
    expect(source).toContain("choose your own password");
    expect(source).not.toMatch(/\/activate|Activate account|verification code/i);
    expect(fs.existsSync(path.join(process.cwd(), "src/app/activate"))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), "src/app/api/auth/activation"))).toBe(false);
  });

  it("the password page is a protected page (a session is needed), and the product stays protected", async () => {
    const { isProtectedApi, isProtectedPage, PASSWORD_CHANGE_PATH } = await import("@/lib/auth-routes");
    expect(PASSWORD_CHANGE_PATH).toBe("/change-password");
    expect(isProtectedPage("/change-password")).toBe(true);
    expect(isProtectedPage("/admin")).toBe(true);
    expect(isProtectedPage("/platform")).toBe(true);
    expect(isProtectedApi("/api/platform/organizations")).toBe(true);
    expect(isProtectedApi("/api/org/members")).toBe(true);
  });
});
