// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { ChangePassword } from "@/components/auth/ChangePassword";

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.changePassword.mockResolvedValue({ changed: true, redirect: "/admin" });
});
afterEach(cleanup);

const fill = (current: string, next: string, confirmation = next) => {
  fireEvent.change(screen.getByLabelText(/Temporary password|Current password/), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirmation } });
};
const submit = () => screen.getByRole("button", { name: /Save and continue|Change password/ }) as HTMLButtonElement;

describe("forced password change (first sign-in)", () => {
  it("explains that a temporary password was used and that it stops working once replaced", () => {
    render(<ChangePassword forced email="boss@initech.test" />);
    expect(screen.getByRole("heading", { name: "Choose your new password" })).toBeTruthy();
    expect(screen.getByText(/You signed in with a temporary password/)).toBeTruthy();
    expect(screen.getByText("boss@initech.test")).toBeTruthy();
    expect(screen.getByText(/stops working as soon as you do/)).toBeTruthy();
    expect(screen.getByLabelText("Temporary password")).toBeTruthy(); // typed again to prove it is them
  });

  it("only allows submitting a good, confirmed password that differs from the temporary one", () => {
    render(<ChangePassword forced email="boss@initech.test" />);
    expect(submit().disabled).toBe(true);

    fill("Abcd-Efgh-Jkmn-Pqrs", "abc");
    expect(submit().disabled).toBe(true);
    expect(screen.getByText("At least 4 characters.").className).toMatch(/red/);

    fill("Abcd-Efgh-Jkmn-Pqrs", "abcd"); // exactly the minimum
    expect(submit().disabled).toBe(false);
    expect(screen.getByText("At least 4 characters.").className).not.toMatch(/red/);

    fill("Abcd-Efgh-Jkmn-Pqrs", "a long enough password", "something different");
    expect(submit().disabled).toBe(true);
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();

    fill("Abcd-Efgh-Jkmn-Pqrs", "Abcd-Efgh-Jkmn-Pqrs");
    expect(submit().disabled).toBe(true);
    expect(screen.getByText("Choose a password that is different from the current one.")).toBeTruthy();

    fill("Abcd-Efgh-Jkmn-Pqrs", "a long enough password");
    expect(submit().disabled).toBe(false);
  });

  it("sends the temporary and the new password, and shows progress", async () => {
    let finish!: (v: unknown) => void;
    apiMock.changePassword.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    render(<ChangePassword forced email="boss@initech.test" />);
    fill("Abcd-Efgh-Jkmn-Pqrs", "a long enough password");

    fireEvent.click(submit());

    expect(await screen.findByRole("button", { name: /Saving/ })).toBeTruthy();
    expect(apiMock.changePassword).toHaveBeenCalledWith({ currentPassword: "Abcd-Efgh-Jkmn-Pqrs", newPassword: "a long enough password" });
    await act(async () => finish({ changed: true, redirect: "/admin" }));
  });

  it("shows the server's reason, clears the temporary password field and lets them try again", async () => {
    apiMock.changePassword.mockRejectedValueOnce(new Error("The current password is not correct."));
    render(<ChangePassword forced email="boss@initech.test" />);
    fill("wrong temporary password", "a long enough password");

    fireEvent.click(submit());

    expect((await screen.findByRole("alert")).textContent).toContain("The current password is not correct.");
    expect((screen.getByLabelText("Temporary password") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("New password") as HTMLInputElement).value).toBe("a long enough password"); // what they typed isn't lost
    fireEvent.change(screen.getByLabelText("Temporary password"), { target: { value: "Abcd-Efgh-Jkmn-Pqrs" } });
    expect(submit().disabled).toBe(false);
  });

  it("can show and hide the passwords being typed", () => {
    render(<ChangePassword forced email="boss@initech.test" />);
    expect((screen.getByLabelText("New password") as HTMLInputElement).type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show passwords" }));
    expect((screen.getByLabelText("New password") as HTMLInputElement).type).toBe("text");
    expect((screen.getByLabelText("Temporary password") as HTMLInputElement).type).toBe("text");
    fireEvent.click(screen.getByRole("button", { name: "Hide passwords" }));
    expect((screen.getByLabelText("New password") as HTMLInputElement).type).toBe("password");
  });

  it("never puts a password in storage or in the page address", async () => {
    render(<ChangePassword forced email="boss@initech.test" />);
    fill("Abcd-Efgh-Jkmn-Pqrs", "a long enough password");
    fireEvent.click(submit());
    await waitFor(() => expect(apiMock.changePassword).toHaveBeenCalled());
    expect(JSON.stringify([window.localStorage, window.sessionStorage, document.cookie, window.location.href])).not.toMatch(/Abcd-Efgh|long enough/);
  });
});

describe("voluntary password change", () => {
  it("asks for the current password and says other devices are signed out", () => {
    render(<ChangePassword forced={false} email="ana@acme.test" />);
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeTruthy();
    expect(screen.getByLabelText("Current password")).toBeTruthy();
    expect(screen.getByText(/signs you out of every other device/)).toBeTruthy();
    expect(screen.queryByText(/temporary password/i)).toBeNull();
  });
});
