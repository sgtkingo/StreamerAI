import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { AuthStatus, StreamerApi } from "./api/client";

vi.mock("./theme/AmbientBackground", () => ({ AmbientBackground: () => null }));
vi.mock("./components/AppShell", () => ({
  AppShell: ({
    profile,
    onSwitchAccount,
  }: {
    profile: { name: string; prompt: string };
    onSwitchAccount: () => void;
  }) => (
    <main>
      <h1>{profile.name}'s cinema</h1>
      <p>{profile.prompt}</p>
      <button onClick={onSwitchAccount}>Switch profile</button>
    </main>
  ),
}));

const account = { id: "account-a", name: "Alex", email: "alex@example.com" };
const loggedIn: AuthStatus = {
  enabled: true,
  authenticated: true,
  cloudConfigured: true,
  account,
};
const profile = ViewerProfileSchema.parse({
  id: "alex",
  name: "Alex",
  onboardingComplete: true,
  locale: "en",
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
  pinEnabled: true,
  accountId: account.id,
});

function makeApi(status: AuthStatus = loggedIn) {
  return {
    getAuthStatus: vi.fn().mockResolvedValue(status),
    getSetupStatus: vi
      .fn()
      .mockResolvedValue({ complete: true, playback: false }),
    getProfiles: vi.fn().mockResolvedValue({ items: [profile], limit: 5 }),
    getOfflineDownloads: vi.fn().mockResolvedValue({ items: [] }),
    unlockProfile: vi.fn().mockResolvedValue(undefined),
    lockProfile: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
  } as unknown as StreamerApi;
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("account access and profile PIN", () => {
  it("sends an unfinished household to administration without cloud or account choices", async () => {
    const api = makeApi({
      ...loggedIn,
      authenticated: false,
      householdReady: false,
      account: null,
    });
    api.startDeviceAuthorization = vi.fn();
    render(<App api={api} />);
    expect(
      await screen.findByRole("link", {
        name: "Open household administration",
      }),
    ).toHaveAttribute("href", "/admin");
    expect(api.startDeviceAuthorization).not.toHaveBeenCalled();
    expect(api.getProfiles).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Sign in to cloud" }),
    ).not.toBeInTheDocument();
  });
  it("offers local server pairing before reading household data", async () => {
    const api = makeApi();
    api.getInstallationStatus = vi.fn().mockResolvedValue({
      enabled: true,
      claimed: true,
      paired: false,
      role: null,
    });
    render(<App api={api} />);
    expect(
      await screen.findByRole("button", { name: "Show pairing code" }),
    ).toBeVisible();
    expect(api.getAuthStatus).not.toHaveBeenCalled();
    expect(api.getProfiles).not.toHaveBeenCalled();
  });
  it("keeps playback closed when the server status check fails", async () => {
    const api = makeApi();
    vi.mocked(api.getAuthStatus!).mockRejectedValue(new Error("offline"));
    render(<App api={api} />);
    expect(
      await screen.findByRole("heading", { name: "Home server unavailable" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(api.getProfiles).not.toHaveBeenCalled();
  });
  it("opens a protected profile only after server PIN approval and locks it on switching", async () => {
    const api = makeApi();
    vi.mocked(api.getProfiles)
      .mockResolvedValueOnce({ items: [profile], limit: 5 })
      .mockResolvedValue({
        items: [{ ...profile, prompt: "Enjoy mysteries." }],
        limit: 5,
      });
    let approve!: () => void;
    vi.mocked(api.unlockProfile!).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    render(<App api={api} />);
    fireEvent.click(
      await screen.findByRole("button", { name: /Alex.*PIN protected/ }),
    );
    fireEvent.change(screen.getByLabelText("Profile PIN"), {
      target: { value: "1234" },
    });
    expect(api.unlockProfile).toHaveBeenCalledWith("alex", "1234");
    expect(
      screen.queryByRole("heading", { name: "Alex's cinema" }),
    ).not.toBeInTheDocument();
    approve();
    await screen.findByRole("heading", { name: "Alex's cinema" });
    expect(screen.getByText("Enjoy mysteries.")).toBeVisible();
    expect(api.getProfiles).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Switch profile" }));
    await screen.findByRole("heading", { name: "Who's watching?" });
    expect(api.lockProfile).toHaveBeenCalledWith("alex");
    expect(api.logout).not.toHaveBeenCalled();
    expect(localStorage.getItem("pin")).toBeNull();
  });

  it("retains local operation when cloud authentication is disabled", async () => {
    const api = makeApi({
      ...loggedIn,
      enabled: false,
      cloudConfigured: false,
    });
    render(<App api={api} />);
    expect(
      await screen.findByRole("heading", { name: "Who's watching?" }),
    ).toBeVisible();
    await waitFor(() => expect(api.getProfiles).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "Set up your household" }),
    ).not.toBeInTheDocument();
  });

  it("uses the account's actual profile ID for initial cloud onboarding", async () => {
    const api = makeApi();
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    });
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [
        {
          ...profile,
          id: "profile-cloud-new",
          onboardingComplete: false,
          pinEnabled: false,
        },
      ],
      limit: 5,
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: /your cinema/i });
    await waitFor(() =>
      expect(api.getSetupStatus).toHaveBeenCalledWith("profile-cloud-new"),
    );
    expect(api.getSetupStatus).not.toHaveBeenCalledWith("default");
  });

  it("shows an empty account's chooser without reading another account's default setup", async () => {
    const api = makeApi();
    vi.mocked(api.getProfiles).mockResolvedValue({ items: [], limit: 5 });
    vi.mocked(api.getSetupStatus).mockRejectedValue(
      new Error("Profile not found"),
    );
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Who's watching?" });
    expect(api.getSetupStatus).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /add profile/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open household administration" }),
    ).toHaveAttribute("href", "/admin");
  });
});
