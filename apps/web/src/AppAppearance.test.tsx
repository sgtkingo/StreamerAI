import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  AppearancePreferencesSchema,
  DEFAULT_PLAYBACK_PREFERENCES,
  ViewerProfileSchema,
  mergeAppearancePreferences,
  type UpdateViewerProfile,
  type ViewerProfile,
} from "@streamer-ai/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StreamerApi } from "./api/client";
import { CHOOSER_APPEARANCE_STORAGE_KEY } from "./theme/storage";

vi.mock("./theme/AmbientBackground", () => ({ AmbientBackground: () => null }));
vi.mock("./components/IntegrationManager", () => ({
  IntegrationManager: () => null,
}));
vi.mock("./components/AgentBackendSettings", () => ({
  AgentBackendSettings: () => null,
}));

const original = ViewerProfileSchema.parse({
  id: "alex",
  name: "Alex",
  onboardingComplete: true,
  locale: "en",
  genres: [],
  prompt: "",
  playback: DEFAULT_PLAYBACK_PREFERENCES,
  appearance: {
    mode: "cinematic",
    seasonalMode: "winter",
    ambientMotion: false,
  },
});

function createApi(): StreamerApi {
  return {
    getSetupStatus: vi.fn().mockResolvedValue({
      complete: true,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
      playback: false,
    }),
    getProfiles: vi.fn().mockResolvedValue({ items: [original], limit: 5 }),
    getOfflineDownloads: vi.fn().mockResolvedValue({ items: [] }),
    getHome: vi.fn().mockResolvedValue({
      profileId: "alex",
      mode: "preview",
      generatedAt: new Date().toISOString(),
      sections: [],
    }),
    getAgentSelection: vi.fn().mockResolvedValue({
      mode: "disabled",
      provider: "ollama",
      available: false,
      code: "DISABLED",
      message: "No agent selected.",
    }),
    completeSetup: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn(),
  } as unknown as StreamerApi;
}

function topbarTheme() {
  return within(screen.getByRole("banner")).getByLabelText("Theme");
}

function chooserAppearance() {
  return JSON.parse(
    localStorage.getItem(CHOOSER_APPEARANCE_STORAGE_KEY) ?? "null",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("application appearance synchronization", () => {
  it("keeps a new topbar theme when an older profile detail save replies late", async () => {
    window.history.replaceState({}, "", "/preferences");
    const api = createApi();
    let finishDetails!: (profile: ViewerProfile) => void;
    const details = new Promise<ViewerProfile>((resolve) => {
      finishDetails = resolve;
    });
    vi.mocked(api.updateProfile).mockImplementation(
      async (_id, patch: UpdateViewerProfile) => {
        if (patch.appearance) {
          return {
            ...original,
            appearance: mergeAppearancePreferences(
              original.appearance,
              patch.appearance,
            ),
          };
        }
        return details;
      },
    );
    render(<App api={api} />);
    const alex = await screen.findByRole("button", { name: /Alex/ });
    expect(
      within(screen.getByLabelText("Theme")).getAllByRole("option"),
    ).toHaveLength(2);
    fireEvent.click(alex);
    expect(within(topbarTheme()).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Your taste prompt"), {
      target: { value: "Rich dialogue." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(1));
    fireEvent.change(topbarTheme(), { target: { value: "auto" } });
    await waitFor(() => expect(api.updateProfile).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(chooserAppearance()).toEqual(
        AppearancePreferencesSchema.parse({
          mode: "winter",
          ambientMotion: false,
        }),
      ),
    );
    await act(async () =>
      finishDetails({ ...original, prompt: "Rich dialogue." }),
    );
    expect(topbarTheme()).toHaveValue("auto");
    expect(document.documentElement).toHaveAttribute("data-theme", "winter");
    expect(chooserAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "winter",
        ambientMotion: false,
      }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Profile menu for Alex" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Log out / Switch profile" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Alex/ }));
    expect(topbarTheme()).toHaveValue("auto");
    fireEvent.click(
      screen.getByRole("button", { name: "Profile menu for Alex" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Preferences" }));
    expect(screen.getByLabelText("Your taste prompt")).toHaveValue(
      "Rich dialogue.",
    );
  });

  it("keeps a successful onboarding rerun theme when profile refresh fails", async () => {
    window.history.replaceState({}, "", "/settings");
    const api = createApi();
    vi.mocked(api.getProfiles)
      .mockResolvedValueOnce({ items: [original], limit: 5 })
      .mockRejectedValue(new Error("Profile refresh unavailable."));
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /Alex/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Run onboarding again" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Start setup/ }));
    fireEvent.change(screen.getByLabelText("Theme"), {
      target: { value: "christmas" },
    });
    for (let step = 0; step < 3; step += 1) {
      fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
    }
    fireEvent.click(screen.getByRole("button", { name: /Enter StreamerAI/ }));
    await waitFor(() =>
      expect(api.completeSetup).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "alex",
          profile: expect.objectContaining({
            appearance: AppearancePreferencesSchema.parse({
              mode: "christmas",
              ambientMotion: false,
            }),
          }),
        }),
      ),
    );
    await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    expect(topbarTheme()).toHaveValue("auto");
    expect(document.documentElement).toHaveAttribute("data-theme", "christmas");
    expect(chooserAppearance()).toEqual(
      AppearancePreferencesSchema.parse({
        mode: "christmas",
        ambientMotion: false,
      }),
    );
  });
});
