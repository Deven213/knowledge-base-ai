// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryDTO, CreatedCustomerDTO, InvitationDTO, IssuedCredentialsDTO, PlatformMemberDTO, PlatformOrganizationDetailDTO, PlatformOrganizationDTO, SessionDTO } from "@/lib/types";

const apiMock = vi.hoisted(() => ({
  me: vi.fn(),
  platformListOrganizations: vi.fn(),
  platformCreateCustomer: vi.fn(),
  platformGetOrganization: vi.fn(),
  platformSetOrganizationStatus: vi.fn(),
  platformDeleteOrganization: vi.fn(),
  platformAddCustomerAdmin: vi.fn(),
  platformReissueCredentials: vi.fn(),
  platformRevokeCredentials: vi.fn(),
  platformRevokeInvitation: vi.fn(),
  platformSetUserStatus: vi.fn(),
  platformAuditLog: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import { PlatformConsole } from "@/components/platform/PlatformConsole";

const session: SessionDTO = {
  user: { id: "me", email: "super@platform.test", displayName: "Super", isPlatformAdmin: true },
  passwordChangeRequired: false,
  organization: { id: "hq", name: "Platform HQ", slug: "hq", role: "owner" },
  organizations: [{ id: "hq", name: "Platform HQ", slug: "hq", role: "owner" }],
  permissions: ["members:manage", "platform:admin"],
};

const org = (id: string, name: string, over: Partial<PlatformOrganizationDTO> = {}): PlatformOrganizationDTO => ({
  id,
  name,
  slug: id,
  reference: null,
  status: "active",
  createdAt: "2026-10-01T10:00:00.000Z",
  memberCount: 2,
  ownerCount: 1,
  pendingAdminInvites: 0,
  activation: { status: "activated", loginId: null, expiresAt: null },
  lastLoginAt: "2026-10-09T10:00:00.000Z",
  ...over,
});
const member = (id: string, over: Partial<PlatformMemberDTO> = {}): PlatformMemberDTO => ({
  userId: id,
  email: `${id}@acme.test`,
  displayName: null,
  role: "member",
  userStatus: "active",
  lastLoginAt: null,
  joinedAt: "2026-10-02T10:00:00.000Z",
  isPlatformAdmin: false,
  credential: { status: "set", expiresAt: null },
  ...over,
});
const detail = (o: PlatformOrganizationDTO, members: PlatformMemberDTO[], invitations: InvitationDTO[] = [], data = { documents: 3, conversations: 5, integrations: 1, consultations: 0 }): PlatformOrganizationDetailDTO => ({
  organization: o,
  members,
  invitations,
  data,
});

const TEMP = "Abcd-Efgh-Jkmn-Pqrs";
const credentials = (over: Partial<IssuedCredentialsDTO> = {}): IssuedCredentialsDTO => ({
  workspaceName: "Hooli Two",
  loginId: "gavin@hooli.test",
  temporaryPassword: TEMP,
  expiresAt: "2026-10-14T10:00:00.000Z",
  loginUrl: "http://localhost:3000/login",
  ...over,
});
const createdCustomer = (over: Partial<CreatedCustomerDTO> = {}): CreatedCustomerDTO => ({
  organization: org("hooli2", "Hooli Two", { memberCount: 1, activation: { status: "pending", loginId: "gavin@hooli.test", expiresAt: "2026-10-14T10:00:00.000Z" } }),
  workspaceName: "Hooli Two",
  loginId: "gavin@hooli.test",
  loginUrl: "http://localhost:3000/login",
  alreadyCreated: false,
  credentials: credentials(),
  ...over,
});

const ORGS = [
  org("acme", "Acme"),
  org("globex", "Globex", { status: "suspended" }),
  org("initech", "Initech", { reference: "CUST-0042", activation: { status: "pending", loginId: "boss@initech.test", expiresAt: "2026-10-14T10:00:00.000Z" } }),
  org("hooli", "Hooli", { ownerCount: 0, memberCount: 0, activation: { status: "none", loginId: null, expiresAt: null } }),
  org("lapsed", "Lapsed Co", { activation: { status: "expired", loginId: "old@lapsed.test", expiresAt: "2026-09-01T10:00:00.000Z" } }),
  org("hq", "Platform HQ", { memberCount: 1 }),
];

let clipboard: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.me.mockResolvedValue(session);
  apiMock.platformListOrganizations.mockResolvedValue(ORGS);
  // Some embedded browsers never show a native dialog and confirm() just returns false. Nothing in the console may depend on it.
  vi.stubGlobal("confirm", vi.fn(() => false));
  clipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const openOrg = async (name: string) => fireEvent.click(await screen.findByRole("button", { name: `Open ${name}` }));
/** The in-page confirmation that is open, and a click on one of its buttons. */
const dialog = () => screen.getByRole("dialog");
const clickInDialog = (name: string | RegExp) => fireEvent.click(within(dialog()).getByRole("button", { name }));

describe("customer list", () => {
  it("shows every workspace with its status and where its Customer Admin is with their first sign-in", async () => {
    render(<PlatformConsole />);

    const acme = await screen.findByRole("button", { name: "Open Acme" });
    expect(within(acme).getByText("Active")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open Globex" })).getByText("Suspended")).toBeTruthy();
    const initech = screen.getByRole("button", { name: "Open Initech" });
    expect(within(initech).getByText("Waiting for first sign-in")).toBeTruthy();
    expect(initech.textContent).toContain("login ID boss@initech.test");
    expect(initech.textContent).toContain("CUST-0042");
    expect(within(screen.getByRole("button", { name: "Open Hooli" })).getByText("No Customer Admin")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: "Open Lapsed Co" })).getByText("Temporary password expired")).toBeTruthy();
    expect(within(acme).queryByText(/first sign-in|expired|Customer Admin/i)).toBeNull(); // an activated customer needs no badge
    expect(screen.getByText("6 workspaces")).toBeTruthy();
  });

  it("shows a clear error when the server refuses", async () => {
    apiMock.platformListOrganizations.mockRejectedValue(new Error("You don't have permission to do that."));
    render(<PlatformConsole />);
    expect((await screen.findByRole("alert")).textContent).toContain("You don't have permission to do that.");
  });
});

describe("creating a customer", () => {
  async function fillAndCreate(over: { reference?: string } = {}) {
    fireEvent.click(await screen.findByRole("button", { name: /New customer/ }));
    fireEvent.change(screen.getByLabelText(/Company \/ workspace name/), { target: { value: "Hooli Two" } });
    fireEvent.change(screen.getByLabelText(/Customer Admin's email/), { target: { value: "gavin@hooli.test" } });
    if (over.reference) fireEvent.change(screen.getByLabelText(/Customer reference ID/), { target: { value: over.reference } });
    fireEvent.click(screen.getByRole("button", { name: /Create customer/ }));
  }

  it("creates the customer and shows the workspace, login page, login ID and temporary password once, with clear instructions", async () => {
    apiMock.platformCreateCustomer.mockResolvedValue(createdCustomer());
    render(<PlatformConsole />);

    await fillAndCreate();

    expect(await screen.findByText("Hooli Two was created.")).toBeTruthy();
    expect((screen.getByLabelText("Login ID") as HTMLInputElement).value).toBe("gavin@hooli.test");
    expect((screen.getByLabelText("Temporary password") as HTMLInputElement).value).toBe(TEMP);
    expect((screen.getByLabelText("Login page URL") as HTMLInputElement).value).toBe("http://localhost:3000/login");
    expect(screen.getByText("Hooli Two", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/only time the temporary password is shown/)).toBeTruthy();
    expect(screen.getByText(/must choose their own new password before they can do anything else/)).toBeTruthy();
    expect(screen.getByText(/Send the login page, login ID and temporary password to the customer yourself/)).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/invite\?token|setup link|verification code/i);
    expect(apiMock.platformListOrganizations).toHaveBeenCalledTimes(2); // the list was refreshed
  });

  it("copies all the credentials with one click, as a message ready to send", async () => {
    apiMock.platformCreateCustomer.mockResolvedValue(createdCustomer());
    render(<PlatformConsole />);
    await fillAndCreate();

    fireEvent.click(await screen.findByRole("button", { name: "Copy credentials" }));

    await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    const text = clipboard.mock.calls[0]![0] as string;
    expect(text).toContain("Workspace: Hooli Two");
    expect(text).toContain("Login page: http://localhost:3000/login");
    expect(text).toContain("Login ID: gavin@hooli.test");
    expect(text).toContain(`Temporary password: ${TEMP}`);
    expect(text).toMatch(/choose your own new password the first time you sign in/);
    expect(await screen.findByRole("button", { name: "Credentials copied" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy Temporary password" })); // and each value can be copied on its own
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(TEMP));
  });

  it("keeps the temporary password out of browser storage, cookies and the address bar, and removes it from the page on Done", async () => {
    apiMock.platformCreateCustomer.mockResolvedValue(createdCustomer());
    render(<PlatformConsole />);
    await fillAndCreate();
    await screen.findByLabelText("Temporary password");

    const outsideThePage = JSON.stringify([window.localStorage, window.sessionStorage, document.cookie, window.location.href]);
    expect(outsideThePage).not.toContain(TEMP);
    expect(Object.keys(window.localStorage)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
    expect(document.body.textContent).not.toContain(TEMP);
  });

  it("identifies each customer with one request id: a retry after a failure reuses it, the next customer gets a new one", async () => {
    apiMock.platformCreateCustomer.mockRejectedValueOnce(new Error("Could not reach the server.")).mockResolvedValue(createdCustomer());
    render(<PlatformConsole />);

    fireEvent.click(await screen.findByRole("button", { name: /New customer/ }));
    fireEvent.change(screen.getByLabelText(/Company \/ workspace name/), { target: { value: "Hooli Two" } });
    fireEvent.change(screen.getByLabelText(/Customer Admin's email/), { target: { value: "gavin@hooli.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create customer/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the server.");

    fireEvent.click(screen.getByRole("button", { name: /Create customer/ })); // the retry
    await screen.findByText("Hooli Two was created.");
    const [first, second] = apiMock.platformCreateCustomer.mock.calls.map((c) => c[0] as { requestId: string; name: string });
    expect(first!.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.requestId).toBe(first!.requestId); // the server can tell this is the same request

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: /New customer/ }));
    fireEvent.change(screen.getByLabelText(/Company \/ workspace name/), { target: { value: "Another Co" } });
    fireEvent.change(screen.getByLabelText(/Customer Admin's email/), { target: { value: "x@another.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create customer/ }));
    await waitFor(() => expect(apiMock.platformCreateCustomer).toHaveBeenCalledTimes(3));
    expect((apiMock.platformCreateCustomer.mock.calls[2]![0] as { requestId: string }).requestId).not.toBe(first!.requestId);
  });

  it("passes the optional customer reference on", async () => {
    apiMock.platformCreateCustomer.mockResolvedValue(createdCustomer());
    render(<PlatformConsole />);
    await fillAndCreate({ reference: "CUST-0042" });
    await waitFor(() => expect(apiMock.platformCreateCustomer).toHaveBeenCalledWith(expect.objectContaining({ name: "Hooli Two", adminEmail: "gavin@hooli.test", reference: "CUST-0042" })));
  });

  it("when the server says the customer already exists for this request it shows no password and says how to get a new one", async () => {
    apiMock.platformCreateCustomer.mockResolvedValue(createdCustomer({ alreadyCreated: true, credentials: null }));
    render(<PlatformConsole />);
    await fillAndCreate();

    const notice = await screen.findByText(/had already been created by this request/);
    expect(notice.textContent).toMatch(/can't be shown again/);
    expect(notice.textContent).toMatch(/Reissue temporary password/);
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
    expect(document.body.textContent).not.toContain(TEMP);
  });

  it("keeps the form and says why when the server refuses (for example an email that already has an account)", async () => {
    apiMock.platformCreateCustomer.mockRejectedValue(new Error("An account with that email address already exists. Use a different email address for the new Customer Admin."));
    render(<PlatformConsole />);

    fireEvent.click(await screen.findByRole("button", { name: /New customer/ }));
    fireEvent.change(screen.getByLabelText(/Company \/ workspace name/), { target: { value: "Acme Two" } });
    fireEvent.change(screen.getByLabelText(/Customer Admin's email/), { target: { value: "owner@acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Create customer/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
    expect((screen.getByLabelText(/Company \/ workspace name/) as HTMLInputElement).value).toBe("Acme Two");
  });
});

describe("one workspace", () => {
  const acme = org("acme", "Acme");

  it("lists its people with their credential state, and protects Super Admin accounts and the signed-in person", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(
      detail(acme, [
        member("owner", { role: "owner" }),
        member("temp", { role: "owner", credential: { status: "temporary", expiresAt: "2026-10-14T10:00:00.000Z" } }),
        member("late", { role: "owner", credential: { status: "expired", expiresAt: "2026-10-01T10:00:00.000Z" } }),
        member("vic", { userStatus: "disabled" }),
        member("me", { isPlatformAdmin: true }),
      ]),
    );
    render(<PlatformConsole />);
    await openOrg("Acme");

    expect(await screen.findByText("People (5)")).toBeTruthy();
    expect(screen.getByText(/Temporary password until/)).toBeTruthy();
    expect(screen.getByText("Temporary password expired")).toBeTruthy();
    // Reissue: for anyone who hasn't replaced a temporary password; Revoke only while it still works.
    expect(screen.getByRole("button", { name: "Reissue temporary password for temp@acme.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reissue temporary password for late@acme.test" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke temporary password for temp@acme.test" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke temporary password for late@acme.test" })).toBeNull();
    // Nothing of the kind for someone who chose their own password, or for a Super Admin.
    expect(screen.queryByRole("button", { name: /Reissue temporary password for (owner|vic|me)@acme.test/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /(Disable|Enable) me@acme.test/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Enable vic@acme.test" })).toBeTruthy();
    expect(screen.getByText(/never shown here/)).toBeTruthy();
  });

  it("reissues a temporary password after confirming in the page, and shows the new one once", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("temp", { role: "owner", credential: { status: "temporary", expiresAt: "2026-10-14T10:00:00.000Z" } })]));
    apiMock.platformReissueCredentials.mockResolvedValue(credentials({ workspaceName: "Acme", loginId: "temp@acme.test", temporaryPassword: "Zzzz-Yyyy-Xxxx-Wwww" }));
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.click(await screen.findByRole("button", { name: "Reissue temporary password for temp@acme.test" }));

    expect(within(dialog()).getByText(/current temporary password stops working and the person is signed out/)).toBeTruthy();
    expect(apiMock.platformReissueCredentials).not.toHaveBeenCalled(); // nothing happens until it is confirmed
    clickInDialog("Issue new password");
    await waitFor(() => expect(apiMock.platformReissueCredentials).toHaveBeenCalledWith("acme", "temp"));
    expect(((await screen.findByLabelText("Temporary password")) as HTMLInputElement).value).toBe("Zzzz-Yyyy-Xxxx-Wwww");
    expect(screen.getByText("New temporary password for temp@acme.test.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("revokes a temporary password after confirming in the page", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("temp", { role: "owner", credential: { status: "temporary", expiresAt: "2026-10-14T10:00:00.000Z" } })]));
    apiMock.platformRevokeCredentials.mockResolvedValue({ revoked: true, loginId: "temp@acme.test" });
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.click(await screen.findByRole("button", { name: "Revoke temporary password for temp@acme.test" }));

    expect(within(dialog()).getByText(/stops working immediately/)).toBeTruthy();
    clickInDialog("Revoke password");
    await waitFor(() => expect(apiMock.platformRevokeCredentials).toHaveBeenCalledWith("acme", "temp"));
    await waitFor(() => expect(apiMock.platformGetOrganization).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does nothing when a confirmation is cancelled", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat"), member("temp", { credential: { status: "temporary", expiresAt: "2026-10-14T10:00:00.000Z" } })]));
    render(<PlatformConsole />);
    await openOrg("Acme");

    await screen.findByText("People (2)");
    for (const open of [{ name: "Disable pat@acme.test" }, { name: "Reissue temporary password for temp@acme.test" }, { name: "Revoke temporary password for temp@acme.test" }, { name: /^Suspend$/ }, { name: /^Delete customer/ }]) {
      fireEvent.click(screen.getByRole("button", open));
      clickInDialog("Cancel");
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: /^Suspend$/ }));
    fireEvent.keyDown(window, { key: "Escape" }); // Escape cancels too
    expect(screen.queryByRole("dialog")).toBeNull();

    expect(apiMock.platformSetUserStatus).not.toHaveBeenCalled();
    expect(apiMock.platformReissueCredentials).not.toHaveBeenCalled();
    expect(apiMock.platformRevokeCredentials).not.toHaveBeenCalled();
    expect(apiMock.platformSetOrganizationStatus).not.toHaveBeenCalled();
    expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled();
  });

  it("disables an account after confirming in the page, then reloads", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
    apiMock.platformSetUserStatus.mockResolvedValue({ userId: "pat", email: "pat@acme.test", status: "disabled" });
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.click(await screen.findByRole("button", { name: "Disable pat@acme.test" }));

    expect(within(dialog()).getByText(/signed out everywhere/)).toBeTruthy();
    clickInDialog("Disable account");
    await waitFor(() => expect(apiMock.platformSetUserStatus).toHaveBeenCalledWith("pat", "disabled"));
    await waitFor(() => expect(apiMock.platformGetOrganization).toHaveBeenCalledTimes(2));
  });

  it("enables a disabled account straight away (restoring access needs no warning)", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("vic", { userStatus: "disabled" })]));
    apiMock.platformSetUserStatus.mockResolvedValue({ userId: "vic", email: "vic@acme.test", status: "active" });
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.click(await screen.findByRole("button", { name: "Enable vic@acme.test" }));

    await waitFor(() => expect(apiMock.platformSetUserStatus).toHaveBeenCalledWith("vic", "active"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  describe("suspending and reactivating", () => {
    it("opens a dialog that explains what happens, suspends on confirmation and shows the new status at once, without waiting for a reload", async () => {
      apiMock.platformGetOrganization.mockResolvedValueOnce(detail(acme, [member("pat")]));
      apiMock.platformGetOrganization.mockReturnValue(new Promise(() => undefined)); // the follow-up reload never answers: the screen must already be right
      apiMock.platformSetOrganizationStatus.mockResolvedValue({ ...acme, status: "suspended" });
      render(<PlatformConsole />);
      await openOrg("Acme");
      expect((await screen.findByText("Active")).textContent).toBe("Active");

      fireEvent.click(screen.getByRole("button", { name: /^Suspend$/ }));

      expect(within(dialog()).getByText("Suspend Acme?")).toBeTruthy();
      expect(within(dialog()).getByText(/signed out immediately/)).toBeTruthy();
      expect(within(dialog()).getByText(/Nothing is deleted/)).toBeTruthy();
      expect(apiMock.platformSetOrganizationStatus).not.toHaveBeenCalled(); // opening the dialog changes nothing
      clickInDialog("Suspend workspace");

      await waitFor(() => expect(apiMock.platformSetOrganizationStatus).toHaveBeenCalledWith("acme", "suspended"));
      expect(await screen.findByText("Suspended")).toBeTruthy();
      expect(screen.queryByText("Active")).toBeNull();
      expect(screen.getByRole("button", { name: /^Reactivate$/ })).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(confirm).not.toHaveBeenCalled();
    });

    it("reactivates a suspended workspace, saying that expired credentials and earlier sign-ins are not revived", async () => {
      apiMock.platformGetOrganization.mockResolvedValueOnce(detail({ ...acme, status: "suspended" }, [member("pat")]));
      apiMock.platformGetOrganization.mockReturnValue(new Promise(() => undefined));
      apiMock.platformSetOrganizationStatus.mockResolvedValue({ ...acme, status: "active" });
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Reactivate$/ }));

      expect(within(dialog()).getByText("Reactivate Acme?")).toBeTruthy();
      expect(within(dialog()).getByText(/Earlier sign-ins stay ended/)).toBeTruthy();
      expect(within(dialog()).getByText(/stays expired/)).toBeTruthy();
      clickInDialog("Reactivate workspace");

      await waitFor(() => expect(apiMock.platformSetOrganizationStatus).toHaveBeenCalledWith("acme", "active"));
      expect(await screen.findByText("Active")).toBeTruthy();
      expect(screen.queryByText("Suspended")).toBeNull();
      expect(screen.getByRole("button", { name: /^Suspend$/ })).toBeTruthy();
    });

    it("tells the Super Admin clearly when the server refuses, keeps the dialog open, leaves the status alone, and lets them try again", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      apiMock.platformSetOrganizationStatus.mockRejectedValueOnce(new Error("Could not reach the server.")).mockResolvedValueOnce({ ...acme, status: "suspended" });
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Suspend$/ }));
      clickInDialog("Suspend workspace");

      expect((await within(dialog()).findByRole("alert")).textContent).toContain("Could not reach the server.");
      expect(screen.getByText("Active")).toBeTruthy(); // nothing changed
      expect((within(dialog()).getByRole("button", { name: "Suspend workspace" }) as HTMLButtonElement).disabled).toBe(false);

      clickInDialog("Suspend workspace"); // the retry
      await waitFor(() => expect(apiMock.platformSetOrganizationStatus).toHaveBeenCalledTimes(2));
      expect(await screen.findByText("Suspended")).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("sends one request however many times the button is clicked while it is working", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      let finish!: (o: PlatformOrganizationDTO) => void;
      apiMock.platformSetOrganizationStatus.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Suspend$/ }));
      const button = within(dialog()).getByRole("button", { name: "Suspend workspace" }) as HTMLButtonElement;
      fireEvent.click(button);
      fireEvent.click(button);
      fireEvent.click(button);

      expect(button.disabled).toBe(true);
      expect((within(dialog()).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
      expect(apiMock.platformSetOrganizationStatus).toHaveBeenCalledTimes(1);
      finish({ ...acme, status: "suspended" });
      expect(await screen.findByText("Suspended")).toBeTruthy();
    });

    it("won't offer to suspend the workspace the Super Admin is signed in to, and says why", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(org("hq", "Platform HQ"), [member("me", { isPlatformAdmin: true, role: "owner" })]));
      render(<PlatformConsole />);
      await openOrg("Platform HQ");

      const button = (await screen.findByRole("button", { name: /^Suspend$/ })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.title).toMatch(/signed in to this workspace/);
      expect(screen.getAllByText(/Switch to another workspace first/).length).toBeGreaterThan(0);
      fireEvent.click(button);
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("deleting a customer", () => {
    const rows = ORGS.filter((o) => o.id !== "acme");
    const typeName = (value: string) => fireEvent.change(within(dialog()).getByLabelText(/Type the workspace name/), { target: { value } });
    const deleteButton = () => within(dialog()).getByRole("button", { name: "Delete permanently" }) as HTMLButtonElement;

    it("opens a dialog that names the customer, says the deletion is permanent and what goes with it, and deletes nothing until the name is typed", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat"), member("kim")]));
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));

      const d = dialog();
      expect(within(d).getByText("Delete Acme?")).toBeTruthy();
      expect(d.textContent).toMatch(/permanently deletes the customer workspace "Acme" and cannot be undone/);
      expect(d.textContent).toMatch(/2 people, 3 documents \(and their\s+search index\), 5 chats, 1 connected integration/);
      expect(d.textContent).toMatch(/lose their accounts too/);
      expect(d.textContent).toMatch(/audit log keeps a record/);
      expect(d.textContent).toMatch(/suspending/);

      expect(deleteButton().disabled).toBe(true);
      fireEvent.click(deleteButton()); // a click on the disabled button does nothing
      typeName("Acm");
      expect(deleteButton().disabled).toBe(true);
      typeName("Globex");
      expect(deleteButton().disabled).toBe(true);
      expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled();
      typeName("acme"); // the name is matched without regard to capitals
      expect(deleteButton().disabled).toBe(false);
      expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled(); // still nothing until the button is pressed
      expect(confirm).not.toHaveBeenCalled();
    });

    it("uses singular wording for a workspace with one of each", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")], [], { documents: 1, conversations: 1, integrations: 1, consultations: 0 }));
      render(<PlatformConsole />);
      await openOrg("Acme");
      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      expect(dialog().textContent).toMatch(/1 person, 1 document \(and their\s+search index\), 1 chat, 1 connected integration/);
    });

    it("deletes after the name is typed, returns to the list with a notice, and the customer is gone from the list", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      apiMock.platformDeleteOrganization.mockResolvedValue({ id: "acme", name: "Acme", members: 1, accountsDeleted: 1, accountsKept: 0, recordingsRemoved: 0, recordingsPending: 0, data: { documents: 3, conversations: 5, integrations: 1, consultations: 0 } });
      apiMock.platformListOrganizations.mockResolvedValueOnce(ORGS).mockResolvedValue(rows); // the refreshed list no longer has Acme
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      typeName(" acme "); // what is typed is what the server is given to check (it trims it and ignores capitals)
      fireEvent.click(deleteButton());

      await waitFor(() => expect(apiMock.platformDeleteOrganization).toHaveBeenCalledWith("acme", "acme"));
      expect((await screen.findByRole("status")).textContent).toMatch(/Acme was deleted, together with its data/);
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(screen.queryByRole("button", { name: "Open Acme" })).toBeNull());
      expect(screen.getByRole("button", { name: "Open Globex" })).toBeTruthy(); // everybody else is still listed
      expect(screen.getByText("5 workspaces")).toBeTruthy();
      expect(apiMock.platformListOrganizations).toHaveBeenCalledTimes(2);
    });

    it("pressing Enter in the name box deletes too, but only once the name matches", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      apiMock.platformDeleteOrganization.mockResolvedValue({ id: "acme", name: "Acme", members: 1, accountsDeleted: 1, accountsKept: 0, recordingsRemoved: 0, recordingsPending: 0, data: { documents: 0, conversations: 0, integrations: 0, consultations: 0 } });
      render(<PlatformConsole />);
      await openOrg("Acme");
      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      const box = within(dialog()).getByLabelText(/Type the workspace name/);

      typeName("Acm");
      fireEvent.keyDown(box, { key: "Enter" });
      expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled();
      typeName("Acme");
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(apiMock.platformDeleteOrganization).toHaveBeenCalledTimes(1));
    });

    it("cancelling deletes nothing, leaves the workspace open and the list unchanged", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      typeName("Acme");
      clickInDialog("Cancel");

      expect(screen.queryByRole("dialog")).toBeNull();
      expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled();
      expect(screen.getByText("People (1)")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^Delete customer/ })); // reopening starts from an empty box
      expect((within(dialog()).getByLabelText(/Type the workspace name/) as HTMLInputElement).value).toBe("");
      expect(deleteButton().disabled).toBe(true);
    });

    it("shows the server's reason inside the dialog when it refuses, deletes nothing on screen, and can be retried", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      apiMock.platformDeleteOrganization
        .mockRejectedValueOnce(new Error("Acme can't be deleted while a document is still being processed or a sync is running."))
        .mockResolvedValueOnce({ id: "acme", name: "Acme", members: 1, accountsDeleted: 1, accountsKept: 0, recordingsRemoved: 0, recordingsPending: 0, data: { documents: 3, conversations: 5, integrations: 1, consultations: 0 } });
      render(<PlatformConsole />);
      await openOrg("Acme");

      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      typeName("Acme");
      fireEvent.click(deleteButton());

      expect((await within(dialog()).findByRole("alert")).textContent).toContain("still being processed");
      expect(screen.getByText("People (1)")).toBeTruthy(); // still on the workspace page, nothing was removed from it
      expect(deleteButton().disabled).toBe(false);

      fireEvent.click(deleteButton());
      await waitFor(() => expect(apiMock.platformDeleteOrganization).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/was deleted, together with its data/)).toBeTruthy();
    });

    it("sends one deletion however many times the button is clicked while it is working", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
      let finish!: (v: unknown) => void;
      apiMock.platformDeleteOrganization.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      render(<PlatformConsole />);
      await openOrg("Acme");
      fireEvent.click(await screen.findByRole("button", { name: /^Delete customer/ }));
      typeName("Acme");

      fireEvent.click(deleteButton());
      fireEvent.click(deleteButton());

      expect(apiMock.platformDeleteOrganization).toHaveBeenCalledTimes(1);
      expect(deleteButton().disabled).toBe(true);
      expect((within(dialog()).getByLabelText(/Type the workspace name/) as HTMLInputElement).disabled).toBe(true);
      finish({ id: "acme", name: "Acme", members: 1, accountsDeleted: 1, accountsKept: 0, recordingsRemoved: 0, recordingsPending: 0, data: { documents: 0, conversations: 0, integrations: 0, consultations: 0 } });
      expect(await screen.findByText(/was deleted, together with its data/)).toBeTruthy();
    });

    it("doesn't offer to delete the workspace the Super Admin is signed in to, or one that contains a Super Admin, and says why", async () => {
      apiMock.platformGetOrganization.mockResolvedValue(detail(org("hq", "Platform HQ"), [member("me", { isPlatformAdmin: true, role: "owner" })]));
      render(<PlatformConsole />);
      await openOrg("Platform HQ");

      const hq = (await screen.findByRole("button", { name: /^Delete customer/ })) as HTMLButtonElement;
      expect(hq.disabled).toBe(true);
      expect(screen.getAllByText(/signed in to this workspace, so it can't be suspended or deleted/).length).toBeGreaterThan(0);
      fireEvent.click(hq);
      expect(screen.queryByRole("dialog")).toBeNull();

      cleanup();
      apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat"), member("boss", { isPlatformAdmin: true })]));
      render(<PlatformConsole />);
      await openOrg("Acme");
      const other = (await screen.findByRole("button", { name: /^Delete customer/ })) as HTMLButtonElement;
      expect(other.disabled).toBe(true);
      expect(screen.getByText(/contains a Super Admin account/)).toBeTruthy();
      expect(apiMock.platformDeleteOrganization).not.toHaveBeenCalled();
    });
  });

  it("adds a Customer Admin and shows their temporary password once; a suspended workspace can't be given one", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
    apiMock.platformAddCustomerAdmin.mockResolvedValue(credentials({ workspaceName: "Acme", loginId: "new-admin@acme.test" }));
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.change(await screen.findByLabelText(/Customer Admin's email/), { target: { value: "new-admin@acme.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Add Customer Admin/ }));

    await waitFor(() => expect(apiMock.platformAddCustomerAdmin).toHaveBeenCalledWith("acme", "new-admin@acme.test"));
    expect(((await screen.findByLabelText("Login ID")) as HTMLInputElement).value).toBe("new-admin@acme.test");
    expect((screen.getByLabelText("Temporary password") as HTMLInputElement).value).toBe(TEMP);

    cleanup();
    apiMock.platformGetOrganization.mockResolvedValue(detail({ ...acme, status: "suspended" }, [member("pat")]));
    render(<PlatformConsole />);
    await openOrg("Acme");
    expect(((await screen.findByRole("button", { name: /Add Customer Admin/ })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Reactivate the workspace to add a Customer Admin/)).toBeTruthy();
  });

  it("shows the server's reason when an address already has an account", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
    apiMock.platformAddCustomerAdmin.mockRejectedValue(new Error("An account with that email address already exists. Use a different email address for the new Customer Admin."));
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.change(await screen.findByLabelText(/Customer Admin's email/), { target: { value: "owner@globex.test" } });
    fireEvent.click(screen.getByRole("button", { name: /Add Customer Admin/ }));

    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(screen.queryByLabelText("Temporary password")).toBeNull();
  });

  it("lists invitation links issued earlier, which can be withdrawn", async () => {
    const pending: InvitationDTO = { id: "inv1", email: "boss@acme.test", role: "owner", status: "pending", expiresAt: "2026-10-18T10:00:00.000Z", createdAt: "2026-10-11T10:00:00.000Z", invitedBy: "super@platform.test" };
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [], [pending, { ...pending, id: "inv0", email: "old@acme.test", status: "revoked" }]));
    apiMock.platformRevokeInvitation.mockResolvedValue(undefined);
    render(<PlatformConsole />);
    await openOrg("Acme");

    expect(await screen.findByText("boss@acme.test")).toBeTruthy();
    expect(screen.getByText(/issued earlier/)).toBeTruthy();
    expect(screen.queryByText("old@acme.test")).toBeNull(); // only unused ones are listed
    fireEvent.click(screen.getByRole("button", { name: "Withdraw invitation link for boss@acme.test" }));

    await waitFor(() => expect(apiMock.platformRevokeInvitation).toHaveBeenCalledWith("acme", "inv1"));
  });

  it("shows the server's reason when an action is refused and stays on the page", async () => {
    apiMock.platformGetOrganization.mockResolvedValue(detail(acme, [member("pat")]));
    apiMock.platformSetUserStatus.mockRejectedValue(new Error("Platform administrators can't be disabled from here."));
    render(<PlatformConsole />);
    await openOrg("Acme");

    fireEvent.click(await screen.findByRole("button", { name: "Disable pat@acme.test" }));
    clickInDialog("Disable account");

    expect((await within(dialog()).findByRole("alert")).textContent).toContain("can't be disabled from here");
    expect(screen.getByText("People (1)")).toBeTruthy();
  });
});

