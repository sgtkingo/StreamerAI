import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { StreamerApi } from "./api/client";
import { DEFAULT_PLAYBACK_PREFERENCES } from "./playback-preferences";

function createApi(): StreamerApi {
  return {
    getSetupStatus: vi.fn().mockResolvedValue({
      complete: true,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
      playback: false,
    }),
    connectTmdb: vi.fn().mockResolvedValue({
      ok: true,
      integrationId: "tmdb",
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "secure-local",
    }),
    connectWebshare: vi.fn().mockResolvedValue({
      ok: true,
      integrationId: "webshare",
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "secure-local",
    }),
    detectLocalAi: vi.fn().mockResolvedValue({
      ok: true,
      message: "Ready",
      runtime: "Ollama",
      model: "qwen3.5:4b",
    }),
    getInferenceResidency: vi.fn().mockResolvedValue({
      state: "loaded",
      checkedAt: "2026-09-27T12:00:00.000Z",
    }),
    completeSetup: vi.fn().mockResolvedValue(undefined),
    getProfiles: vi.fn().mockResolvedValue({
      items: [
        {
          id: "default",
          name: "Alex",
          onboardingComplete: true,
          locale: "en",
          genres: ["Sci-fi"],
          prompt: "",
          playback: DEFAULT_PLAYBACK_PREFERENCES,
        },
      ],
      limit: 5,
    }),
    createProfile: vi.fn().mockResolvedValue({
      id: "profile-2",
      name: "Guest",
      onboardingComplete: false,
      locale: "en",
      genres: [],
      prompt: "",
      playback: DEFAULT_PLAYBACK_PREFERENCES,
    }),
    deleteProfile: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockImplementation(async (_profileId, patch) => ({
      id: "default",
      name: "Alex",
      onboardingComplete: true,
      locale: "en",
      genres: ["Sci-fi"],
      prompt: "",
      playback: DEFAULT_PLAYBACK_PREFERENCES,
      ...patch,
    })),
    getHome: vi.fn().mockResolvedValue({
      profileId: "default",
      mode: "preview",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    }),
    getTitleDetail: vi.fn().mockImplementation(async (_profileId, titleId) => ({
      title: { id: titleId },
      series: null,
      related: [],
    })),
    forceTitleSearch: vi.fn().mockResolvedValue({ detail: null, foundSources: 0 }),
    forceEpisodeSearch: vi.fn().mockResolvedValue({ detail: null, sources: [] }),
    discover: vi.fn().mockResolvedValue({
      sessionId: "session-1",
      mode: "preview",
      stage: "completed",
      reply: "Ready",
      bestMatch: null,
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    }),
    cancelDiscovery: vi.fn().mockResolvedValue(undefined),
    getLibrary: vi.fn().mockResolvedValue({ profileId: "default", items: [] }),
    addToLibrary: vi
      .fn()
      .mockResolvedValue({ profileId: "default", items: [] }),
    removeFromLibrary: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ profileId: "default", items: [] }),
    removeHistoryEvent: vi.fn().mockResolvedValue(undefined),
    clearHistory: vi.fn().mockResolvedValue(undefined),
    startPlayback: vi.fn().mockResolvedValue({
      ok: true,
      eventId: "event-1",
      library: { profileId: "default", items: [] },
      playback: {
        grantId: "grant-1",
        titleId: "sai:title:lake-house",
        providerId: "test-media",
        variantId: "variant-1",
        url: "https://media.example/stream",
        supportsHttpRange: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        embeddedSubtitles: [],
      },
    }),
    preparePlayback: vi.fn().mockResolvedValue({
      ok: true,
      playback: {
        grantId: "grant-1",
        titleId: "sai:title:lake-house",
        providerId: "test-media",
        variantId: "variant-1",
        url: "/api/v1/playback/grants/grant-1",
        supportsHttpRange: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        embeddedSubtitles: [],
      },
    }),
    checkPlayback: vi.fn().mockResolvedValue({ ok: true }),
    getPlaybackManifest: vi.fn().mockResolvedValue({
      durationSeconds: 120,
      videoCodec: "h264",
      videoPixelFormat: "yuv420p",
      audioTracks: [],
      subtitleTracks: [],
    }),
    closePlayback: vi.fn().mockResolvedValue(undefined),
    savePlaybackProgress: vi.fn().mockResolvedValue(undefined),
  };
}

