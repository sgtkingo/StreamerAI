import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  CatalogTitle,
  PlaybackGrant,
  PlaybackMediaInfo,
  PlaybackPreferences,
  SeriesEpisodeDetail,
} from "@streamer-ai/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamerApi } from "../api/client";
import { DEFAULT_PLAYBACK_PREFERENCES } from "../playback-preferences";
import { VideoPlayer } from "./VideoPlayer";

const baseTitle: CatalogTitle = {
  id: "sai:tmdb:movie:42",
  kind: "movie",
  title: "Example",
  originalTitle: null,
  year: 2024,
  synopsis: "",
  posterUrl: null,
  backdropUrl: null,
  accentColor: "#334455",
  genres: [],
  ratings: [],
  matchPercent: null,
  availability: "available",
  availabilityProvider: "webshare",
  availabilityCheckedAt: "2026-10-04T08:00:00.000Z",
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
  metadataProvider: "tmdb",
  metadataValidatedAt: "2026-10-04T08:00:00.000Z",
  inLibrary: false,
  progressPercent: null,
};

const grant: PlaybackGrant = {
  grantId: "test-grant",
  titleId: baseTitle.id,
  providerId: "webshare",
  variantId: "variant-1",
  url: "/api/v1/playback/grants/test-grant",
  supportsHttpRange: true,
  expiresAt: "2026-10-04T09:00:00.000Z",
  embeddedSubtitles: [],
};

const manifest: PlaybackMediaInfo = {
  durationSeconds: 120,
  videoCodec: "h264",
  videoPixelFormat: "yuv420p",
  audioTracks: [
    {
      streamIndex: 2,
      codec: "eac3",
      channels: 6,
      channelLayout: "5.1(side)",
      language: "en",
      title: "English 5.1",
    },
  ],
  subtitleTracks: [
    {
      streamIndex: 3,
      codec: "subrip",
      language: "cs",
      title: "Czech",
    },
  ],
};

function api(overrides: Partial<StreamerApi> = {}): StreamerApi {
  return {
    getPlaybackManifest: vi.fn().mockResolvedValue(manifest),
    getTitleDetail: vi.fn().mockResolvedValue({
      title: baseTitle,
      series: null,
      related: [],
    }),
    savePlaybackProgress: async () => undefined,
    closePlayback: async () => undefined,
    ...overrides,
  } as unknown as StreamerApi;
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
    () => undefined,
  );
});

afterEach(() => {
  Reflect.deleteProperty(HTMLMediaElement.prototype, "setSinkId");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("VideoPlayer output and episode flow", () => {
  it("accepts a valid subtitle window with no spoken lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "WEBVTT\n\n" }),
    );
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={{
          ...DEFAULT_PLAYBACK_PREFERENCES,
          autoFindSubtitles: true,
        }}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `${grant.url}/subtitles/3?at=0`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText(/Loading subtitles/i)).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
  });

  it("routes audio to the saved device and shows styled subtitles after seeking", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: setSinkId,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          headers: {
            get: () => (url.includes("at=60") ? "58" : "0"),
          },
          text: async () =>
            url.includes("at=60")
              ? "WEBVTT\n\n00:00:04.000 --> 00:00:06.000\nHello, viewer\n"
              : "WEBVTT\n\n",
        }),
      ),
    );
    const preferences: PlaybackPreferences = {
      ...DEFAULT_PLAYBACK_PREFERENCES,
      autoFindSubtitles: true,
      audioOutputDeviceId: "speaker-1",
      subtitleSizePercent: 150,
      subtitleColor: "#ffff00",
      subtitleFont: "mono",
    };
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={preferences}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(setSinkId).toHaveBeenCalledWith("speaker-1"));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `${grant.url}/subtitles/3?at=0`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    const video = document.querySelector("video")!;
    video.currentTime = 62.5;
    fireEvent.timeUpdate(video);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `${grant.url}/subtitles/3?at=60`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    const caption = await screen.findByText("Hello, viewer");
    expect(caption.parentElement).toHaveStyle({ color: "#ffff00" });
    expect(caption.parentElement).toHaveStyle({
      fontFamily: "Consolas, monospace",
    });
    expect(caption.parentElement?.style.fontSize).toContain("45px");
  });

  it("stops waiting and explains a timed-out embedded subtitle request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      ),
    );
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={{
          ...DEFAULT_PLAYBACK_PREFERENCES,
          autoFindSubtitles: true,
        }}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Loading subtitles…")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(
      screen.getByText("Preparing subtitles for this part of the video…"),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(23_000);
    });
    expect(screen.queryByText("Loading subtitles…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Subtitles took too long to prepare",
    );
  });

  it("refreshes a series and starts its newly available next episode after five seconds", async () => {
    const first: SeriesEpisodeDetail = {
      seasonNumber: 1,
      episodeNumber: 1,
      title: "Pilot",
      airDate: null,
      availability: "available",
    };
    const second: SeriesEpisodeDetail = {
      ...first,
      episodeNumber: 2,
      title: "Second story",
    };
    const seriesTitle: CatalogTitle = {
      ...baseTitle,
      id: "sai:tmdb:series:42",
      kind: "series",
      seriesCoverage: {
        seasonsAvailable: 1,
        seasonsTotal: 1,
        episodesAvailable: 1,
        episodesTotal: 2,
        complete: false,
        nextEpisodeLabel: "S01 E01",
      },
      availability: "partial",
    };
    const getTitleDetail = vi
      .fn()
      .mockResolvedValueOnce({
        title: seriesTitle,
        series: {
          status: "searching",
          seasons: [{ seasonNumber: 1, title: null, episodes: [first] }],
        },
        related: [],
      })
      .mockResolvedValueOnce({
        title: seriesTitle,
        series: {
          status: "partial",
          seasons: [
            { seasonNumber: 1, title: null, episodes: [first, second] },
          ],
        },
        related: [],
      });
    const onPlayEpisode = vi.fn().mockResolvedValue(undefined);
    render(
      <VideoPlayer
        api={api({ getTitleDetail })}
        profileId="default"
        title={seriesTitle}
        grant={{ ...grant, titleId: seriesTitle.id }}
        episode={{ seasonNumber: 1, episodeNumber: 1 }}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={onPlayEpisode}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(getTitleDetail).toHaveBeenCalledTimes(1));
    const video = document.querySelector("video")!;
    vi.useFakeTimers();
    fireEvent.ended(video);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Starting in 5 seconds")).toBeInTheDocument();
    for (let second = 0; second < 5; second += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    expect(onPlayEpisode).toHaveBeenCalledWith(
      { seasonNumber: 1, episodeNumber: 2 },
      "Second story",
    );
  });
});
