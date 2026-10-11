import { describe, expect, it, vi } from "vitest";
import type { TitleDetail, TitleSource } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { refreshMissingEpisodesForDownload } from "./batch-availability";

const source = {
  id: "a".repeat(32),
  providerId: "webshare",
  candidateId: "candidate-1",
  releaseName: "Series.S01E02.mkv",
  seasonNumber: 1,
  episodeNumber: 2,
} as TitleSource;
const detail = {
  title: { id: "series-1", kind: "series", sources: [] },
  related: [],
  series: {
    status: "unavailable",
    seasons: [
      {
        seasonNumber: 1,
        title: "Season 1",
        episodes: [
          { seasonNumber: 1, episodeNumber: 2, availability: "unavailable" },
        ],
      },
    ],
  },
} as unknown as TitleDetail;

describe("refreshMissingEpisodesForDownload", () => {
  it("checks a missing episode and includes a newly found download source", async () => {
    const api = {
      checkPlayback: vi
        .fn()
        .mockRejectedValueOnce(new Error("missing"))
        .mockResolvedValueOnce({ ok: true }),
      forceEpisodeSearch: vi
        .fn()
        .mockResolvedValue({ detail, sources: [source] }),
    } as unknown as StreamerApi;

    const refreshed = await refreshMissingEpisodesForDownload(
      api,
      "profile-1",
      detail,
    );
    expect(api.forceEpisodeSearch).toHaveBeenCalledWith(
      "profile-1",
      "series-1",
      { seasonNumber: 1, episodeNumber: 2 },
    );
    expect(refreshed.series?.seasons[0]?.episodes[0]?.availability).toBe(
      "available",
    );
    expect(refreshed.title.sources).toContainEqual(source);
  });
});
