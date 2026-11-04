import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
} from "@streamer-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { ProfilePinDialog, ProfilePinSettings } from "./ProfilePin";

const profile = ViewerProfileSchema.parse({
  id: "alex",
  name: "Alex",
  pinEnabled: true,
  onboardingComplete: true,
  locale: "en",
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
});

afterEach(() => vi.useRealTimers());

describe("profile PIN controls", () => {
  it("unlocks automatically after four keypad digits, without an enter button", async () => {
    const unlocked = vi.fn();
    const api = {
      unlockProfile: vi.fn().mockResolvedValue(undefined),
    } as unknown as StreamerApi;
    render(
      <ProfilePinDialog
        api={api}
        profile={profile}
        onUnlocked={unlocked}
        onCancel={vi.fn()}
      />,
    );
    for (const digit of ["1", "2", "3", "4"])
      fireEvent.click(screen.getByRole("button", { name: digit }));
    await waitFor(() => expect(unlocked).toHaveBeenCalledOnce());
    expect(api.unlockProfile).toHaveBeenCalledWith("alex", "1234");
    expect(
      screen.queryByRole("button", { name: "Unlock profile" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the profile locked after rejection and clears the entered PIN", async () => {
    const unlocked = vi.fn();
    const api = {
      unlockProfile: vi.fn().mockRejectedValue(new Error("rejected")),
    } as unknown as StreamerApi;
    render(
      <ProfilePinDialog
        api={api}
        profile={profile}
        onUnlocked={unlocked}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Profile PIN"), {
      target: { value: "9876" },
    });
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(unlocked).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Profile PIN")).toHaveValue("");
    expect(screen.getByLabelText("Profile PIN")).toHaveFocus();
  });

  it("requires matching PINs and updates only after a successful server response", async () => {
    const updated = vi.fn();
    const api = {
      setProfilePin: vi.fn().mockResolvedValue({ pinEnabled: true }),
    } as unknown as StreamerApi;
    render(
      <ProfilePinSettings
        api={api}
        profile={profile}
        onProfileUpdated={updated}
      />,
    );
    fireEvent.change(screen.getByLabelText("Current PIN"), {
      target: { value: "9876" },
    });
    fireEvent.change(screen.getByLabelText("New PIN (4 digits)"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new PIN"), {
      target: { value: "1235" },
    });
    expect(screen.getByRole("button", { name: "Save PIN" })).toBeDisabled();
    expect(api.setProfilePin).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm new PIN"), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save PIN" }));
    await waitFor(() =>
      expect(updated).toHaveBeenCalledWith({ ...profile, pinEnabled: true }),
    );
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", "1234", "9876");
    expect(screen.getByLabelText("New PIN (4 digits)")).toHaveValue("");
    expect(screen.getByRole("status")).toHaveTextContent("Profile PIN saved.");
  });

  it("removes a PIN through the account-owner endpoint", async () => {
    const updated = vi.fn();
    const api = {
      setProfilePin: vi.fn().mockResolvedValue({ pinEnabled: false }),
    } as unknown as StreamerApi;
    render(
      <ProfilePinSettings
        api={api}
        profile={profile}
        onProfileUpdated={updated}
      />,
    );
    expect(screen.getByRole("button", { name: "Remove PIN" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Current PIN"), {
      target: { value: "9876" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove PIN" }));
    await waitFor(() =>
      expect(updated).toHaveBeenCalledWith({ ...profile, pinEnabled: false }),
    );
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null, "9876");
  });

  it("requires a Google ownership confirmation before recovering a forgotten PIN", async () => {
    vi.useFakeTimers();
    const unlocked = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({
        enabled: true,
        authenticated: true,
        cloudConfigured: true,
      }),
      startDeviceAuthorization: vi.fn().mockResolvedValue({
        deviceCode: "reset-grant",
        userCode: "ABCD-1234",
        verificationUri: "https://example.com/device",
        verificationUriComplete: "https://example.com/device?code=ABCD-1234",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        interval: 5,
      }),
      pollDeviceAuthorization: vi
        .fn()
        .mockResolvedValue({ status: "approved" }),
      setProfilePin: vi.fn().mockResolvedValue({ pinEnabled: false }),
    } as unknown as StreamerApi;
    render(
      <ProfilePinDialog
        api={api}
        profile={{ ...profile, accountId: "local" }}
        onUnlocked={unlocked}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Forgot PIN? Verify account" }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Verify account" })),
    );
    expect(api.startDeviceAuthorization).toHaveBeenCalledWith({
      purpose: "pin-reset",
      profileId: "alex",
    });
    expect(api.setProfilePin).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null);
    expect(unlocked).toHaveBeenCalledOnce();
  });
});
