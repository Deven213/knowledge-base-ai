// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InvitationDTO, MemberDTO, OrgRole, SessionDTO } from "@/lib/types";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  changeMemberRole: vi.fn(),
  removeMember: vi.fn(),
  createInvitation: vi.fn(),
  revokeInvitation: vi.fn(),
  peekInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), usePathname: () => "/settings/team", useSearchParams: () => new URLSearchParams() }));

import { AcceptInvite } from "@/components/auth/AcceptInvite";
import { TeamManagement } from "@/components/settings/TeamManagement";

const PERMS: Record<OrgRole, string[]> = {
  viewer: ["chat", "documents:read"],
  member: ["chat", "documents:read", "documents:write"],
  doctor: ["chat", "documents:read", "consultations:use"],
  admin: ["chat", "documents:read", "documents:write", "documents:delete", "integrations:manage", "members:manage"],
  owner: ["chat", "documents:read", "documents:write", "documents:delete", "integrations:manage", "members:manage"],
};
const session = (role: OrgRole): SessionDTO => ({
  user: { id: "me", email: "me@acme.test", displayName: "Me", isPlatformAdmin: false },
  passwordChangeRequired: false,
  organization: { id: "o1", name: "Acme", slug: "acme", role },
  organizations: [{ id: "o1", name: "Acme", slug: "acme", role }],
  permissions: PERMS[role],
});
const member = (id: string, role: OrgRole, over: Partial<MemberDTO> = {}): MemberDTO => ({ userId: id, email: `${id}@acme.test`, displayName: null, role, status: "active", joinedAt: "2026-10-01T10:00:00.000Z", ...over });

const roleOptions = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.listInvitations.mockResolvedValue([]);
});
afterEach(cleanup);

