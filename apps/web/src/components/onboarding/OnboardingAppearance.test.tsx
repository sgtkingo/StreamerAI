import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppearancePreferencesSchema,
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
  type ViewerProfile,
} from "@streamer-ai/contracts";
import type { ProfileDraft, StreamerApi } from "../../api/client";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider";
import { CHOOSER_APPEARANCE_STORAGE_KEY } from "../../theme/storage";
import { Onboarding } from "./Onboarding";

vi.mock("../../theme/AmbientBackground", () => ({
  AmbientBackground: () => null,
}));

function appearance() {
  return JSON.parse(screen.getByTestId("appearance").textContent ?? "null");
}

function chooserAppearance() {
  return JSON.parse(
    localStorage.getItem(CHOOSER_APPEARANCE_STORAGE_KEY) ?? "null",
  );
}

function ThemeProbe() {
  return (
    <output data-testid="appearance">
      {JSON.stringify(useTheme().appearance)}
    </output>
  );
}

function Flow({
  api,
  existingProfile,
  onComplete,
  onCancel,
}: {
  api: StreamerApi;
  existingProfile?: ViewerProfile;
  onComplete: (profile: ProfileDraft) => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <ThemeProvider
      api={api}
      profile={existingProfile ?? null}
      onProfileUpdated={vi.fn()}
    >
      {open && (
        <Onboarding
          api={api}
          existingProfile={existingProfile}
          onComplete={(saved) => {
            onComplete(saved);
            setOpen(false);
          }}
          onCancel={
            onCancel
              ? () => {
                  onCancel();
                  setOpen(false);
                }
              : undefined
          }
        />
      )}
      <ThemeProbe />
    </ThemeProvider>
  );
}

function createApi(completeSetup = vi.fn().mockResolvedValue(undefined)) {
  return {
    completeSetup,
    updateProfile: vi.fn(),
    getSetupStatus: vi.fn().mockResolvedValue({
      complete: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
      playback: false,
    }),
  } as unknown as StreamerApi;
}

afterEach(() => vi.restoreAllMocks());