describe("audit log", () => {
  const entry = (id: number, over: Partial<AuditEntryDTO> = {}): AuditEntryDTO => ({
    id,
    at: "2026-10-11T10:00:00.000Z",
    actorEmail: "super@platform.test",
    action: "platform.organization.suspend",
    targetOrgId: "acme",
    targetLabel: "Acme",
    outcome: "success",
    ip: null,
    details: {},
    ...over,
  });

  it("shows who did what in plain language, flags refused attempts, and pages back through older entries", async () => {
    const page = Array.from({ length: 100 }, (_, i) => entry(500 - i));
    page[0] = entry(500, { action: "platform.access_denied", outcome: "denied", actorEmail: "owner@acme.test", targetLabel: null, details: { method: "GET", path: "/api/platform/organizations" } });
    apiMock.platformAuditLog.mockResolvedValueOnce(page).mockResolvedValueOnce([entry(400, { action: "org.member.remove", targetLabel: null })]);
    render(<PlatformConsole />);

    fireEvent.click(await screen.findByRole("tab", { name: /Audit log/ }));

    expect(await screen.findByText("Blocked a Super Admin request")).toBeTruthy();
    expect(screen.getByText("denied")).toBeTruthy();
    expect(screen.getByText(/by owner@acme.test/)).toBeTruthy();
    expect(screen.getAllByText("Suspended a workspace").length).toBeGreaterThan(50);
    expect(apiMock.platformAuditLog).toHaveBeenCalledWith({ limit: 100 });

    fireEvent.click(screen.getByRole("button", { name: /Load older entries/ }));
    await waitFor(() => expect(apiMock.platformAuditLog).toHaveBeenLastCalledWith({ limit: 100, before: 401 }));
    expect(await screen.findByText("Removed a person")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Load older entries/ })).toBeNull(); // the last page was short
  });

  it("names the credential events in plain language", async () => {
    apiMock.platformAuditLog.mockResolvedValue([
      entry(4, { action: "auth.password.change", actorEmail: "boss@initech.test", targetLabel: null, details: { forced: true } }),
      entry(3, { action: "platform.credentials.revoke", targetLabel: "boss@initech.test" }),
      entry(2, { action: "platform.credentials.reissue", targetLabel: "boss@initech.test" }),
      entry(1, { action: "platform.customer_admin.add", targetLabel: "Initech" }),
      entry(5, { action: "platform.organization.delete", targetLabel: "Acme" }),
    ]);
    render(<PlatformConsole />);
    fireEvent.click(await screen.findByRole("tab", { name: /Audit log/ }));

    for (const label of ["Chose a new password", "Revoked a temporary password", "Issued a new temporary password", "Added a Customer Admin", "Deleted a customer workspace"]) expect(await screen.findByText(label)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/platform\.credentials|auth\.password/); // no raw technical names
  });

  it("says so when there is nothing yet", async () => {
    apiMock.platformAuditLog.mockResolvedValue([]);
    render(<PlatformConsole />);
    fireEvent.click(await screen.findByRole("tab", { name: /Audit log/ }));
    expect(await screen.findByText("Nothing recorded yet.")).toBeTruthy();
  });
});
