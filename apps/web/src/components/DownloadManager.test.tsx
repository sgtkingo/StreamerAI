import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CatalogTitle, TitleDetail, TitleSource } from "@streamer-ai/contracts";
import type { OfflineDownload, StreamerApi } from "../api/client";
import { DownloadProvider, useDownloadManager } from "./DownloadManager";
import { ToastProvider } from "./ToastProvider";

const source = (episodeNumber: number): TitleSource => ({
  id: `source-${episodeNumber}`,
  providerId: "webshare",
  candidateId: `file-${episodeNumber}`,
  releaseName: `Episode.${episodeNumber}.mkv`,
  sizeBytes: 100,
  format: {
    label: "1080p",
    container: "mkv",
    resolution: "1080p",
    videoCodec: "H.264",
    audioLanguages: ["en"],
    subtitleLanguages: [],
  },
  seasonNumber: 1,
  episodeNumber,
  checkedAt: "2026-09-29T20:00:00.000Z",
});

const title = {
  id: "sai:tmdb:series:42",
  kind: "series",
  title: "Sample Show",
  originalTitle: null,
  year: 2021,
  synopsis: "",
  accentColor: "#664466",
  genres: [],
  ratings: [],
  matchPercent: null,
  availability: "available",
  availabilityProvider: "webshare",
  availabilityCheckedAt: "2026-09-29T20:00:00.000Z",
  formats: [],
  seriesCoverage: {
    seasonsAvailable: 1,
    seasonsTotal: 1,
    episodesAvailable: 2,
    episodesTotal: 2,
    complete: true,
    nextEpisodeLabel: "S01 E01",
  },
  metadataProvider: "tmdb",
  metadataValidatedAt: "2026-09-29T20:00:00.000Z",
  backdropUrl: null,
  posterUrl: null,
  inLibrary: true,
  progressPercent: null,
  sources: [source(1), source(2)],
} satisfies CatalogTitle;

const detail: TitleDetail = {
  title,
  related: [],
  series: {
    status: "complete",
    seasons: [{
      seasonNumber: 1,
      title: "Season One",
      episodes: [1, 2].map((episodeNumber) => ({
        seasonNumber: 1,
        episodeNumber,
        title: `Episode ${episodeNumber}`,
        airDate: null,
        availability: "available" as const,
      })),
    }],
  },
};

function Controls() {
  const manager = useDownloadManager()!;
  return <>
    <button onClick={() => manager.activateBatch(title)}>Start series</button>
    <button onClick={() => manager.activateBatch(title, 1)}>Start season</button>
    <button onClick={() => manager.stopBatch(title.id)}>Stop series</button>
    <span data-testid="season-status">{manager.batches[`${title.id}:1`]?.status}</span>
    <span data-testid="regular-available">{manager.batchFor(title).available}</span>
  </>;
}

describe("DownloadProvider", () => {
  it("leaves specials out of a whole-series download", async () => {
    const user = userEvent.setup();
    const special: TitleSource = {
      ...source(1),
      id: "special-source",
      seasonNumber: 0,
      releaseName: "Special.S00E01.mkv",
    };
    const withSpecials: TitleDetail = {
      ...detail,
      title: { ...title, sources: [special, ...(title.sources ?? [])] },
      series: {
        ...detail.series!,
        seasons: [
          {
            seasonNumber: 0,
            title: "Specials",
            episodes: [{
              seasonNumber: 0,
              episodeNumber: 1,
              title: "Bonus",
              airDate: null,
              availability: "unavailable",
            }],
          },
          ...detail.series!.seasons,
        ],
      },
    };
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue(withSpecials),
      getOfflineDownloads: vi.fn().mockResolvedValue({ items: [] }),
      getLocalFolders: vi.fn().mockResolvedValue({ roots: [{ id: "root-1", path: "D:\\Downloads" }] }),
      checkPlayback: vi.fn(),
    } as unknown as StreamerApi;
    render(<ToastProvider><DownloadProvider api={api} profileId="default"><Controls /></DownloadProvider></ToastProvider>);

    await user.click(screen.getByRole("button", { name: "Start series" }));
    expect(await screen.findByRole("button", { name: "Download 2 files" })).toBeInTheDocument();
    expect(screen.getByTestId("regular-available")).toHaveTextContent("2");
    expect(api.checkPlayback).not.toHaveBeenCalled();
  });

  it("stops a season download from the series control and does not start the next episode", async () => {
    const user = userEvent.setup();
    let cancelled = false;
    let started = false;
    const job: OfflineDownload = {
      id: "job-1",
      profileId: "default",
      titleId: title.id,
      sourceId: source(1).id,
      rootId: "root-1",
      state: "downloading",
      bytes: 0,
      totalBytes: 100,
      error: null,
    };
    const api = {
      getTitleDetail: vi.fn().mockResolvedValue(detail),
      getOfflineDownloads: vi.fn().mockImplementation(async () => ({
        items: !started ? [] : cancelled ? [{ ...job, state: "cancelled" }] : [job],
      })),
      getLocalFolders: vi.fn().mockResolvedValue({
        roots: [{ id: "root-1", path: "D:\\Downloads" }],
      }),
      startOfflineDownload: vi.fn().mockImplementation(async () => {
        started = true;
        return job;
      }),
      cancelOfflineDownload: vi.fn().mockImplementation(async () => {
        cancelled = true;
      }),
    } as unknown as StreamerApi;
    render(<ToastProvider><DownloadProvider api={api} profileId="default"><Controls /></DownloadProvider></ToastProvider>);

    await user.click(screen.getByRole("button", { name: "Start season" }));
    await user.click(await screen.findByRole("button", { name: "Download 2 files" }));
    await waitFor(() => expect(api.startOfflineDownload).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Stop series" }));

    await waitFor(() => expect(api.cancelOfflineDownload).toHaveBeenCalledWith("default", job.id));
    await waitFor(() => expect(screen.getByTestId("season-status")).toHaveTextContent("stopped"));
    expect(api.startOfflineDownload).toHaveBeenCalledTimes(1);
  });
});
