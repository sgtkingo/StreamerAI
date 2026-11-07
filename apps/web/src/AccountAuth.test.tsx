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
    onSignOut,
  }: {
    profile: { name: string; prompt: string };
    onSwitchAccount: () => void;
    onSignOut: () => Promise<void>;
  }) => (
    <main>
      <h1>{profile.name}'s cinema</h1>
      <p>{profile.prompt}</p>
      <button onClick={onSwitchAccount}>Switch profile</button>
      <button onClick={() => void onSignOut()}>Sign out</button>
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
  it("offers backup restore on Welcome in trusted-local mode", async () => {
    const api = makeApi({
      ...loggedIn,
      account: { ...account, cloudLinked: false },
      masterPinSetupRequired: true,
    });
    api.getInstallationStatus = vi.fn().mockResolvedValue({
      enabled: false,
      claimed: false,
      paired: false,
      role: null,
    });
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [
        {
          ...profile,
          id: "default",
          name: "Viewer",
          pinEnabled: false,
          onboardingComplete: false,
        },
      ],
      limit: 5,
    });
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/api/v1/installation/status")
          return Response.json({ enabled: false, role: null });
        if (path === "/api/v1/account/encrypted-household")
          return Response.json({ enabled: false, cloudConfigured: true });
        throw new Error("Unexpected recovery request");
      }),
    );
    render(<App api={api} />);
    const summary = await screen.findByText(
      "Restore an encrypted household instead of starting over",
    );
    const privacy = screen
      .getByText("Your viewing data stays at home.")
      .closest(".trust-note")!;
    expect(privacy.nextElementSibling).toBe(summary.closest("details"));
    fireEvent.click(summary);
    const input = await screen.findByLabelText("Master PIN for this backup");
    expect(input).toBeEnabled();
    const slots = input
      .closest(".digit-slots")!
      .querySelectorAll(".digit-slots__cell");
    expect(slots).toHaveLength(8);
    expect(slots[0]).toBeVisible();
  });

  it("places restore below the Welcome privacy block and uses the backup PIN without creating another", async () => {
    let restored = false;
    const bootstrap = {
      ...profile,
      id: "default",
      name: "Viewer",
      pinEnabled: false,
      onboardingComplete: false,
    };
    const recovered = {
      ...profile,
      id: "recovered",
      name: "Recovered viewer",
      pinEnabled: false,
    };
    const api = makeApi();
    api.getInstallationStatus = vi
      .fn()
      .mockResolvedValue({ enabled: true, paired: true, role: "owner" });
    vi.mocked(api.getAuthStatus!).mockImplementation(async () => ({
      ...loggedIn,
      account: { ...account, cloudLinked: false },
      masterPinSetupRequired: !restored,
    }));
    vi.mocked(api.getProfiles).mockImplementation(async () => ({
      items: [restored ? recovered : bootstrap],
      limit: 5,
    }));
    vi.mocked(api.getSetupStatus).mockImplementation(async () => ({
      complete: restored,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    }));
    api.setupMasterPin = vi.fn();
    const fetcher = vi.fn(async (path: string) => {
      if (path === "/api/v1/installation/status")
        return Response.json({ role: "owner" });
      if (path === "/api/v1/account/encrypted-household")
        return Response.json({ enabled: false, cloudConfigured: true });
      if (path.endsWith("/preview"))
        return Response.json({
          profiles: [{ name: "Recovered viewer" }],
          credentials: [],
          limitations: [],
        });
      if (path.endsWith("/restore")) {
        restored = true;
        return Response.json({});
      }
      throw new Error("Unexpected recovery request");
    });
    vi.stubGlobal("fetch", fetcher);
    render(<App api={api} />);
    const summary = await screen.findByText(
      "Restore an encrypted household instead of starting over",
    );
    const privacy = screen
      .getByText("Your viewing data stays at home.")
      .closest(".trust-note")!;
    expect(privacy.nextElementSibling).toBe(summary.closest("details"));
    expect(screen.getByRole("main")).toContainElement(summary);
    fireEvent.click(summary);
    const input = await screen.findByLabelText("Master PIN for this backup");
    expect(
      screen.queryByRole("button", { name: "Enable encrypted recovery" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save encrypted household file" }),
    ).not.toBeInTheDocument();
    const data = { format: "streamerai-master-pin-household", version: 1 };
    const file = new File([JSON.stringify(data)], "household.json");
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify(data),
    });
    fireEvent.change(screen.getByLabelText("Encrypted household file"), {
      target: { files: [file] },
    });
    fireEvent.change(input, { target: { value: "01234567" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Review contents" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review contents" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirm restore into empty household",
      }),
    );
    await screen.findByRole("button", { name: /Recovered viewer/ });
    expect(api.setupMasterPin).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/account/encrypted-household/restore",
      expect.objectContaining({
        body: JSON.stringify({
          envelope: data,
          recoveryKey: "01234567",
          confirm: "restore-into-empty-household",
        }),
      }),
    );
    expect(
      fetcher.mock.calls.some(
        ([path]) =>
          path.endsWith("/activate") || path.endsWith("/rotate-recovery"),
      ),
    ).toBe(false);
  });
  it("asks for a new Master PIN only after Start setup", async () => {
    const api = makeApi({
      ...loggedIn,
      account: { ...account, cloudLinked: false },
      masterPinSetupRequired: true,
    });
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [
        {
          ...profile,
          id: "default",
          name: "Viewer",
          pinEnabled: false,
          onboardingComplete: false,
        },
      ],
      limit: 5,
    });
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    });
    api.setupMasterPin = vi.fn().mockResolvedValue({ ok: true });
    render(<App api={api} />);
    await screen.findByText("Your viewing data stays at home.");
    expect(
      screen.queryByLabelText("Master PIN (8 digits)"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
    fireEvent.change(screen.getByLabelText("Master PIN (8 digits)"), {
      target: { value: "01234567" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Master PIN"), {
      target: { value: "01234567" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Master PIN" }));
    await waitFor(() =>
      expect(api.setupMasterPin).toHaveBeenCalledWith("01234567", "01234567"),
    );
    await screen.findByLabelText(/Display name/);
  });
  it("leaves local setup and starts ordinary pairing after signing out of the local session", async () => {
    const localStatus: AuthStatus = {
      ...loggedIn,
      account: {
        id: "local",
        name: "Household",
        email: null,
        cloudLinked: false,
      },
    };
    const api = makeApi(localStatus);
    vi.mocked(api.getAuthStatus!)
      .mockResolvedValueOnce(localStatus)
      .mockResolvedValue({
        ...localStatus,
        authenticated: false,
        account: null,
      });
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    });
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [{ ...profile, pinEnabled: false, onboardingComplete: false }],
      limit: 5,
    });
    api.startDeviceAuthorization = vi.fn().mockResolvedValue({
      deviceCode: "private",
      userCode: "ABCD-1234",
      verificationUri: "https://example.com/device",
      verificationUriComplete: "https://example.com/device?code=ABCD-1234",
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      interval: 5,
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect this device" }),
    );
    expect(
      await screen.findByLabelText("Pairing code ABCD-1234"),
    ).toBeVisible();
    expect(api.logout).toHaveBeenCalledOnce();
    expect(api.startDeviceAuthorization).toHaveBeenCalledWith(undefined);
    expect(
      screen.queryByRole("dialog", { name: "Sign in to StreamerAI" }),
    ).not.toBeInTheDocument();
  });

  it("keeps local setup available if ending the session fails", async () => {
    const api = makeApi({
      ...loggedIn,
      account: {
        id: "local",
        name: "Household",
        email: null,
        cloudLinked: false,
      },
    });
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      playback: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
    });
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [{ ...profile, pinEnabled: false, onboardingComplete: false }],
      limit: 5,
    });
    vi.mocked(api.logout!).mockRejectedValue(new Error("offline"));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not return to sign in.",
    );
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
    expect(
      screen.queryByRole("heading", { name: "Welcome to StreamerAI." }),
    ).not.toBeInTheDocument();
  });

  it("shows sign-in before reading profiles or setup for an unauthenticated account", async () => {
    const api = makeApi({ ...loggedIn, authenticated: false, account: null });
    render(<App api={api} />);
    expect(
      await screen.findByRole("heading", { name: "Welcome to StreamerAI." }),
    ).toBeVisible();
    expect(api.getProfiles).not.toHaveBeenCalled();
    expect(api.getSetupStatus).not.toHaveBeenCalled();
  });

  it("keeps the login gate closed when the auth check fails", async () => {
    const api = makeApi();
    vi.mocked(api.getAuthStatus!)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ...loggedIn, authenticated: false, account: null });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Welcome to StreamerAI." });
    expect(api.getSetupStatus).not.toHaveBeenCalled();
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

  it("clears account access on actual sign-out", async () => {
    const api = makeApi();
    vi.mocked(api.getProfiles).mockResolvedValue({
      items: [{ ...profile, pinEnabled: false }],
      limit: 5,
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "A Alex" }));
    await screen.findByRole("heading", { name: "Alex's cinema" });
    vi.mocked(api.getAuthStatus!).mockResolvedValue({
      ...loggedIn,
      authenticated: false,
      account: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Welcome to StreamerAI." });
    expect(api.logout).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("heading", { name: "Alex's cinema" }),
    ).not.toBeInTheDocument();
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
      screen.queryByRole("heading", { name: "Welcome to StreamerAI." }),
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
      screen.getAllByRole("button", { name: /add profile/i }).length,
    ).toBeGreaterThan(0);
  });
});