describe("Team page", () => {
  it("tells people who can't manage the team so, and doesn't even ask the server for the member list", async () => {
    apiMock.me.mockResolvedValue(session("member"));
    render(<TeamManagement />);

    expect(await screen.findByText(/Only administrators and owners can manage the team/)).toBeTruthy();
    expect(apiMock.listMembers).not.toHaveBeenCalled();
    expect(apiMock.listInvitations).not.toHaveBeenCalled();
  });

  it("offers an administrator only the roles they may grant, and no controls for owners or other administrators", async () => {
    apiMock.me.mockResolvedValue(session("admin"));
    apiMock.listMembers.mockResolvedValue([member("me", "admin"), member("boss", "owner"), member("peer", "admin"), member("pat", "member"), member("vic", "viewer")]);
    render(<TeamManagement />);

    const patRole = await screen.findByRole("combobox", { name: "Role of pat@acme.test" });
    expect(roleOptions(patRole)).toEqual(["Administrator", "Member", "Doctor", "Viewer"]); // never Owner
    expect(screen.queryByRole("combobox", { name: "Role of boss@acme.test" })).toBeNull(); // can't change an owner
    expect(screen.queryByRole("combobox", { name: "Role of peer@acme.test" })).toBeNull(); // nor another administrator
    expect(screen.queryByRole("button", { name: "Remove boss@acme.test" })).toBeNull();
    expect(screen.getByRole("button", { name: "Remove pat@acme.test" })).toBeTruthy();
    // The invitation form follows the same rules: never owner.
    expect(roleOptions(screen.getByLabelText("Role"))).toEqual(["Administrator", "Member", "Doctor", "Viewer"]);
  });

  it("lets an owner make another owner", async () => {
    apiMock.me.mockResolvedValue(session("owner"));
    apiMock.listMembers.mockResolvedValue([member("me", "owner"), member("pat", "member")]);
    apiMock.changeMemberRole.mockResolvedValue([member("me", "owner"), member("pat", "owner")]);
    render(<TeamManagement />);

    const select = await screen.findByRole("combobox", { name: "Role of pat@acme.test" });
    expect(roleOptions(select)).toContain("Owner");
    fireEvent.change(select, { target: { value: "owner" } });

    await waitFor(() => expect(apiMock.changeMemberRole).toHaveBeenCalledWith("pat", "owner"));
  });

  it("doesn't offer to demote or remove the last owner, but does once there is a second one", async () => {
    apiMock.me.mockResolvedValue(session("owner"));
    apiMock.listMembers.mockResolvedValueOnce([member("me", "owner"), member("pat", "member")]);
    const { unmount } = render(<TeamManagement />);

    expect(await screen.findByRole("combobox", { name: "Role of pat@acme.test" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Role of me@acme.test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove me@acme.test" })).toBeNull();
    unmount();

    apiMock.listMembers.mockResolvedValueOnce([member("me", "owner"), member("pat", "owner")]);
    render(<TeamManagement />);
    expect(await screen.findByRole("combobox", { name: "Role of me@acme.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove pat@acme.test" })).toBeTruthy();
  });

  it("creates an invitation and shows the link once", async () => {
    apiMock.me.mockResolvedValue(session("admin"));
    apiMock.listMembers.mockResolvedValue([member("me", "admin")]);
    const created: InvitationDTO = { id: "i1", email: "new@acme.test", role: "viewer", status: "pending", expiresAt: "2026-10-20T00:00:00.000Z", createdAt: "2026-10-13T00:00:00.000Z", invitedBy: "me@acme.test" };
    apiMock.createInvitation.mockResolvedValue({ invitation: created, url: "http://localhost:3000/invite?token=abc" });
    apiMock.listInvitations.mockResolvedValueOnce([]).mockResolvedValue([created]);
    render(<TeamManagement />);

    fireEvent.change(await screen.findByPlaceholderText("colleague@company.com"), { target: { value: "new@acme.test" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: /Create invitation/ }));

    await waitFor(() => expect(apiMock.createInvitation).toHaveBeenCalledWith("new@acme.test", "viewer"));
    const link = (await screen.findByLabelText("Invitation link")) as HTMLInputElement;
    expect(link.value).toBe("http://localhost:3000/invite?token=abc");
    expect(screen.getByText(/shown only once/)).toBeTruthy();
    expect((screen.getByPlaceholderText("colleague@company.com") as HTMLInputElement).value).toBe(""); // form is cleared
  });

  it("shows a clear error when the server refuses and keeps the list as it was", async () => {
    apiMock.me.mockResolvedValue(session("admin"));
    apiMock.listMembers.mockResolvedValue([member("me", "admin"), member("pat", "member")]);
    apiMock.changeMemberRole.mockRejectedValue(new Error("You don't have permission to do that."));
    render(<TeamManagement />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Role of pat@acme.test" }), { target: { value: "admin" } });

    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission to do that.");
    expect(screen.getByRole("combobox", { name: "Role of pat@acme.test" })).toBeTruthy();
  });
});

describe("Invitation page", () => {
  it("says so for a link that isn't valid, and offers nothing to submit", async () => {
    apiMock.peekInvitation.mockRejectedValue(new Error("This invitation link is invalid or has expired."));
    render(<AcceptInvite token="bad" />);

    expect(await screen.findByText("This link isn't valid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /join/i })).toBeNull();
  });

  it("asks a new person for a password (at least 4 characters) and creates their account", async () => {
    apiMock.peekInvitation.mockResolvedValue({ organization: "Acme", email: "new@acme.test", role: "member", hasAccount: false });
    apiMock.acceptInvitation.mockResolvedValue({ redirect: "/admin", organization: "Acme" });
    render(<AcceptInvite token="tok" />);

    expect(await screen.findByText("Join Acme")).toBeTruthy();
    expect(screen.getByText("new@acme.test")).toBeTruthy();
    const submit = screen.getByRole("button", { name: /Create my account and join/ }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Choose a password"), { target: { value: "abc" } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Choose a password"), { target: { value: "abcd" } });
    expect(submit.disabled).toBe(false); // four characters is enough
    fireEvent.change(screen.getByLabelText("Choose a password"), { target: { value: "a long enough password" } });
    fireEvent.change(screen.getByLabelText("Your name (optional)"), { target: { value: "Nia" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(apiMock.acceptInvitation).toHaveBeenCalledWith({ token: "tok", password: "a long enough password", name: "Nia" }));
  });

  it("tells someone with an existing account to sign in first, and never asks them for a new password", async () => {
    apiMock.peekInvitation.mockResolvedValue({ organization: "Acme", email: "old@acme.test", role: "viewer", hasAccount: true });
    apiMock.acceptInvitation.mockRejectedValue(new Error("This email already has an account. Sign in, then open the invitation link again."));
    render(<AcceptInvite token="tok" />);

    expect(await screen.findByText(/already has an account/)).toBeTruthy();
    expect(screen.queryByLabelText("Choose a password")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Join" }));

    await waitFor(() => expect(apiMock.acceptInvitation).toHaveBeenCalledWith({ token: "tok" })); // no password sent
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in, then open the invitation link again.");
  });
});
