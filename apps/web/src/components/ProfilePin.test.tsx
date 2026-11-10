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
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN?" }));
    const master = screen.getByLabelText("Master PIN");
    expect(master).toHaveValue("");
    expect(
      master.closest(".pin-pad")?.querySelectorAll(".pin-pad__slot"),
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
    expect(screen.getByLabelText("Current profile PIN")).toHaveValue("");
  });

  it("asks the local owner to reset the profile PIN before opening the profile", async () => {
    vi.useFakeTimers();
    const unlocked = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({
        enabled: true,
        authenticated: true,
        cloudConfigured: true,
        ownerResetAvailable: true,
        masterPinEnabled: true,
      }),
      startDeviceAuthorization: vi.fn(),
      requestProfilePinReset: vi.fn().mockResolvedValue({
        id: "reset-request",
        manageUrl: "http://localhost/admin?tab=profiles",
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
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN?" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Ask household owner for PIN reset",
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.requestProfilePinReset).toHaveBeenCalledWith("alex", "reset");
    expect(api.startDeviceAuthorization).not.toHaveBeenCalled();
    expect(
      screen.getByRole("link", { name: "Open household administration" }),
    ).toHaveAttribute("href", "http://localhost/admin?tab=profiles");
    expect(api.setProfilePin).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null);
    expect(unlocked).toHaveBeenCalledOnce();
  });
  it("does not remove the PIN or unlock the profile when the owner denies the request", async () => {
    vi.useFakeTimers();
    const unlocked = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({ ownerResetAvailable: true }),
      requestProfilePinReset: vi
        .fn()
        .mockResolvedValue({
          id: "denied",
          manageUrl: "/admin",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        }),
      pollProfilePinReset: vi.fn().mockResolvedValue({ status: "denied" }),
      setProfilePin: vi.fn(),
    } as unknown as StreamerApi;
    render(
      <ProfilePinDialog
        api={api}
        profile={profile}
        onUnlocked={unlocked}
        onCancel={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN?" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Ask household owner for PIN reset" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText("This request was declined.")).toBeVisible();
    expect(api.setProfilePin).not.toHaveBeenCalled();
    expect(unlocked).not.toHaveBeenCalled();
  });
  it("resets the PIN from profile settings after owner approval", async () => {
    vi.useFakeTimers();
    const updated = vi.fn();
    const api = {
      getAuthStatus: vi.fn().mockResolvedValue({ ownerResetAvailable: true }),
      requestProfilePinReset: vi.fn().mockResolvedValue({
        id: "reset-request",
        manageUrl: "/admin?tab=profiles",
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      }),
      pollProfilePinReset: vi.fn().mockResolvedValue({ status: "approved" }),
      setProfilePin: vi.fn().mockResolvedValue({ pinEnabled: false }),
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
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Forgot PIN?" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Ask household owner for PIN reset" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.requestProfilePinReset).toHaveBeenCalledWith("alex", "reset");
    expect(api.setProfilePin).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(api.setProfilePin).toHaveBeenCalledWith("alex", null);
    expect(updated).toHaveBeenCalledWith({ ...profile, pinEnabled: false });
  });
  it("offers the profile PIN first and the Master PIN after Forgot PIN", async () => {
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
    expect(screen.getByLabelText("Profile PIN")).toHaveAttribute(
      "maxlength",
      "4",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Forgot PIN?" }));
    const input = screen.getByLabelText("Master PIN");
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
  it("explains how to ask the household owner when reset requests are unavailable", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Forgot PIN?" }));
    expect(
      screen.queryByRole("button", {
        name: "Ask household owner for PIN reset",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByLabelText("Profile PIN")).toHaveAttribute(
      "maxlength",
      "4",
    );
    expect(api.requestProfilePinReset).not.toHaveBeenCalled();
  });
});
