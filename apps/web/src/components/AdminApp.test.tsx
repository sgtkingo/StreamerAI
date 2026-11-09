import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import type { AuthStatus, StreamerApi } from "../api/client";
import { AdminApp } from "./AdminApp";

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
  api.getBackupSchedule = vi
    .fn()
    .mockResolvedValue({
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
