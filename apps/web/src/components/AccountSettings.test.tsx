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
  it("does not show or fetch connected accounts in local administration", async () => {
    const getAccountConnections = vi.fn();
    const api = {
      getAccount: vi.fn().mockResolvedValue(overview),
      getAccountConnections,
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    expect(
      await screen.findByRole("link", { name: "Open account portal" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Connected accounts" }),
    ).not.toBeInTheDocument();
    expect(getAccountConnections).not.toHaveBeenCalled();
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
  it("sends ownership management to the hosted portal without showing devices", async () => {
    const api = {
      getAccount: vi.fn().mockResolvedValue(overview),
    } as unknown as StreamerApi;
    render(<AccountSettings api={api} profile={profile} />);
    const portal = await screen.findByRole("link", {
      name: "Open account portal",
    });
    expect(portal).toHaveAttribute("href", overview.manageUrl);
    expect(portal).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByLabelText("Transfer code")).not.toBeInTheDocument();
    expect(screen.queryByText("Living room TV")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Connected devices" }),
    ).not.toBeInTheDocument();
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
    expect(
      await screen.findByRole("heading", { name: "Cloud management" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open account portal" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync now" }),
    ).not.toBeInTheDocument();
  });
});
