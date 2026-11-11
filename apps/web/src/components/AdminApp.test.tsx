import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import type { AuthStatus, StreamerApi } from "../api/client";
import { AdminApp } from "./AdminApp";
import { saveBeforeUpdate } from "./updateSave";

vi.mock("./AccountSettings", () => ({
  AccountSettings: ({ section }: { section: string }) => (
    <h2>{section === "cloud" ? "Cloud management" : "Household account"}</h2>
  ),
}));
vi.mock("./AccountSecurity", () => ({
  AccountSecurity: () => <h2>Household security</h2>,
}));
vi.mock("./IntegrationManager", () => ({ IntegrationManager: () => null }));
vi.mock("./AgentBackendSettings", () => ({ AgentBackendSettings: () => null }));
vi.mock("./SupportPanel", () => ({
  SupportPanel: () => <section id="settings-support">Report form</section>,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});
const profile = ViewerProfileSchema.parse({
  id: "alex",
  name: "Alex",
  locale: "en",
  onboardingComplete: true,
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
  pinEnabled: true,
});
const owner = {
  enabled: true,
  claimed: true,
  paired: true,
  role: "owner" as const,
  householdReady: true,
  cloudConfigured: true,
};
const ready: AuthStatus = {
  enabled: true,
  authenticated: true,
  cloudConfigured: true,
  householdReady: true,
  account: { id: "home", name: "Home", email: null, cloudLinked: false },
};
function apiWith(status = ready) {
  return {
    getInstallationStatus: vi.fn().mockResolvedValue(owner),
    getAuthStatus: vi.fn().mockResolvedValue(status),
    getProfiles: vi.fn().mockResolvedValue({ items: [profile], limit: 5 }),
    startLocalSession: vi.fn().mockResolvedValue({}),
    setupMasterPin: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as StreamerApi;
}

it("autosaves the household name without reopening administration before an update", async () => {
  const api = apiWith();
  api.renameHousehold = vi
    .fn()
    .mockResolvedValue({ householdId: "home", name: "Saved on update" });
  render(<AdminApp api={api} />);
  fireEvent.change(await screen.findByLabelText("Household name"), {
    target: { value: "Saved on update" },
  });
  await act(async () => saveBeforeUpdate());
  expect(api.renameHousehold).toHaveBeenCalledWith("Saved on update");
  expect(api.getInstallationStatus).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Save household name" }),
  ).toBeDisabled();
});

it("removes the one-time pairing URL after approval even if the device list cannot refresh", async () => {
  window.history.replaceState({}, "", "/admin/pair?code=123456");
  let decided = false;
  const fetcher = vi.fn(async (path: string) => {
    if (path.endsWith("/installation/status")) return Response.json(owner);
    if (path.endsWith("/installation/decision")) {
      decided = true;
      return Response.json({ status: "approved" });
    }
    if (path.endsWith("/installation/devices"))
      return decided
        ? Response.json({ error: {} }, { status: 503 })
        : Response.json({
            devices: [],
            pending: [{ id: "p1", name: "Living room TV", code: "123456" }],
          });
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetcher);
  render(<AdminApp api={apiWith()} />);
  expect(await screen.findByDisplayValue("123456")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(window.location.pathname).toBe("/admin"));
  expect(window.location.search).toBe("?tab=devices");
  expect(await screen.findByRole("alert")).toBeVisible();
});

it("does not discard a pairing link when approving a different request or when the decision fails", async () => {
  window.history.replaceState({}, "", "/admin/pair?code=123456");
  let requests = [
    { id: "p1", name: "First TV", code: "123456" },
    { id: "p2", name: "Second TV", code: "654321" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith("/installation/status")) return Response.json(owner);
      if (path.endsWith("/installation/devices"))
        return Response.json({ devices: [], pending: requests });
      if (path.endsWith("/installation/decision")) {
        const input = JSON.parse(String(init?.body)) as { requestId: string };
        if (input.requestId === "p1")
          return Response.json(
            { error: { code: "CODE_MISMATCH" } },
            { status: 403 },
          );
        requests = requests.filter((item) => item.id !== input.requestId);
        return Response.json({ status: "approved" });
      }
      throw new Error("Unexpected request");
    }),
  );
  render(<AdminApp api={apiWith()} />);
  const second = await screen.findByText("Second TV");
  const card = second.closest<HTMLElement>(".admin-pairing-request")!;
  fireEvent.change(
    within(card).getByLabelText("Code shown on the requesting device"),
    { target: { value: "654321" } },
  );
  fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(screen.queryByText("Second TV")).not.toBeInTheDocument(),
  );
  expect(window.location.pathname + window.location.search).toBe(
    "/admin/pair?code=123456",
  );
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await screen.findByRole("alert");
  expect(window.location.pathname + window.location.search).toBe(
    "/admin/pair?code=123456",
  );
});

