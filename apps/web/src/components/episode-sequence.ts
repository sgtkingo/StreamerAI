import type {
  EpisodeSelection,
  SeriesEpisodeDetail,
} from "@streamer-ai/contracts";

function order(episode: EpisodeSelection): number {
  return episode.seasonNumber * 10_000 + episode.episodeNumber;
}

export function playableEpisodes(
  episodes: readonly SeriesEpisodeDetail[],
): SeriesEpisodeDetail[] {
  return episodes
    .filter((item) => item.availability === "available")
    .sort((left, right) => order(left) - order(right));
}

/** Keep missing aired episodes in sequence so playback can retry their sources. */
export function knownEpisodes(
  episodes: readonly SeriesEpisodeDetail[],
  today = new Date().toISOString().slice(0, 10),
): SeriesEpisodeDetail[] {
  return episodes
    .filter(
      (item) =>
        item.availability === "available" ||
        item.airDate === null ||
        item.airDate <= today,
    )
    .sort((left, right) => order(left) - order(right));
}

export function adjacentEpisode(
  episodes: readonly SeriesEpisodeDetail[],
  current: EpisodeSelection | undefined,
  direction: "next" | "previous",
): SeriesEpisodeDetail | undefined {
  if (!current) return undefined;
  const currentOrder = order(current);
  return direction === "next"
    ? episodes.find((item) => order(item) > currentOrder)
    : [...episodes].reverse().find((item) => order(item) < currentOrder);
}