describe("onboarding appearance", () => {
  it("accepts and confirms a PIN using the on-screen keypad", async () => {
    const api = createApi();
    api.setProfilePin = vi.fn().mockResolvedValue({ pinEnabled: true });
    const onComplete = vi.fn();
    render(<Flow api={api} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    fireEvent.click(screen.getByLabelText("Add a PIN to this profile"));
    expect(
      screen
        .getByLabelText("Choose a 4-digit PIN")
        .closest(".pin-pad")
        ?.querySelectorAll(".pin-pad__slot"),
    ).toHaveLength(4);
    for (const digit of ["1", "2", "3", "0"]) {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    expect(screen.getByLabelText("Confirm profile PIN")).toHaveValue("");
    for (const digit of ["1", "2", "3", "9"]) {
      fireEvent.click(screen.getByRole("button", { name: digit }));
    }
    expect(screen.getByText("The PINs do not match. Try again.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete last digit" }));
    fireEvent.click(screen.getByRole("button", { name: "0" }));
    expect(screen.getByText("PIN confirmed.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(api.setProfilePin).toHaveBeenCalledWith(
      "default",
      "1230",
      undefined,
    );
  });
  it("summarizes connected services and optionally saves a confirmed profile PIN", async () => {
    const api = createApi();
    api.setProfilePin = vi.fn().mockResolvedValue({ pinEnabled: true });
    api.getSetupStatus = vi.fn().mockResolvedValue({
      complete: false,
      tmdb: "connected",
      webshare: "connected",
      localAi: "not-configured",
      playback: true,
    });
    api.getIntegrations = vi.fn().mockResolvedValue({ items: [] });
    api.getAccount = vi.fn().mockResolvedValue({
      account: { id: "owner", name: "Owner", email: null },
      manageUrl: null,
      devices: [],
      sync: { configured: true, status: "idle" },
    });
    const onComplete = vi.fn();
    render(<Flow api={api} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    expect(await screen.findByText("TMDB, Webshare, Cloud Sync")).toBeVisible();
    expect(screen.queryByText("Movie metadata")).not.toBeInTheDocument();
    expect(screen.queryByText(/full-catalog indexing/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Add a PIN to this profile"));
    fireEvent.change(screen.getByLabelText("Choose a 4-digit PIN"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("Confirm profile PIN"), {
      target: { value: "1235" },
    });
    expect(
      screen.getByRole("button", { name: /Enter StreamerAI/ }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm profile PIN"), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(api.setProfilePin).toHaveBeenCalledWith(
      "default",
      "1234",
      undefined,
    );
  });

  it("retries setup after a PIN was saved without requiring it again", async () => {
    const completeSetup = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed"))
      .mockResolvedValueOnce(undefined);
    const api = createApi(completeSetup);
    api.setProfilePin = vi.fn().mockResolvedValue({ pinEnabled: true });
    const onComplete = vi.fn();
    render(<Flow api={api} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    fireEvent.click(screen.getByLabelText("Add a PIN to this profile"));
    fireEvent.change(screen.getByLabelText("Choose a 4-digit PIN"), {
      target: { value: "1234" },
    });
    fireEvent.change(screen.getByLabelText("Confirm profile PIN"), {
      target: { value: "1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    expect(await screen.findByRole("alert")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(api.setProfilePin).toHaveBeenCalledTimes(1);
  });

  it("preserves an existing profile PIN when onboarding is run again", async () => {
    const api = createApi();
    api.setProfilePin = vi.fn().mockResolvedValue({ pinEnabled: true });
    const existingProfile = ViewerProfileSchema.parse({
      id: "alex",
      name: "Alex",
      locale: "en",
      pinEnabled: true,
      onboardingComplete: true,
      genres: [],
      prompt: "",
      playback: DEFAULT_PLAYBACK_PREFERENCES,
    });
    const onComplete = vi.fn();
    render(
      <Flow
        api={api}
        existingProfile={existingProfile}
        onComplete={onComplete}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    expect(
      screen.queryByLabelText("Add a PIN to this profile"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(api.setProfilePin).not.toHaveBeenCalled();
  });

  it("previews the choice immediately and saves it only with successful setup completion", async () => {
    const previous = AppearancePreferencesSchema.parse({
      mode: "cinematic",
      ambientMotion: true,
    });
    const selected = AppearancePreferencesSchema.parse({
      mode: "autumn",
      ambientMotion: false,
      weatherOverride: "rain",
      daylightOverride: "night",
    });
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify(previous),
    );
    let finish!: () => void;
    const completeSetup = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const api = createApi(completeSetup);
    const onComplete = vi.fn();
    render(<Flow api={api} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
    expect(screen.getByLabelText("Theme")).toHaveValue("auto");
    expect(appearance()).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Alex" },
    });
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "autumn" },
    });
    fireEvent.change(screen.getByLabelText("Weather influence"), {
      target: { value: "rain" },
    });
    fireEvent.change(screen.getByLabelText("Lighting"), {
      target: { value: "night" },
    });
    fireEvent.click(screen.getByLabelText("Ambient motion"));
    expect(appearance()).toEqual(selected);
    expect(document.documentElement).toHaveAttribute("data-theme", "autumn");
    expect(chooserAppearance()).toEqual(previous);
    expect(api.updateProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() =>
      expect(completeSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "default",
          profile: expect.objectContaining({
            name: "Alex",
            appearance: selected,
          }),
        }),
      ),
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(chooserAppearance()).toEqual(previous);
    await act(async () => finish());
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        appearance: selected,
      }),
    );
    expect(appearance()).toEqual(selected);
    expect(chooserAppearance()).toEqual(appearance());
  });

  it("restores the saved profile theme when a setup rerun is cancelled", () => {
    const existingProfile = ViewerProfileSchema.parse({
      id: "alex",
      name: "Alex",
      locale: "en",
      onboardingComplete: true,
      genres: [],
      prompt: "",
      playback: DEFAULT_PLAYBACK_PREFERENCES,
      appearance: {
        mode: "cinematic",
        seasonalMode: "christmas",
        ambientMotion: false,
        weatherOverride: "snow",
        daylightOverride: "night",
      },
    });
    const api = createApi();
    const onCancel = vi.fn();
    render(
      <Flow
        api={api}
        existingProfile={existingProfile}
        onComplete={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
    expect(screen.getByLabelText("Theme")).toHaveValue("cinematic");
    expect(screen.getByLabelText("Ambient motion")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "christmas" },
    });
    fireEvent.change(screen.getByLabelText("Weather influence"), {
      target: { value: "fog" },
    });
    fireEvent.change(screen.getByLabelText("Lighting"), {
      target: { value: "day" },
    });
    expect(appearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "christmas",
        ambientMotion: false,
        weatherOverride: "fog",
        daylightOverride: "day",
      }),
    );
    expect(chooserAppearance()).toEqual(existingProfile.appearance);
    fireEvent.click(screen.getByRole("button", { name: "Exit setup" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(appearance()).toEqual(existingProfile.appearance);
    expect(document.documentElement).toHaveAttribute("data-theme", "cinematic");
    expect(api.completeSetup).not.toHaveBeenCalled();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });

  it("keeps a failed setup appearance preview without persisting it", async () => {
    const previous = AppearancePreferencesSchema.parse({
      mode: "cinematic",
      ambientMotion: true,
    });
    localStorage.setItem(
      CHOOSER_APPEARANCE_STORAGE_KEY,
      JSON.stringify(previous),
    );
    const api = createApi(
      vi.fn().mockRejectedValue(new Error("Setup is temporarily unavailable.")),
    );
    const onComplete = vi.fn();
    render(<Flow api={api} onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "spring" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish later" }));
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "please try again",
    );
    expect(appearance().mode).toBe("spring");
    expect(chooserAppearance()).toEqual(previous);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