it("retires an old pairing link once the server confirms no matching request exists", async () => {
  window.history.replaceState({}, "", "/admin/pair?code=123456");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.endsWith("/installation/status")
        ? Response.json(owner)
        : Response.json({ devices: [], pending: [] }),
    ),
  );
  render(<AdminApp api={apiWith()} />);
  expect(
    await screen.findByText(
      "This pairing request is no longer waiting for approval.",
    ),
  ).toBeVisible();
  expect(window.location.pathname + window.location.search).toBe(
    "/admin?tab=devices",
  );
});

it("drops the pairing route when the owner navigates to another section", async () => {
  window.history.replaceState({}, "", "/admin/pair?code=123456");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.endsWith("/installation/status")
        ? Response.json(owner)
        : Response.json({
            devices: [],
            pending: [{ id: "p1", name: "TV", code: "123456" }],
          }),
    ),
  );
  render(<AdminApp api={apiWith()} />);
  await screen.findByDisplayValue("123456");
  fireEvent.click(screen.getByRole("button", { name: "Cloud" }));
  expect(window.location.pathname + window.location.search).toBe(
    "/admin?tab=cloud",
  );
});

it("shows cloud management on its own page", async () => {
  render(<AdminApp api={apiWith()} />);
  expect(
    await screen.findByRole("heading", { name: "Household account" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Cloud management" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cloud" }));
  expect(
    screen.getByRole("heading", { name: "Cloud management" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Household account" }),
  ).not.toBeInTheDocument();
});

it("returns an expired browser to household authorization without reopening setup", async () => {
  const api = apiWith();
  render(<AdminApp api={api} />);
  await screen.findByRole("heading", { name: "Household account" });
  vi.mocked(api.getInstallationStatus!).mockResolvedValue({
    ...owner,
    paired: false,
    role: null,
  });
  fireEvent(window, new Event("streamer:auth-required"));
  expect(
    await screen.findByText(
      "Enter this household's Master PIN to administer this server.",
    ),
  ).toBeVisible();
  expect(api.getProfiles).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("heading", { name: "Set up your household" }),
  ).not.toBeInTheDocument();
});

it("opens the report form from the administration header", async () => {
  render(<AdminApp api={apiWith()} />);
  const report = await screen.findByRole("button", { name: "Report a bug" });
  expect(report.closest("header")).toContainElement(
    screen.getByRole("link", { name: /Open player/ }),
  );
  fireEvent.click(report);
  expect(screen.getByText("Report form")).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Frequently asked questions" }),
  ).toBeVisible();
});

