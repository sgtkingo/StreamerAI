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
import { ToastProvider } from "./ToastProvider";

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
    expect(
      screen
        .getByLabelText("Profile PIN")
        .closest(".pin-pad")
        ?.querySelectorAll(".pin-pad__slot"),
    ).toHaveLength(4);
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
      <ToastProvider>
        <ProfilePinSettings
          api={api}
          profile={profile}
          onProfileUpdated={updated}
        />
      </ToastProvider>,
    );
    for (const label of [
      "Current profile PIN",
      "New PIN (4 digits)",
      "Confirm new PIN",
    ]) {
      expect(
        screen
          .getByLabelText(label)
          .closest(".digit-slots")
          ?.querySelectorAll(".digit-slots__cell"),
      ).toHaveLength(4);
    }
    fireEvent.change(screen.getByLabelText("Current profile PIN"), {
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "Profile PIN changed.",
    );
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
    fireEvent.change(screen.getByLabelText("Current profile PIN"), {
      target: { value: "9876" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove PIN" }));
    await waitFor(() =>
      expect(updated).toHaveBeenCalledWith({ ...profile, pinEnabled: false }),
    );
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null, "9876");
  });

  it("uses eight slots for Master PIN authorization when changing a profile PIN", async () => {
    const api = {
      setProfilePin: vi.fn().mockResolvedValue({ pinEnabled: true }),
    } as unknown as StreamerApi;
    render(
      <ToastProvider>
        <ProfilePinSettings
          api={api}
          profile={profile}
          onProfileUpdated={vi.fn()}
        />
      </ToastProvider>,
    );
    fireEvent.change(screen.getByLabelText("Current profile PIN"), {
      target: { value: "9876" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Use Master PIN instead" }),
    );
    const master = screen.getByLabelText("Master PIN");
    expect(master).toHaveValue("");
    expect(
      master.closest(".digit-slots")?.querySelectorAll(".digit-slots__cell"),
    ).toHaveLength(8);
    fireEvent.change(master, { target: { value: "01234567" } });
    fireEvent.change(screen.getByLabelText("New PIN (4 digits)"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new PIN"), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save PIN" }));
    await waitFor(() =>
      expect(api.setProfilePin).toHaveBeenCalledWith(
        "alex",
        "1234",
        "01234567",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Use profile PIN instead" }),
    );
    expect(screen.getByLabelText("Current profile PIN")).toHaveValue("");
  });

  it("sends a reset request to the signed-in account without pairing", async () => {
    vi.useFakeTimers();
    const unlocked = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({
        enabled: true,
        authenticated: true,
        cloudConfigured: true,
        ownerResetAvailable: true,
      }),
      startDeviceAuthorization: vi.fn(),
      requestProfilePinReset: vi.fn().mockResolvedValue({
        id: "reset-request",
        manageUrl: "https://example.com/account",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
      pollProfilePinReset: vi.fn().mockResolvedValue({ status: "approved" }),
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
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.requestProfilePinReset).toHaveBeenCalledWith("alex");
    expect(api.startDeviceAuthorization).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "Open account portal" }),
    ).toHaveAttribute("href", "https://example.com/account");
    expect(api.setProfilePin).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null);
    expect(unlocked).toHaveBeenCalledOnce();
  });
  it("offers the Master PIN by default and unlocks after eight digits", async () => {
    const unlocked = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({
        masterPinEnabled: true,
        ownerResetAvailable: false,
      }),
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
    const input = await screen.findByLabelText("Master PIN");
    expect(input).toHaveAttribute("maxlength", "8");
    expect(
      input.closest(".pin-pad")?.querySelectorAll(".pin-pad__slot"),
    ).toHaveLength(8);
    fireEvent.change(input, { target: { value: "1234" } });
    expect(api.unlockProfile).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "12345678" } });
    await waitFor(() => expect(unlocked).toHaveBeenCalledOnce());
    expect(api.unlockProfile).toHaveBeenCalledWith("alex", "12345678");
  });
  it("hides account recovery without sync and explains why it is unavailable", async () => {
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({
        masterPinEnabled: true,
        ownerResetAvailable: false,
      }),
      requestProfilePinReset: vi.fn(),
    } as unknown as StreamerApi;
    render(
      <ProfilePinDialog
        api={api}
        profile={profile}
        onUnlocked={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await screen.findByLabelText("Master PIN");
    expect(
      screen.queryByRole("button", { name: "Forgot PIN? Verify account" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/cannot be reset without an online account/),
    ).toHaveClass("settings-note");
    fireEvent.click(
      screen.getByRole("button", { name: "Use profile PIN instead" }),
    );
    expect(screen.getByLabelText("Profile PIN")).toHaveAttribute(
      "maxlength",
      "4",
    );
    expect(api.requestProfilePinReset).not.toHaveBeenCalled();
  });
});