describe("onboarding", () => {
  it("opens setup directly for the first viewer", async () => {
    const api = createApi();
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: false,
      tmdb: "not-configured",
      webshare: "not-configured",
      localAi: "not-configured",
      playback: false,
    });
    render(<App api={api} />);
    expect(
      await screen.findByRole("heading", { name: /your cinema/i }),
    ).toBeInTheDocument();
    expect(api.getProfiles).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: /who's watching/i }),
    ).not.toBeInTheDocument();
  });

  it("opens setup if a completed installation has no viewer profiles", async () => {
    const api = createApi();
    vi.mocked(api.getProfiles).mockResolvedValue({ items: [], limit: 5 });
    render(<App api={api} />);
    expect(
      await screen.findByRole("heading", { name: /your cinema/i }),
    ).toBeInTheDocument();
  });

  it("guides a viewer through all five steps and opens the library", async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} forceOnboarding />);

    expect(
      screen.getByRole("heading", { name: /your cinema/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /start setup/i }));

    await user.type(screen.getByLabelText(/display name/i), "Alex");
    await user.click(screen.getByLabelText("Sci-fi"));
    expect(screen.getByLabelText("Primary audio language")).toHaveValue("cs");
    expect(screen.getByLabelText("Secondary audio language")).toHaveValue("en");
    expect(screen.getByLabelText("Subtitles with primary audio")).toHaveValue(
      "off",
    );
    expect(screen.getByLabelText("Subtitles with secondary audio")).toHaveValue(
      "cs",
    );
    await user.click(screen.getByRole("button", { name: /continue/i }));

    expect(
      screen.getByRole("heading", { name: /connect once/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^continue/i }));

    expect(
      screen.getByRole("heading", { name: /a curator/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("qwen3.5:4b")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^continue/i }));

    expect(
      screen.getByRole("heading", { name: /welcome home, alex/i }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /enter streamer/i }));

    await user.click(await screen.findByRole("button", { name: /alex/i }));

    expect(
      await screen.findByRole("heading", {
        name: /what are you in the mood for/i,
      }),
    ).toBeInTheDocument();
    expect(api.completeSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          name: "Alex",
          preferences: ["Sci-fi"],
        }),
        localAiEnabled: true,
      }),
    );
  });

  it("clears a TMDB token after connecting and never renders it in status UI", async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} forceOnboarding />);

    await user.click(screen.getByRole("button", { name: /start setup/i }));
    await user.type(screen.getByLabelText(/display name/i), "Alex");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    const secret = "secret-read-access-token-123";
    const tokenInput = screen.getByLabelText(/tmdb read access token/i);
    await user.type(tokenInput, secret);
    await user.click(
      screen.getByRole("button", { name: /verify and connect/i }),
    );

    await waitFor(() =>
      expect(screen.getByText(/connection verified/i)).toBeInTheDocument(),
    );
    expect(api.connectTmdb).toHaveBeenCalledWith(secret);
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("status")).queryByText(secret),
    ).not.toBeInTheDocument();
  });

  it("clears the Webshare password after local connection", async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} forceOnboarding />);

    await user.click(screen.getByRole("button", { name: /start setup/i }));
    await user.type(screen.getByLabelText(/display name/i), "Alex");
    await user.click(screen.getByRole("button", { name: /continue/i }));

    await user.type(screen.getByLabelText(/username or email/i), "viewer");
    const password = "webshare-password-sentinel";
    const passwordInput = screen.getByLabelText(/^password$/i);
    await user.type(passwordInput, password);
    expect(passwordInput).toHaveAttribute("type", "password");
    await user.click(
      screen.getByRole("button", { name: /show webshare password/i }),
    );
    expect(passwordInput).toHaveAttribute("type", "text");
    await user.click(
      screen.getByRole("button", { name: /hide webshare password/i }),
    );
    expect(passwordInput).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: /connect webshare/i }));

    expect(
      await screen.findByText(/session token is stored/i),
    ).toBeInTheDocument();
    expect(api.connectWebshare).toHaveBeenCalledWith("viewer", password);
    expect(screen.queryByDisplayValue(password)).not.toBeInTheDocument();
    expect(screen.queryByText(password)).not.toBeInTheDocument();
  });

  it("clearly identifies development-only memory storage", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.connectTmdb).mockResolvedValue({
      ok: true,
      integrationId: "tmdb",
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "memory",
    });
    render(<App api={api} forceOnboarding />);

    await user.click(screen.getByRole("button", { name: /start setup/i }));
    await user.type(screen.getByLabelText(/display name/i), "Alex");
    await user.click(screen.getByRole("button", { name: /continue/i }));
    await user.type(
      screen.getByLabelText(/tmdb read access token/i),
      "development-token-long-enough",
    );
    await user.click(
      screen.getByRole("button", { name: /verify and connect/i }),
    );

    expect(await screen.findByText(/held in memory only/i)).toBeInTheDocument();
  });
});