it("groups household backups and their schedule on the Backups page", async () => {
  const api = apiWith();
  api.getBackupSchedule = vi.fn().mockResolvedValue({
    enabled: true,
    intervalMinutes: 1440,
    cloudEnabled: true,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      Response.json(
        path.includes("installation/status")
          ? owner
          : { cloudConfigured: false },
      ),
    ),
  );
  render(<AdminApp api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Backups" }));
  expect(
    await screen.findByRole("heading", { name: "Household backups" }),
  ).toBeVisible();
  expect(
    screen.getByRole("heading", { name: "Automatic backup schedule" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Security" }));
  expect(
    screen.getByRole("heading", { name: "Household security" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("heading", { name: "Automatic backup schedule" }),
  ).not.toBeInTheDocument();
});

it("creates a household in administration and asks for its PIN once", async () => {
  let started = false,
    created = false,
    setupAuthorized = false;
  const api = apiWith();
  api.getInstallationStatus = vi.fn().mockImplementation(async () => ({
    ...owner,
    claimed: created,
    paired: created,
    role: created ? "owner" : null,
    householdReady: created,
    setupAvailable: !created,
    setupAuthorized: !created && setupAuthorized,
  }));
  api.beginHouseholdSetup = vi.fn().mockImplementation(async () => {
    setupAuthorized = true;
    return { setupAuthorized: true };
  });
  vi.mocked(api.getAuthStatus!).mockImplementation(async () => ({
    ...ready,
    householdReady: created,
    householdSetupStarted: started,
    masterPinSetupRequired: !created,
  }));
  api.startLocalSession = vi.fn().mockImplementation(async () => {
    started = true;
    return {};
  });
  api.setupMasterPin = vi.fn().mockImplementation(async () => {
    created = true;
    return { ok: true };
  });
  render(
    <StrictMode>
      <AdminApp api={api} />
    </StrictMode>,
  );
  expect(
    await screen.findByRole("heading", { name: "Set up your household" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Import a backup" })).toBeVisible();
  expect(screen.queryByLabelText("One-time setup key")).not.toBeInTheDocument();
  expect(api.beginHouseholdSetup).toHaveBeenCalledOnce();
  expect(api.setupMasterPin).not.toHaveBeenCalled();
  fireEvent.click(
    await screen.findByRole("button", { name: "Create a household" }),
  );
  const pin = await screen.findByLabelText("Master PIN (8 digits)");
  fireEvent.change(pin, { target: { value: "01234567" } });
  fireEvent.change(screen.getByLabelText("Confirm Master PIN"), {
    target: { value: "01234567" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Master PIN" }));
  expect(
    await screen.findByRole("heading", { name: "Household account" }),
  ).toBeVisible();
  expect(api.setupMasterPin).toHaveBeenCalledOnce();
  expect(api.setupMasterPin).toHaveBeenCalledWith("01234567", "01234567");
});

it("loads an existing cloud household for import and asks for its existing PIN", async () => {
  const api = apiWith({
    ...ready,
    householdReady: false,
    householdRestoreRequired: true,
    masterPinSetupRequired: false,
  });
  const backup = { format: "streamerai-master-pin-household", version: 1 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      if (path.endsWith("installation/status")) return Response.json(owner);
      if (path.endsWith("/cloud"))
        return Response.json({ revision: 4, envelope: backup });
      return Response.json({ cloudConfigured: true });
    }),
  );
  render(<AdminApp api={api} />);
  expect(
    await screen.findByRole("heading", {
      name: "Restore your cloud household",
    }),
  ).toBeVisible();
  const input = await screen.findByLabelText("Master PIN for this backup");
  expect(
    input.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
  ).toHaveLength(8);
  expect(screen.queryByLabelText("Confirm Master PIN")).not.toBeInTheDocument();
  expect(
    screen.queryByLabelText("Encrypted household file"),
  ).not.toBeInTheDocument();
  expect(api.setupMasterPin).not.toHaveBeenCalled();
});

it("asks for the existing household PIN after cloud sign-in and exposes recovery", async () => {
  const api = apiWith({
    ...ready,
    householdReady: false,
    householdSetupStarted: false,
    householdPinRequired: true,
    account: { id: "home", name: "Home", email: null, cloudLinked: true },
  });
  api.verifyMasterPin = vi.fn().mockResolvedValue(undefined);
  render(<AdminApp api={api} />);
  const input = await screen.findByLabelText("Current Master PIN");
  expect(screen.getByRole("link", { name: "Forgot PIN?" })).toHaveAttribute(
    "href",
    "/admin/recover",
  );
  expect(api.setupMasterPin).not.toHaveBeenCalled();
  expect(
    input.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
  ).toHaveLength(8);
});

it("requires owner authorization before showing administration", async () => {
  const api = apiWith();
  let authorized = false;
  api.getInstallationStatus = vi.fn().mockImplementation(async () => ({
    ...owner,
    paired: authorized,
    role: authorized ? "owner" : null,
  }));
  api.authorizeInstallation = vi.fn().mockImplementation(async () => {
    authorized = true;
    return { ok: true };
  });
  render(<AdminApp api={api} />);
  const pin = await screen.findByLabelText("Household Master PIN");
  expect(api.getProfiles).not.toHaveBeenCalled();
  fireEvent.change(pin, { target: { value: "01234567" } });
  fireEvent.click(screen.getByRole("button", { name: "Open administration" }));
  expect(
    await screen.findByRole("heading", { name: "Household account" }),
  ).toBeVisible();
  expect(api.authorizeInstallation).toHaveBeenCalledWith({
    masterPin: "01234567",
    deviceName: "Home browser",
    admin: true,
  });
});

it("resets a profile PIN locally and saves the backup schedule", async () => {
  const api = apiWith();
  api.resetProfilePin = vi.fn().mockResolvedValue({ ok: true });
  api.getBackupSchedule = vi.fn().mockResolvedValue({
    enabled: true,
    intervalMinutes: 1440,
    cloudEnabled: false,
  });
  api.saveBackupSchedule = vi.fn().mockImplementation(async (value) => value);
  render(<AdminApp api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: /^Profiles$/ }));
  expect(screen.queryByLabelText("New profile name")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Add profile" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reset profile PIN" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.resetProfilePin).toHaveBeenCalledWith("alex"));
  fireEvent.click(await screen.findByRole("button", { name: /^Backups$/ }));
  const interval = await screen.findByLabelText("Backup interval (minutes)");
  await waitFor(() => expect(interval).toBeEnabled());
  fireEvent.change(interval, { target: { value: "60" } });
  fireEvent.click(screen.getByRole("button", { name: "Save backup schedule" }));
  await waitFor(() =>
    expect(api.saveBackupSchedule).toHaveBeenCalledWith({
      enabled: true,
      intervalMinutes: 60,
      cloudEnabled: false,
    }),
  );
});

it("selects a cloud household before asking for its existing backup PIN", async () => {
  let selected = false;
  const api = apiWith();
  api.getAuthStatus = vi.fn().mockImplementation(async () => ({
    ...ready,
    householdReady: false,
    householdSelectionRequired: !selected,
    householdRestoreRequired: selected,
  }));
  api.getCloudHouseholds = vi.fn().mockResolvedValue({
    households: [
      { id: "home-one", name: "City home", hasBackup: true },
      { id: "home-two", name: "Weekend home", hasBackup: true },
    ],
    canCreate: true,
  });
  api.selectCloudHousehold = vi.fn().mockImplementation(async () => {
    selected = true;
    return { ok: true };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.endsWith("installation/status")
        ? Response.json(owner)
        : path.endsWith("/cloud")
          ? Response.json({ revision: 2, envelope: { version: 1 } })
          : Response.json({ cloudConfigured: true }),
    ),
  );
  render(<AdminApp api={api} />);
  fireEvent.click(await screen.findByRole("button", { name: "Weekend home" }));
  await screen.findByLabelText("Master PIN for this backup");
  expect(api.selectCloudHousehold).toHaveBeenCalledWith({
    householdId: "home-two",
  });
  expect(api.setupMasterPin).not.toHaveBeenCalled();
});

it("saves the name of this household even before any profile is created", async () => {
  const api = apiWith();
  api.getInstallationStatus = vi
    .fn()
    .mockResolvedValue({ ...owner, householdName: "Home" });
  api.getProfiles = vi.fn().mockResolvedValue({ items: [], limit: 5 });
  api.renameHousehold = vi
    .fn()
    .mockResolvedValue({ householdId: "home", name: "Weekend home" });
  render(<AdminApp api={api} />);
  fireEvent.change(await screen.findByLabelText("Household name"), {
    target: { value: "Weekend home" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save household name" }));
  await waitFor(() =>
    expect(api.renameHousehold).toHaveBeenCalledWith("Weekend home"),
  );
  expect(
    await screen.findByRole("heading", { name: "Household account" }),
  ).toBeVisible();
});

it("resets a forgotten Master PIN locally only after fresh cloud owner approval", async () => {
  window.history.replaceState({}, "", "/admin/recover");
  const api = apiWith();
  api.getInstallationStatus = vi.fn().mockResolvedValue({
    ...owner,
    cloudLinked: true,
    cloudRecoveryAuthorized: true,
  });
  api.resetMasterPin = vi
    .fn()
    .mockRejectedValue(new Error("Approval expired. Sign in again."));
  render(<AdminApp api={api} />);
  fireEvent.change(await screen.findByLabelText("Master PIN (8 digits)"), {
    target: { value: "01234567" },
  });
  fireEvent.change(screen.getByLabelText("Confirm Master PIN"), {
    target: { value: "01234567" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save Master PIN" }));
  await screen.findByRole("alert");
  expect(api.resetMasterPin).toHaveBeenCalledWith("01234567", "01234567");
  expect(api.setupMasterPin).not.toHaveBeenCalled();
});
