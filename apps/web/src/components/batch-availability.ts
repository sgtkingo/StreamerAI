import type { TitleDetail, TitleSource } from "@streamer-ai/contracts";
import type { StreamerApi } from "../api/client";
import { retryPlaybackCheck } from "./retry-playback-check";

const downloadable = (source: TitleSource) =>
  source.providerId === "webshare" &&
  /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i.test(source.releaseName);

/** Recheck unavailable episodes before choosing files for a user-started batch. */
export async function refreshMissingEpisodesForDownload(
  api: StreamerApi,
  profileId: string,
  initial: TitleDetail,
  seasonNumber?: number,
  stopped: () => boolean = () => false,
): Promise<TitleDetail> {
  let detail = initial;
  const missing =
    detail.series?.seasons
      .filter(
        (season) =>
          seasonNumber === undefined || season.seasonNumber === seasonNumber,
      )
      .flatMap((season) => season.episodes)
      .filter((episode) => episode.availability === "unavailable") ?? [];
  for (const episode of missing) {
    if (stopped()) break;
    const selection = {
      seasonNumber: episode.seasonNumber,
      episodeNumber: episode.episodeNumber,
    };
    try {
      const result = await retryPlaybackCheck(
        api,
        profileId,
        detail.title,
        selection,
      );
      if (!result.ready) continue;
      let sources = result.sources ?? [];
      if (sources.length === 0) {
        sources = (
          await api.forceEpisodeSearch(profileId, detail.title.id, selection)
        ).sources;
      }
      if (!sources.some(downloadable)) continue;
      const existing = result.detail ?? detail;
      detail = {
        ...existing,
        title: {
          ...existing.title,
          sources: [
            ...new Map(
              [...sources, ...(existing.title.sources ?? [])].map((source) => [
                source.id,
                source,
              ]),
            ).values(),
          ],
        },
        series: existing.series && {
          ...existing.series,
          seasons: existing.series.seasons.map((season) => ({
            ...season,
            episodes: season.episodes.map((candidate) =>
              candidate.seasonNumber === selection.seasonNumber &&
              candidate.episodeNumber === selection.episodeNumber
                ? { ...candidate, availability: "available" as const }
                : candidate,
            ),
          })),
        },
      };
    } catch {
      // One failed lookup does not stop the rest of the requested batch.
    }
  }
  return detail;
}