describe("profile navigation", () => {
  it("opens profile pages, saves playback languages, and returns to the profile chooser", async () => {
    const user = userEvent.setup();
    const api = createApi();
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.click(
      screen.getByRole("button", { name: /profile menu for alex/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(
      screen.getByRole("heading", { name: "Settings" }),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Secondary audio language"),
      "de",
    );
    await user.click(screen.getByLabelText("Automatically find subtitles"));
    await user.selectOptions(screen.getByLabelText("Subtitle size"), "150");
    await user.selectOptions(screen.getByLabelText("Subtitle font"), "mono");
    fireEvent.change(screen.getByLabelText("Subtitle color"), {
      target: { value: "#ffcc00" },
    });
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(api.updateProfile).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({
          playback: expect.objectContaining({
            secondaryAudioLanguage: "de",
            autoFindSubtitles: true,
            subtitleSizePercent: 150,
            subtitleFont: "mono",
            subtitleColor: "#ffcc00",
          }),
        }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /profile menu for alex/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Preferences" }));
    await user.type(
      screen.getByLabelText("Your taste prompt"),
      "Quiet autumn mysteries.",
    );
    await user.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() =>
      expect(api.updateProfile).toHaveBeenCalledWith(
        "default",
        expect.objectContaining({ prompt: "Quiet autumn mysteries." }),
      ),
    );
    await user.click(
      screen.getByRole("button", { name: /profile menu for alex/i }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: /log out \/ switch profile/i }),
    );
    expect(
      await screen.findByRole("heading", { name: /who's watching/i }),
    ).toBeInTheDocument();
  });

  it("creates a second viewer from one of five profile medallions", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const primary = (await api.getProfiles()).items[0]!;
    const guest = await api.createProfile({ name: "Guest", locale: "en" });
    vi.mocked(api.createProfile).mockClear();
    let created = false;
    let completed = false;
    vi.mocked(api.createProfile).mockImplementation(async () => {
      created = true;
      return guest;
    });
    vi.mocked(api.getProfiles).mockImplementation(async () => ({
      items: created
        ? [primary, { ...guest, onboardingComplete: completed }]
        : [primary],
      limit: 5,
    }));
    vi.mocked(api.completeSetup).mockImplementation(async (request) => {
      if (request.profileId === guest.id) completed = true;
    });
    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: /add profile/i }),
    );
    await user.type(screen.getByLabelText("Profile name"), "Guest");
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() =>
      expect(api.createProfile).toHaveBeenCalledWith({
        name: "Guest",
        locale: "en",
      }),
    );
    expect(
      await screen.findByRole("button", { name: /start setup/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /profile menu for guest/i }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Exit setup" }));
    await user.click(
      await screen.findByRole("button", { name: /guest.*finish setup/i }),
    );
    await user.click(screen.getByRole("button", { name: /start setup/i }));
    expect(screen.getByLabelText("Display name")).toHaveValue("Guest");
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /enter streamer/i }));
    await waitFor(() =>
      expect(api.completeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: guest.id }),
      ),
    );
    expect(
      await screen.findByRole("button", { name: /profile menu for guest/i }),
    ).toBeInTheDocument();
  });

  it("reopens onboarding for the selected profile", async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.click(
      screen.getByRole("button", { name: /profile menu for alex/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Settings" }));
    await user.click(
      screen.getByRole("button", { name: "Run onboarding again" }),
    );
    await user.click(screen.getByRole("button", { name: /start setup/i }));
    expect(screen.getByLabelText("Display name")).toHaveValue("Alex");
    expect(screen.getByLabelText("Primary audio language")).toHaveValue("cs");
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /^continue/i }));
    await user.click(screen.getByRole("button", { name: /enter streamer/i }));
    await waitFor(() =>
      expect(api.completeSetup).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "default" }),
      ),
    );
  });
});

