import { describe, expect, it } from "vitest";
import type { SeriesEpisodeDetail } from "@streamer-ai/contracts";
import {
  adjacentEpisode,
  knownEpisodes,
  playableEpisodes,
} from "./episode-sequence";

const episode = (
  seasonNumber: number,
  episodeNumber: number,
  availability: SeriesEpisodeDetail["availability"] = "available",
): SeriesEpisodeDetail => ({
  seasonNumber,
  episodeNumber,
  title: `Episode ${episodeNumber}`,
  airDate: null,
  availability,
});

describe("episode succession", () => {
  it("tries the missing next episode before later playable episodes", () => {
    const episodes = knownEpisodes([
      episode(1, 3),
      episode(1, 2, "unavailable"),
      episode(1, 1),
    ]);
    expect(
      adjacentEpisode(episodes, { seasonNumber: 1, episodeNumber: 1 }, "next")
        ?.episodeNumber,
    ).toBe(2);
  });
  it("finds the next playable episode even when current is absent from refreshed detail", () => {
    const episodes = playableEpisodes([
      episode(2, 1),
      episode(1, 3, "unavailable"),
      episode(1, 2),
    ]);
    expect(
      adjacentEpisode(episodes, { seasonNumber: 1, episodeNumber: 1 }, "next")
        ?.episodeNumber,
    ).toBe(2);
    expect(
      adjacentEpisode(
        episodes,
        { seasonNumber: 2, episodeNumber: 1 },
        "previous",
      )?.episodeNumber,
    ).toBe(2);
  });
});
