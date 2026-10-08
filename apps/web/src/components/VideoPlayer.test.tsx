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

function subtitleWindow(
  startMs: number,
  cues: Array<{ startMs: number; endMs: number; text: string }> = [],
  trackId = "embedded:3",
) {
  return { trackId, startMs, endMs: startMs + 120_000, cues };
}

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
  Reflect.deleteProperty(navigator, "getGamepads");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("VideoPlayer output and episode flow", () => {
  it("accepts a valid subtitle window with no spoken lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => subtitleWindow(0),
      }),
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
        `${grant.url}/subtitles/3/window?startMs=0&durationMs=120000`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Subtitles" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(screen.queryByText(/Loading subtitle track/i)).toBeNull();
    expect(
      screen.queryByText(/Preparing the selected subtitle track/i),
    ).toBeNull();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
    fireEvent.ended(document.querySelector("video")!);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("routes audio to the saved device and shows styled subtitles after seeking", async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", {
      configurable: true,
      value: setSinkId,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes("startMs=120000")
            ? subtitleWindow(120_000, [
                { startMs: 182_000, endMs: 184_000, text: "Hello, viewer" },
              ])
            : subtitleWindow(0),
      })),
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
        api={api({
          getPlaybackManifest: vi.fn().mockResolvedValue({
            ...manifest,
            durationSeconds: 360,
          }),
        })}
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
        `${grant.url}/subtitles/3/window?startMs=0&durationMs=120000`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    const seek = screen.getByRole("slider", { name: "Seek through video" });
    fireEvent.change(seek, { target: { value: "182.5" } });
    fireEvent.pointerUp(seek, { target: { value: "182.5" } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        `${grant.url}/subtitles/3/window?startMs=120000&durationMs=120000`,
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
    const subtitlesButton = screen.getByRole("button", { name: "Subtitles" });
    expect(subtitlesButton).toHaveClass("is-loading");
    expect(subtitlesButton).toHaveAttribute("aria-busy", "true");
    expect(
      subtitlesButton.querySelector(".video-player__subtitle-warning"),
    ).toBeNull();
    expect(screen.queryByText("Loading subtitle track…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(
      screen.queryByText("Preparing the selected subtitle track…"),
    ).toBeNull();
    expect(subtitlesButton).toHaveClass("is-loading");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.queryByText("Loading subtitle track…")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Preparing this subtitle window is taking too long",
    );
    expect(subtitlesButton).not.toHaveClass("is-loading");
    expect(subtitlesButton).toHaveAttribute("aria-busy", "false");
    expect(subtitlesButton).toHaveAttribute(
      "aria-describedby",
      "video-player-subtitle-error",
    );
    expect(
      subtitlesButton.querySelector(".video-player__subtitle-warning"),
    ).toHaveTextContent("!");
  });

  it("returns from playback failure without waiting for an unavailable server", async () => {
    let rejectSave: (error: Error) => void = () => undefined;
    const savePlaybackProgress = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        }),
    );
    const closePlayback = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <VideoPlayer
        api={api({ savePlaybackProgress, closePlayback })}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={onClose}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    const video = document.querySelector("video")!;
    fireEvent.play(video);
    fireEvent.error(video);
    const back = screen.getByRole("button", { name: "Back to StreamerAI" });
    expect(screen.queryByRole("button", { name: "Subtitles" })).toBeNull();
    fireEvent.click(back);
    expect(screen.getByRole("dialog", { name: "Playing Example" })).toHaveClass(
      "is-closing",
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(back);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(savePlaybackProgress).toHaveBeenCalledTimes(1));
    await act(async () => rejectSave(new Error("Server unavailable")));
    await waitFor(() =>
      expect(closePlayback).toHaveBeenCalledWith(grant.grantId),
    );
  });

  it("lets the close transition finish before leaving the player", async () => {
    const onClose = vi.fn();
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={onClose}
      />,
    );
    await screen.findByRole("button", { name: "Close player" });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(screen.getByRole("dialog", { name: "Playing Example" })).toHaveClass(
      "is-closing",
    );
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(279));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes immediately when reduced motion is requested", async () => {
    const onClose = vi.fn();
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={onClose}
      />,
    );
    await screen.findByRole("button", { name: "Close player" });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    fireEvent.click(screen.getByRole("button", { name: "Close player" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reloads a failed media stream from its last playback position", async () => {
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    const previousVideo = document.querySelector("video")!;
    fireEvent.play(previousVideo);
    previousVideo.currentTime = 42.5;
    fireEvent.timeUpdate(previousVideo);
    fireEvent.error(previousVideo);
    previousVideo.currentTime = 0;

    fireEvent.click(
      screen.getByRole("button", { name: "Reload and try continue" }),
    );
    const reloadedVideo = document.querySelector("video")!;
    expect(reloadedVideo).not.toBe(previousVideo);
    expect(reloadedVideo.getAttribute("src")).toContain(
      "/media?start=42.500&audio=2&refresh=1",
    );
    expect(screen.getByText("Reloading from 0:42…")).toBeInTheDocument();
    fireEvent.canPlay(reloadedVideo);
    await waitFor(() =>
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled(),
    );
    fireEvent.loadedData(reloadedVideo);
    expect(screen.queryByText(/Reloading from/)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Subtitles" }),
    ).toBeInTheDocument();

    fireEvent.error(reloadedVideo);
    expect(
      screen.getByRole("button", { name: "Reload and try continue" }),
    ).toBeInTheDocument();
  });

  it("shows animated loading dots on the play control until a seek can resume", async () => {
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const seek = await screen.findByRole("slider", {
      name: "Seek through video",
    });
    fireEvent.change(seek, { target: { value: "45" } });
    fireEvent.pointerUp(seek, { target: { value: "45" } });

    const loadingButton = screen.getByRole("button", { name: "Loading video" });
    expect(loadingButton).toBeDisabled();
    expect(loadingButton).toHaveAttribute("aria-busy", "true");
    expect(
      loadingButton.querySelectorAll(".video-player__loading-dots > span"),
    ).toHaveLength(3);

    fireEvent.canPlay(document.querySelector("video")!);
    expect(screen.getByRole("button", { name: "Play" })).toBeEnabled();
  });

  it("hides playing controls after three idle seconds and reveals them on input", async () => {
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    const player = screen.getByRole("dialog", { name: "Playing Example" });
    const video = document.querySelector("video")!;
    vi.useFakeTimers();
    fireEvent.play(video);
    act(() => vi.advanceTimersByTime(2999));
    expect(player).not.toHaveClass("is-idle");
    act(() => vi.advanceTimersByTime(1));
    expect(player).toHaveClass("is-idle");

    fireEvent.pointerMove(player);
    expect(player).not.toHaveClass("is-idle");
    act(() => vi.advanceTimersByTime(3000));
    expect(player).toHaveClass("is-idle");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(player).not.toHaveClass("is-idle");
    fireEvent.pause(video);
    act(() => vi.advanceTimersByTime(3000));
    expect(player).not.toHaveClass("is-idle");
  });

  it("reveals idle controls when a connected gamepad is used", async () => {
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    const button = { pressed: false };
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [{ buttons: [button], axes: [0] }],
    });
    const player = screen.getByRole("dialog", { name: "Playing Example" });
    vi.useFakeTimers();
    fireEvent.play(document.querySelector("video")!);
    act(() => vi.advanceTimersByTime(3000));
    expect(player).toHaveClass("is-idle");

    button.pressed = true;
    act(() => vi.advanceTimersByTime(250));
    expect(player).not.toHaveClass("is-idle");
    button.pressed = false;
    act(() => vi.advanceTimersByTime(3000));
    expect(player).toHaveClass("is-idle");
  });

  it("shows the retry action again if reloading stalls", async () => {
    render(
      <VideoPlayer
        api={api()}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    fireEvent.error(document.querySelector("video")!);
    vi.useFakeTimers();
    fireEvent.click(
      screen.getByRole("button", { name: "Reload and try continue" }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(
      screen.getByText(/This video could not be reloaded/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reload and try continue" }),
    ).toBeInTheDocument();
  });

  it("retries a failed manifest without revoking the playback grant", async () => {
    const getPlaybackManifest = vi
      .fn()
      .mockRejectedValueOnce(new Error("Source unavailable"))
      .mockResolvedValue(manifest);
    const closePlayback = vi.fn().mockResolvedValue(undefined);
    render(
      <VideoPlayer
        api={api({ getPlaybackManifest, closePlayback })}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Reload and try continue" });
    fireEvent.click(
      screen.getByRole("button", { name: "Reload and try continue" }),
    );
    await screen.findByRole("button", { name: "Subtitles" });
    expect(getPlaybackManifest).toHaveBeenCalledTimes(2);
    expect(closePlayback).not.toHaveBeenCalled();
  });

  it("prefetches the next window and keeps an overlapping cue once across the boundary and audio switch", async () => {
    const fetchWindow = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("startMs=120000")
          ? subtitleWindow(120_000, [
              { startMs: 119_000, endMs: 122_000, text: "Shared line" },
              { startMs: 122_000, endMs: 124_000, text: "Next line" },
            ])
          : subtitleWindow(0, [
              { startMs: 119_000, endMs: 122_000, text: "Shared line" },
            ]),
    }));
    vi.stubGlobal("fetch", fetchWindow);
    render(
      <VideoPlayer
        api={api({
          getPlaybackManifest: vi.fn().mockResolvedValue({
            ...manifest,
            durationSeconds: 360,
            audioTracks: [
              ...manifest.audioTracks,
              {
                ...manifest.audioTracks[0]!,
                streamIndex: 4,
                title: "Other audio",
              },
            ],
          }),
        })}
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
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    const video = document.querySelector("video")!;
    video.currentTime = 100;
    fireEvent.timeUpdate(video);
    await waitFor(() =>
      expect(fetchWindow).toHaveBeenCalledWith(
        `${grant.url}/subtitles/3/window?startMs=120000&durationMs=120000`,
        expect.anything(),
      ),
    );
    video.currentTime = 120;
    fireEvent.timeUpdate(video);
    expect(await screen.findByText("Shared line")).toBeInTheDocument();
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    video.currentTime = 121.25;
    fireEvent.click(screen.getByRole("button", { name: "Audio" }));
    fireEvent.click(screen.getByRole("button", { name: /Other audio/i }));
    expect(document.querySelector("video")?.getAttribute("src")).toContain(
      "start=121.250",
    );
    expect(fetchWindow).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Shared line")).toBeInTheDocument();
  });

  it("restarts an aborted prefetch after seeking within the same window", async () => {
    const nextSignals: AbortSignal[] = [];
    const fetchWindow = vi
      .fn()
      .mockImplementation((url: string, options: RequestInit) => {
        if (!url.includes("startMs=120000"))
          return Promise.resolve({
            ok: true,
            json: async () => subtitleWindow(0),
          });
        const signal = options.signal as AbortSignal;
        nextSignals.push(signal);
        if (nextSignals.length === 1)
          return new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        return Promise.resolve({
          ok: true,
          json: async () =>
            subtitleWindow(120_000, [
              { startMs: 120_500, endMs: 122_000, text: "Next window" },
            ]),
        });
      });
    vi.stubGlobal("fetch", fetchWindow);
    render(
      <VideoPlayer
        api={api({
          getPlaybackManifest: vi.fn().mockResolvedValue({
            ...manifest,
            durationSeconds: 360,
          }),
        })}
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
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    const video = document.querySelector("video")!;
    video.currentTime = 100;
    fireEvent.timeUpdate(video);
    await waitFor(() => expect(nextSignals).toHaveLength(1));
    const seek = screen.getByRole("slider", { name: "Seek through video" });
    fireEvent.change(seek, { target: { value: "101" } });
    fireEvent.pointerUp(seek, { target: { value: "101" } });
    await waitFor(() => expect(nextSignals).toHaveLength(2));
    expect(nextSignals[0]?.aborted).toBe(true);
    fireEvent.change(seek, { target: { value: "121" } });
    fireEvent.pointerUp(seek, { target: { value: "121" } });
    expect(await screen.findByText("Next window")).toBeInTheDocument();
    expect(nextSignals).toHaveLength(2);
  });

  it("retries the current window when selecting the same remote track", async () => {
    let initialSignal: AbortSignal | undefined;
    const fetchWindow = vi
      .fn()
      .mockImplementation((_url: string, options: RequestInit) => {
        if (fetchWindow.mock.calls.length === 1) {
          initialSignal = options.signal as AbortSignal;
          return new Promise((_resolve, reject) => {
            initialSignal!.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          });
        }
        return Promise.resolve({
          ok: true,
          json: async () =>
            subtitleWindow(0, [
              { startMs: 0, endMs: 5_000, text: "Retry line" },
            ]),
        });
      });
    vi.stubGlobal("fetch", fetchWindow);
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
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("button", { name: "Czech" }));
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(2));
    expect(initialSignal?.aborted).toBe(true);
    expect(await screen.findByText("Retry line")).toBeInTheDocument();
  });

  it("ignores a late subtitle response after seeking to another window", async () => {
    let resolveOld!: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void;
    const fetchWindow = vi.fn().mockImplementation((url: string) => {
      if (url.includes("startMs=120000"))
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      const startMs = url.includes("startMs=240000") ? 240_000 : 0;
      return Promise.resolve({
        ok: true,
        json: async () =>
          subtitleWindow(
            startMs,
            startMs === 240_000
              ? [{ startMs: 239_000, endMs: 262_000, text: "Current line" }]
              : [],
          ),
      });
    });
    vi.stubGlobal("fetch", fetchWindow);
    render(
      <VideoPlayer
        api={api({
          getPlaybackManifest: vi.fn().mockResolvedValue({
            ...manifest,
            durationSeconds: 360,
          }),
        })}
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
    await waitFor(() => expect(fetchWindow).toHaveBeenCalledTimes(1));
    const seek = screen.getByRole("slider", { name: "Seek through video" });
    fireEvent.change(seek, { target: { value: "150" } });
    fireEvent.pointerUp(seek, { target: { value: "150" } });
    await waitFor(() => expect(resolveOld).toBeTypeOf("function"));
    const oldRequest = fetchWindow.mock.calls.find(([url]) =>
      (url as string).includes("startMs=120000"),
    );
    fireEvent.change(seek, { target: { value: "260" } });
    fireEvent.pointerUp(seek, { target: { value: "260" } });
    expect(await screen.findByText("Current line")).toBeInTheDocument();
    expect((oldRequest?.[1] as RequestInit).signal?.aborted).toBe(true);
    await act(async () => {
      resolveOld({
        ok: true,
        json: async () =>
          subtitleWindow(120_000, [
            { startMs: 150_000, endMs: 152_000, text: "Old line" },
          ]),
      });
      await Promise.resolve();
    });
    expect(screen.getByText("Current line")).toBeInTheDocument();
  });

  it("loads an external subtitle track from its manifest file ID", async () => {
    const fetchWindow = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        subtitleWindow(
          0,
          [{ startMs: 2_000, endMs: 4_000, text: "External line" }],
          "external:subtitle-7",
        ),
    });
    vi.stubGlobal("fetch", fetchWindow);
    render(
      <VideoPlayer
        api={api({
          getPlaybackManifest: vi.fn().mockResolvedValue({
            ...manifest,
            externalSubtitleTracks: [
              {
                fileId: "subtitle-7",
                filename: "Example.cs.srt",
                extension: "srt",
                language: "cs",
                forced: false,
                default: false,
                matchScore: 100,
                matchType: "language",
              },
            ],
          }),
        })}
        profileId="default"
        title={baseTitle}
        grant={grant}
        preferences={DEFAULT_PLAYBACK_PREFERENCES}
        onPlayEpisode={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: "Subtitles" });
    fireEvent.click(screen.getByRole("button", { name: "Subtitles" }));
    fireEvent.click(screen.getByRole("button", { name: "Example.cs.srt" }));
    await waitFor(() =>
      expect(fetchWindow).toHaveBeenCalledWith(
        `${grant.url}/subtitles/external/subtitle-7/window?startMs=0&durationMs=120000`,
        expect.objectContaining({ credentials: "same-origin" }),
      ),
    );
    const video = document.querySelector("video")!;
    video.currentTime = 2.5;
    fireEvent.timeUpdate(video);
    expect(await screen.findByText("External line")).toBeInTheDocument();
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