describe("conversational Home", () => {
  const title = {
    id: "sai:title:lake-house",
    kind: "movie" as const,
    title: "The Lake House",
    originalTitle: null,
    year: 2006,
    synopsis: "A lakeside mailbox bridges two years.",
    posterUrl: null,
    backdropUrl: null,
    accentColor: "#6b4a3f",
    genres: ["Romance"],
    ratings: [{ source: "TMDB", value: 7.2, scale: 10, votes: 1200 }],
    matchPercent: 94,
    availability: "available" as const,
    availabilityProvider: "media-fixture",
    availabilityCheckedAt: "2026-09-27T12:00:00.000Z",
    formats: [
      {
        label: "1080p",
        container: "mkv",
        resolution: "1080p",
        videoCodec: "H.264",
        audioLanguages: ["en"],
        subtitleLanguages: ["cs"],
      },
    ],
    seriesCoverage: null,
    metadataProvider: "metadata-fixture",
    metadataValidatedAt: "2026-09-27T12:00:00.000Z",
    inLibrary: false,
    progressPercent: null,
  };

  it("opens the same detail view from a movie tile", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "preview",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [
        {
          id: "for-you",
          title: "Picks For You",
          subtitle: "Starting point",
          freshness: "fresh",
          items: [title],
        },
      ],
    });
    vi.mocked(api.getTitleDetail).mockResolvedValue({
      title,
      series: null,
      related: [],
    });
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.click(
      (
        await screen.findAllByRole("button", {
          name: "Details for The Lake House",
        })
      )[0]!,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Details for The Lake House",
    });
    expect(
      within(dialog).getByRole("heading", { name: "The Lake House" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("heading", { name: "More to watch" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("heading", { name: "Seasons & episodes" }),
    ).not.toBeInTheDocument();
  });

  it("returns from a series episode to the same season and shows its name in the player", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const show = {
      ...title,
      id: "sai:title:sample-show",
      kind: "series" as const,
      title: "Sample Show",
      seriesCoverage: {
        seasonsAvailable: 2,
        seasonsTotal: 2,
        episodesAvailable: 2,
        episodesTotal: 2,
        complete: true,
        nextEpisodeLabel: "S01 E01",
      },
    };
    vi.mocked(api.getSetupStatus).mockResolvedValue({
      complete: true,
      tmdb: "connected",
      webshare: "connected",
      localAi: "connected",
      playback: true,
    });
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [
        {
          id: "for-you",
          title: "Picks For You",
          subtitle: "Starting point",
          freshness: "fresh",
          items: [show],
        },
      ],
    });
    vi.mocked(api.getTitleDetail).mockResolvedValue({
      title: show,
      related: [],
      series: {
        status: "complete",
        seasons: [
          {
            seasonNumber: 1,
            title: "Season One",
            episodes: [
              {
                seasonNumber: 1,
                episodeNumber: 1,
                title: "Pilot",
                airDate: null,
                availability: "available",
              },
            ],
          },
          {
            seasonNumber: 2,
            title: "Season Two",
            episodes: [
              {
                seasonNumber: 2,
                episodeNumber: 3,
                title: "Third Episode",
                airDate: null,
                availability: "available",
              },
            ],
          },
        ],
      },
    });
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.click(
      (
        await screen.findAllByRole("button", {
          name: "Details for Sample Show",
        })
      )[0]!,
    );
    const details = await screen.findByRole("dialog", {
      name: "Details for Sample Show",
    });
    await within(details).findByText(/Pilot/);
    await user.click(within(details).getByRole("button", { name: "Season 2" }));
    details.scrollTop = 180;
    await user.click(within(details).getByRole("button", { name: /play/i }));

    const player = await screen.findByRole("dialog", {
      name: /playing sample show/i,
    });
    expect(
      within(player).getByRole("heading", {
        name: /Sample Show.*S02E03.*Third Episode/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Details for Sample Show" }),
    ).not.toBeInTheDocument();
    expect(api.preparePlayback).toHaveBeenCalledWith("default", show.id, {
      seasonNumber: 2,
      episodeNumber: 3,
    });

    await user.click(
      within(player).getByRole("button", { name: "Close player" }),
    );
    const returned = await screen.findByRole("dialog", {
      name: "Details for Sample Show",
    });
    expect(
      within(returned).getByRole("button", { name: "Season 2" }),
    ).toHaveClass("is-active");
    expect(within(returned).getByText(/Third Episode/)).toBeInTheDocument();
    expect(returned).toHaveProperty("scrollTop", 180);
    // Detail loads once on open, once for the player's episode list,
    // and once more when returning from playback.
    await waitFor(() => expect(api.getTitleDetail).toHaveBeenCalledTimes(3));

    await user.click(
      within(returned).getByRole("button", { name: "Close details" }),
    );
    await user.click(await screen.findByRole("button", { name: "Play" }));
    const quickPlayer = await screen.findByRole("dialog", {
      name: /playing sample show/i,
    });
    expect(
      await within(quickPlayer).findByRole("heading", {
        name: /Sample Show.*S01E01.*Pilot/,
      }),
    ).toBeInTheDocument();
  });

  it("submits a natural-language request and renders the validated best match actions", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "preview",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [
        {
          id: "for-you",
          title: "Picks for You",
          subtitle: "Starting point",
          freshness: "fresh",
          items: [title],
        },
      ],
    });
    vi.mocked(api.discover).mockResolvedValue({
      sessionId: "session-1",
      mode: "live",
      stage: "completed",
      reply: "A warm seasonal match.",
      bestMatch: { title, reason: "Requested actor and autumn mood." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));

    await user.type(
      await screen.findByLabelText(/ask streamerai/i),
      "an autumn movie with Sandra Bullock",
    );
    await user.click(screen.getByRole("button", { name: /find something/i }));

    expect(
      await screen.findByText("Requested actor and autumn mood."),
    ).toBeInTheDocument();
    const results = screen.getByRole("region", {
      name: /a considered shortlist/i,
    });
    expect(
      within(results).getByRole("button", {
        name: /play/i,
      }),
    ).toBeInTheDocument();
    await user.click(
      within(results).getByRole("button", { name: /add to library/i }),
    );
    expect(api.addToLibrary).toHaveBeenCalledWith("default", title.id);
  });

  it("shows quick API matches while deep discovery runs and merges canonical duplicates", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    const quick = {
      sessionId: "parallel-session",
      mode: "live" as const,
      stage: "completed" as const,
      reply: "Quick matches are ready.",
      bestMatch: { title, reason: "Quick similarity match." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    };
    api.discoverFast = vi.fn().mockResolvedValue(quick);
    let finishDeep!: (
      value: Awaited<ReturnType<StreamerApi["discover"]>>,
    ) => void;
    vi.mocked(api.discover).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDeep = resolve;
        }),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "a romantic film",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));

    expect(
      await screen.findByText("Quick similarity match."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Stop search" }),
    ).toBeInTheDocument();
    const quickRequest = vi.mocked(api.discoverFast).mock.calls[0]![0];
    const deepRequest = vi.mocked(api.discover).mock.calls[0]![0];
    expect(deepRequest).toMatchObject({
      sessionId: quickRequest.sessionId,
      idempotencyKey: quickRequest.idempotencyKey,
      createSession: true,
    });

    const second = {
      ...title,
      id: "sai:title:second",
      title: "Second Film",
      matchPercent: 81,
    };
    finishDeep({
      ...quick,
      reply: "I found a richer shortlist. Is this what you had in mind?",
      bestMatch: { title, reason: "Contextual match." },
      available: [{ title: second, reason: "Another validated option." }],
    });
    expect(await screen.findByText("Contextual match.")).toBeInTheDocument();
    const results = screen.getByRole("region", {
      name: /a considered shortlist/i,
    });
    expect(
      within(results).getAllByRole("heading", { name: "The Lake House" }),
    ).toHaveLength(1);
    expect(
      within(results).getByRole("heading", { name: "Second Film" }),
    ).toBeInTheDocument();
  });

  it("checks a provisional fast match and promotes it when the streaming source succeeds", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    const provisionalTitle = {
      ...title,
      availability: "unknown" as const,
      availabilityProvider: null,
      availabilityCheckedAt: null,
      formats: [],
    };
    api.discoverFast = vi.fn().mockResolvedValue({
      sessionId: "fast-promoted",
      mode: "live",
      stage: "completed",
      reply: "Checking the streaming source.",
      bestMatch: null,
      available: [],
      unavailable: [],
      unverified: [
        {
          title: provisionalTitle,
          reason: "Exact title match from TMDB.",
        },
      ],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    vi.mocked(api.discover).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    let finishCheck!: () => void;
    vi.mocked(api.checkPlayback).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheck = () =>
            resolve({
              ok: true,
              audioLanguages: ["en"],
              subtitleLanguages: ["cs"],
            });
        }),
    );

    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(screen.getByLabelText(/ask streamerai/i), "The Lake House");
    await user.click(screen.getByRole("button", { name: "Find something" }));

    await waitFor(() =>
      expect(api.checkPlayback).toHaveBeenCalledWith(
        "default",
        provisionalTitle.id,
        undefined,
      ),
    );
    const checkingGroup = screen
      .getByRole("heading", { name: "Checking availability" })
      .closest(".result-group");
    expect(checkingGroup).not.toBeNull();
    expect(
      within(checkingGroup as HTMLElement).getByRole("heading", {
        name: "The Lake House",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking" })).toBeDisabled();

    finishCheck();
    await waitFor(() => {
      const card = screen
        .getByRole("heading", { name: "The Lake House" })
        .closest("article");
      expect(card).not.toBeNull();
      expect(
        card?.classList.contains("title-card--hero") ||
          card?.closest(".result-group")?.querySelector("h3")?.textContent ===
            "Available to stream",
      ).toBe(true);
      expect(
        within(card as HTMLElement).getByRole("button", { name: "Play" }),
      ).toBeEnabled();
      expect(
        screen.queryByRole("heading", { name: "Checking availability" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", {
          name: "Found, not currently available",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("fuses a late exact fast hit with deep results without duplicate tiles", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    const panTau = {
      ...title,
      id: "sai:tmdb:tv:pan-tau",
      title: "Pan Tau",
      matchPercent: 83,
    };
    const wrongSuggestion = {
      ...title,
      id: "sai:tmdb:movie:unrelated",
      title: "The Magic Hat",
      matchPercent: 99,
    };
    let finishFast!: (
      value: Awaited<ReturnType<NonNullable<StreamerApi["discoverFast"]>>>,
    ) => void;
    api.discoverFast = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFast = resolve;
        }),
    );
    vi.mocked(api.discover).mockResolvedValueOnce({
      sessionId: "deep-first",
      mode: "live",
      stage: "completed",
      reply: "A contextual shortlist.",
      bestMatch: { title: wrongSuggestion, reason: "Agent suggestion." },
      available: [{ title: panTau, reason: "Agent also found this title." }],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });

    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(screen.getByLabelText(/ask streamerai/i), "Pan Tau");
    await user.click(screen.getByRole("button", { name: "Find something" }));
    const results = await screen.findByRole("region", {
      name: /a considered shortlist/i,
    });
    expect(
      within(results).getByRole("heading", { name: "The Magic Hat" }),
    ).toBeInTheDocument();

    finishFast({
      sessionId: "deep-first",
      mode: "live",
      stage: "completed",
      reply: "Exact database match.",
      bestMatch: { title: panTau, reason: "Exact title match." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    await waitFor(() =>
      expect(
        within(results)
          .getByRole("heading", { name: "Pan Tau" })
          .closest("article"),
      ).toHaveClass("title-card--hero"),
    );
    expect(
      within(results).getAllByRole("heading", { name: "Pan Tau" }),
    ).toHaveLength(1);
    expect(
      within(results).getAllByRole("heading", { name: "The Magic Hat" }),
    ).toHaveLength(1);
  });

  it("does not replace a chat refinement with a late initial fast response", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    let finishFast!: (
      value: Awaited<ReturnType<NonNullable<StreamerApi["discoverFast"]>>>,
    ) => void;
    api.discoverFast = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFast = resolve;
        }),
    );
    const refinedTitle = {
      ...title,
      id: "sai:title:refined",
      title: "A Better Fit",
    };
    vi.mocked(api.discover)
      .mockResolvedValueOnce({
        sessionId: "refinement-session",
        mode: "live",
        stage: "completed",
        reply: "Original answer. Is this what you had in mind?",
        bestMatch: { title, reason: "Initial suggestion." },
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt: "2026-09-27T12:00:00.000Z",
      })
      .mockResolvedValueOnce({
        sessionId: "refinement-session",
        mode: "live",
        stage: "completed",
        reply: "Refined answer. Is this a better fit?",
        bestMatch: { title: refinedTitle, reason: "Matches your feedback." },
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt: "2026-09-27T12:00:00.000Z",
      });

    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "a romantic film",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));
    await user.click(
      await screen.findByRole("button", {
        name: /is this what you had in mind/i,
      }),
    );
    const chat = screen.getByRole("complementary", { name: "StreamerAI chat" });
    await user.type(
      within(chat).getByLabelText("Reply to StreamerAI"),
      "Less wistful, please",
    );
    await user.click(within(chat).getByRole("button", { name: "Send" }));
    expect(
      await within(chat).findByText("Refined answer. Is this a better fit?"),
    ).toBeInTheDocument();
    expect(vi.mocked(api.discover).mock.calls[1]?.[0]).toMatchObject({
      sessionId: "refinement-session",
      message: "Less wistful, please",
    });
    expect(vi.mocked(api.discoverFast).mock.calls[0]?.[1]?.aborted).toBe(true);

    const staleTitle = {
      ...title,
      id: "sai:title:stale-fast",
      title: "Stale Fast Suggestion",
    };
    await act(async () => {
      finishFast({
        sessionId: "refinement-session",
        mode: "live",
        stage: "completed",
        reply: "Late initial quick answer.",
        bestMatch: { title: staleTitle, reason: "Stale quick suggestion." },
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt: "2026-09-27T12:00:00.000Z",
      });
    });

    const results = screen.getByRole("region", {
      name: /a considered shortlist/i,
    });
    expect(
      within(results).getByRole("heading", { name: "A Better Fit" }),
    ).toBeInTheDocument();
    expect(
      within(results).queryByRole("heading", {
        name: "Stale Fast Suggestion",
      }),
    ).not.toBeInTheDocument();
    expect(within(chat).getByText("Less wistful, please")).toBeInTheDocument();
    expect(
      within(chat).getByText("Refined answer. Is this a better fit?"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Late initial quick answer."),
    ).not.toBeInTheDocument();
  });

  it("stops only deep discovery and keeps already returned quick matches", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    api.discoverFast = vi.fn().mockResolvedValue({
      sessionId: "stop-parallel",
      mode: "live",
      stage: "completed",
      reply: "Quick matches are ready.",
      bestMatch: { title, reason: "Quick similarity match." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    let finishDeep!: (
      value: Awaited<ReturnType<StreamerApi["discover"]>>,
    ) => void;
    vi.mocked(api.discover).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDeep = resolve;
        }),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "a romantic film",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));
    expect(
      await screen.findByText("Quick similarity match."),
    ).toBeInTheDocument();
    const deepSignal = vi.mocked(api.discover).mock.calls[0]?.[1];
    const fastSignal = vi.mocked(api.discoverFast).mock.calls[0]?.[1];
    await user.click(screen.getByRole("button", { name: "Stop search" }));
    expect(deepSignal?.aborted).toBe(true);
    expect(fastSignal?.aborted).toBe(false);
    expect(screen.getByText("Quick similarity match.")).toBeInTheDocument();
    finishDeep({
      sessionId: "stop-parallel",
      mode: "live",
      stage: "completed",
      reply: "Late deep reply.",
      bestMatch: null,
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    expect(screen.queryByText("Late deep reply.")).not.toBeInTheDocument();
  });

  it("starts each main search in a fresh session and keeps refinements in the floating chat", async () => {
    const user = userEvent.setup();
    const api = createApi();
    const response = (sessionId: string, reply: string) => ({
      sessionId,
      mode: "live" as const,
      stage: "completed" as const,
      reply,
      bestMatch: { title, reason: "A validated match." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    vi.mocked(api.discover)
      .mockResolvedValueOnce(
        response("session-one", "Is this what you had in mind?"),
      )
      .mockResolvedValueOnce(
        response(
          "session-one",
          "Here is a less spooky option. Is this better?",
        ),
      )
      .mockResolvedValueOnce(
        response("session-two", "A fresh shortlist. Is this right?"),
      );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(screen.getByLabelText(/ask streamerai/i), "an autumn film");
    await user.click(screen.getByRole("button", { name: "Find something" }));
    expect(
      await screen.findByRole("button", {
        name: /is this what you had in mind/i,
      }),
    ).toBeInTheDocument();
    expect(
      vi.mocked(api.discover).mock.calls[0]?.[0].sessionId,
    ).toBeUndefined();

    await user.click(
      screen.getByRole("button", { name: /is this what you had in mind/i }),
    );
    const chat = screen.getByRole("complementary", { name: "StreamerAI chat" });
    expect(
      within(chat).getByText("Is this what you had in mind?"),
    ).toBeInTheDocument();
    await user.type(
      within(chat).getByLabelText("Reply to StreamerAI"),
      "Less spooky, please",
    );
    await user.click(within(chat).getByRole("button", { name: "Send" }));
    expect(
      await within(chat).findByText(
        "Here is a less spooky option. Is this better?",
      ),
    ).toBeInTheDocument();
    expect(vi.mocked(api.discover).mock.calls[1]?.[0]).toMatchObject({
      sessionId: "session-one",
      message: "Less spooky, please",
    });

    await user.clear(screen.getByLabelText(/ask streamerai/i));
    await user.type(screen.getByLabelText(/ask streamerai/i), "a space comedy");
    await user.click(screen.getByRole("button", { name: "Find something" }));
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(3));
    expect(
      vi.mocked(api.discover).mock.calls[2]?.[0].sessionId,
    ).toBeUndefined();
    expect(
      await screen.findByRole("button", {
        name: /is this what you had in mind/i,
      }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /is this what you had in mind/i }),
    );
    expect(
      within(
        screen.getByRole("complementary", { name: "StreamerAI chat" }),
      ).queryByText("Less spooky, please"),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["Home", "Home"],
    ["logo", "StreamerAI home"],
  ])(
    "returns to a clean Home when clicking the %s button",
    async (_label, buttonName) => {
      const user = userEvent.setup();
      const api = createApi();
      const scroll = vi.spyOn(window, "scrollTo");
      vi.mocked(api.discover).mockResolvedValueOnce({
        sessionId: "session-before-home",
        mode: "live",
        stage: "completed",
        reply: "A shortlist. Is this what you had in mind?",
        bestMatch: null,
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt: "2026-09-27T12:00:00.000Z",
      });
      window.history.replaceState({}, "", "/");
      render(<App api={api} />);

      await user.click(await screen.findByRole("button", { name: /alex/i }));
      await user.type(
        screen.getByLabelText(/ask streamerai/i),
        "an autumn film",
      );
      await user.click(screen.getByRole("button", { name: "Find something" }));
      expect(
        await screen.findByRole("region", { name: /a considered shortlist/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("complementary", { name: "StreamerAI chat" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: buttonName }));
      expect(
        screen.queryByRole("region", { name: /a considered shortlist/i }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("complementary", { name: "StreamerAI chat" }),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText(/ask streamerai/i)).toHaveValue("");
      expect(scroll).toHaveBeenLastCalledWith({ top: 0, behavior: "auto" });
      scroll.mockRestore();
    },
  );

  it("aborts a pending discovery when Home is clicked", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.discover).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(screen.getByLabelText(/ask streamerai/i), "an autumn film");
    await user.click(screen.getByRole("button", { name: "Find something" }));
    expect(
      screen.getByRole("button", { name: "Stop search" }),
    ).toBeInTheDocument();
    const signal = vi.mocked(api.discover).mock.calls[0]?.[1];
    await user.click(screen.getByRole("button", { name: "Home" }));

    expect(signal?.aborted).toBe(true);
    expect(api.cancelDiscovery).toHaveBeenCalledWith(
      "default",
      vi.mocked(api.discover).mock.calls[0]?.[0].idempotencyKey,
    );
    expect(
      screen.queryByRole("region", { name: "Discovery progress" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(/ask streamerai/i)).toHaveValue("");
  });

  it("shows a wake-up notice only when the live local model is not resident", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.getHome).mockResolvedValue({
      profileId: "default",
      mode: "live",
      generatedAt: "2026-09-27T12:00:00.000Z",
      sections: [],
    });
    vi.mocked(api.getInferenceResidency).mockResolvedValue({
      state: "unloaded",
      checkedAt: "2026-09-27T12:00:00.000Z",
    });
    let resolveDiscovery:
      | ((value: Awaited<ReturnType<StreamerApi["discover"]>>) => void)
      | undefined;
    vi.mocked(api.discover).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await screen.findByRole("heading", {
      name: /what are you in the mood for/i,
    });
    await waitFor(() => expect(api.getHome).toHaveBeenCalled());
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "an autumn movie",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));

    expect(
      await screen.findByText(/local agent dozed off/i, {
        selector: ".agent-wake-notice",
      }),
    ).toBeInTheDocument();
    expect(api.getInferenceResidency).toHaveBeenCalledWith(
      expect.any(AbortSignal),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
    const progress = screen.getByRole("region", { name: "Discovery progress" });
    expect(
      within(progress).getByText("Ranking verified matches"),
    ).not.toHaveClass("is-active");

    resolveDiscovery?.({
      sessionId: "cold-session",
      mode: "live",
      stage: "completed",
      reply: "Found a match.",
      bestMatch: null,
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    expect(
      await screen.findByRole("region", { name: /a considered shortlist/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/local agent dozed off/i, {
        selector: ".agent-wake-notice",
      }),
    ).not.toBeInTheDocument();
  });

  it("stops discovery and ignores a response that arrives after cancellation", async () => {
    const user = userEvent.setup();
    const api = createApi();
    let confirmStop!: () => void;
    vi.mocked(api.cancelDiscovery).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmStop = resolve;
        }),
    );
    let resolveDiscovery:
      | ((value: Awaited<ReturnType<StreamerApi["discover"]>>) => void)
      | undefined;
    vi.mocked(api.discover).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "a gentle comedy",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));

    const stop = screen.getByRole("button", { name: "Stop search" });
    expect(stop).toHaveClass("is-searching");
    expect(stop.querySelector(".composer-submit__gleam")).toBeInTheDocument();
    expect(stop).not.toHaveClass("is-launching");
    expect(
      screen.getByRole("region", { name: "Discovery progress" }),
    ).toBeInTheDocument();
    const signal = vi.mocked(api.discover).mock.calls[0]?.[1];
    expect(signal?.aborted).toBe(false);
    await user.click(stop);
    expect(signal?.aborted).toBe(true);
    expect(api.cancelDiscovery).toHaveBeenCalledWith(
      "default",
      vi.mocked(api.discover).mock.calls[0]?.[0].idempotencyKey,
    );
    expect(
      screen.getByRole("button", { name: "Stopping search" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stopping search" })).toHaveClass(
      "is-stopping",
    );
    expect(
      within(
        screen.getByRole("region", { name: "Discovery progress" }),
      ).getByText("Stopping search…"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Find something" }),
    ).not.toBeInTheDocument();
    confirmStop();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Find something" }),
      ).toBeEnabled(),
    );

    resolveDiscovery?.({
      sessionId: "late-session",
      mode: "live",
      stage: "completed",
      reply: "This result should be discarded.",
      bestMatch: { title, reason: "Late result" },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    await waitFor(() => {
      expect(
        screen.queryByText("This result should be discarded."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("region", { name: "Discovery progress" }),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Find something" }));
    await waitFor(() => expect(api.discover).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(api.discover).mock.calls[1]?.[0].sessionId,
    ).toBeUndefined();
  });

  it("reports when the server cannot confirm a stopped search", async () => {
    const user = userEvent.setup();
    const api = createApi();
    vi.mocked(api.discover).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    vi.mocked(api.cancelDiscovery).mockRejectedValueOnce(
      new Error("Connection lost"),
    );
    window.history.replaceState({}, "", "/");
    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: /alex/i }));
    await user.type(
      screen.getByLabelText(/ask streamerai/i),
      "a gentle comedy",
    );
    await user.click(screen.getByRole("button", { name: "Find something" }));
    const signal = vi.mocked(api.discover).mock.calls[0]?.[1];
    await user.click(screen.getByRole("button", { name: "Stop search" }));

    expect(signal?.aborted).toBe(true);
    expect(
      await screen.findByText(/search stop could not be confirmed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Find something" }),
    ).toBeEnabled();
  });

  it("automatically checks a live title and enables Play when verified", async () => {
    const user = userEvent.setup();
    const api = createApi();
    let resolveCheck!: () => void;
    vi.mocked(api.checkPlayback).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = () =>
            resolve({
              ok: true,
              audioLanguages: ["jpn"],
              subtitleLanguages: [],
            });
        }),
    );
    vi.mocked(api.discover).mockResolvedValue({
      sessionId: "session-check",
      mode: "live",
      stage: "completed",
      reply: "A verified match.",
      bestMatch: { title, reason: "A good fit." },
      available: [],
      unavailable: [],
      unverified: [],
      warnings: [],
      completedAt: "2026-09-27T12:00:00.000Z",
    });
    render(
      <StrictMode>
        <App api={api} />
      </StrictMode>,
    );

    await user.click(await screen.findByRole("button", { name: /alex/i }));

    await user.type(
      await screen.findByLabelText(/ask streamerai/i),
      "a warm romantic movie",
    );
    await user.click(screen.getByRole("button", { name: /find something/i }));
    await waitFor(() =>
      expect(api.checkPlayback).toHaveBeenCalledWith(
        "default",
        title.id,
        undefined,
      ),
    );
    const checking = screen.getByRole("button", { name: /checking/i });
    expect(checking).toBeDisabled();
    expect(checking).toHaveClass("button--checking");
    resolveCheck();
    const play = await screen.findByRole("button", { name: /play/i });
    expect(play).toBeEnabled();
    const languages = screen.getByLabelText(
      "Audio languages: JAP; no preferred audio or subtitles",
    );
    expect(within(languages).getByText("JAP")).toHaveClass(
      "title-card__language-badge--warning",
    );
    await user.click(play);
    expect(
      await screen.findByRole("dialog", { name: /playing the lake house/i }),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("button", { name: "StreamerAI home" }),
      ).getByLabelText("StreamerAI"),
    ).toHaveTextContent("STREAMERAI");
    expect(
      within(
        screen.getByRole("dialog", { name: /playing the lake house/i }),
      ).getByLabelText("StreamerAI"),
    ).toHaveTextContent("STREAMERAI");
    expect(api.getPlaybackManifest).toHaveBeenCalledWith("grant-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.closePlayback).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /close player/i }));
    await waitFor(() =>
      expect(api.closePlayback).toHaveBeenCalledWith("grant-1"),
    );
  });
});
