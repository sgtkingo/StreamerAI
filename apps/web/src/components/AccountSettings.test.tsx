import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AccountOverview, StreamerApi } from "../api/client";
import { AccountSettings } from "./AccountSettings";

const overview: AccountOverview = {
  account: { id: "a", name: "Alex", email: "alex@example.com" },
  manageUrl: "https://streamer-ai.example/account",
  devices: [
    {
      id: "tv",
      name: "Living room TV",
      lastSeenAt: "2026-11-01T10:00:00Z",
      expiresAt: "2026-12-01T10:00:00Z",
      current: false,
    },
  ],
  sync: { configured: true, status: "idle" },
};
const profile = ViewerProfileSchema.parse({
  id: "alex",
  name: "Alex",
  onboardingComplete: true,
  locale: "en",
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
});

describe("account management", () => {
  it("shows linked login methods, opens linking for the same owner and refreshes after returning from the portal", async () => {
    const getAccountConnections = vi.fn().mockResolvedValue({
      accountId: "a",
      connections: [
        {
          provider: "email",
          name: "StreamerAI e-mail",
          connected: true,
          available: true,
        },
        {
          provider: "google",
          name: "Google",
          connected: false,
          available: true,
        },
        {
          provider: "apple",
          name: "Apple",
          connected: false,
          available: false,
        },
      ],
    });
    const api = {
      getAccount: vi.fn().mockResolvedValue(overview),
      getAccountConnections,
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    const connect = await screen.findByRole("link", { name: "Connect Google" });
    expect(connect).toHaveAttribute(
      "href",
      overview.manageUrl + "#connections",
    );
    expect(screen.getByText("Coming later")).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Connect Apple" }),
    ).not.toBeInTheDocument();
    getAccountConnections.mockResolvedValue({
      accountId: "a",
      connections: [
        {
          provider: "google",
          name: "Google",
          connected: true,
          available: true,
        },
      ],
    });
    fireEvent(window, new Event("focus"));
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Connect Google" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Connected")).toBeVisible();
  });

  it("keeps the portal available when linked methods cannot be read", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue(overview),
      getAccountConnections: vi
        .fn()
        .mockRejectedValue(new Error("Temporarily offline")),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    expect(
      await screen.findByText(/Connected accounts cannot be checked right now/),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Manage connected accounts" }),
    ).toBeVisible();
  });
  it("shows the online account ID instead of the local household ID", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue({
        ...overview,
        account: {
          ...overview.account,
          id: "local-household",
          cloudLinked: true,
          cloudAccountId: "cloud-owner-123",
        },
      }),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    expect(await screen.findByText("cloud-owner-123")).toBeVisible();
    expect(screen.queryByText("local-household")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Cloud synchronization" }),
    ).not.toBeInTheDocument();
  });

  it("connects cloud services without creating a second household or signing out", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue({
        ...overview,
        account: { ...overview.account, cloudLinked: false },
        manageUrl: null,
      }),
      startDeviceAuthorization: vi.fn().mockResolvedValue({
        deviceCode: "grant",
        userCode: "ABCD-1234",
        verificationUri: "https://example.com/device",
        verificationUriComplete: "https://example.com/device",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        interval: 5,
      }),
      logout: vi.fn(),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect cloud" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Connect cloud services" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(api.startDeviceAuthorization).toHaveBeenCalledWith({
        adoptLocalAccount: true,
      }),
    );
    expect(api.logout).not.toHaveBeenCalled();
  });
  it("disconnects cloud while preserving the household session", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue({
        ...overview,
        account: { ...overview.account, cloudLinked: true },
      }),
      disconnectCloud: vi.fn().mockResolvedValue({ ok: true }),
      logout: vi.fn(),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect cloud" }),
    );
    await waitFor(() => expect(api.disconnectCloud).toHaveBeenCalledOnce());
    expect(api.logout).not.toHaveBeenCalled();
  });
  it("sends ownership management to the hosted portal and revokes devices", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue(overview),
      revokeAccountDevice: vi.fn().mockResolvedValue(undefined),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    const portal = await screen.findByRole("link", {
      name: "Open account portal",
    });
    expect(portal).toHaveAttribute("href", overview.manageUrl);
    expect(portal).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByLabelText("Transfer code")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(api.revokeAccountDevice).toHaveBeenCalledWith("tv"),
    );
    await waitFor(() =>
      expect(screen.queryByText("Living room TV")).not.toBeInTheDocument(),
    );
  });

  it("keeps local-only mode clear and hides unavailable cloud actions", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue({
        ...overview,
        manageUrl: null,
        devices: [],
        sync: { configured: false, status: "disabled" },
      }),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    expect(await screen.findByText(/This household is local/)).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open account portal" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
  });
});
