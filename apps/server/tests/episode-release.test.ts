import type { SeriesStructure } from "@streamer-ai/contracts";
import { describe, expect, it } from "vitest";
import {
  absoluteEpisodeNumber,
  episodeSearchTerms,
  releaseEpisode,
} from "../src/services/episode-release.js";

const structure = {
  seasons: [
    {
      seasonNumber: 0,
      episodes: Array.from({ length: 10 }, (_, index) => ({
        episodeNumber: index + 1,
        title: `Special ${index + 1}`,
      })),
    },
    {
      seasonNumber: 1,
      episodes: [
        { episodeNumber: 1, title: "The Beginning" },
        { episodeNumber: 2, title: "The Road" },
        { episodeNumber: 3, title: "The Return" },
        { episodeNumber: 4, title: "The Dream" },
        { episodeNumber: 5, title: "The Heirs of the Dragon" },
      ],
    },
  ],
} as SeriesStructure;

describe("series release identity", () => {
  it("counts regular episodes continuously across seasons", () => {
    const regularSeasons = {
      seasons: [
        {
          seasonNumber: 1,
          episodes: Array.from({ length: 10 }, (_, index) => ({
            episodeNumber: index + 1,
            title: `Episode ${index + 1}`,
          })),
        },
        {
          seasonNumber: 2,
          episodes: Array.from({ length: 5 }, (_, index) => ({
            episodeNumber: index + 1,
            title: `Second Season ${index + 1}`,
          })),
        },
      ],
    } as SeriesStructure;
    expect(
      absoluteEpisodeNumber(regularSeasons, {
        seasonNumber: 2,
        episodeNumber: 5,
      }),
    ).toBe(15);
    expect(
      releaseEpisode(
        "Example.Show.Part.15.mkv",
        ["Example Show"],
        regularSeasons,
      ),
    ).toEqual({ seasonNumber: 2, episodeNumber: 5 });
  });

  it("maps the cumulative part number across seasons to one episode", () => {
    expect(
      absoluteEpisodeNumber(structure, { seasonNumber: 1, episodeNumber: 5 }),
    ).toBe(5);
    expect(
      releaseEpisode("Example.Show.Part.15.mkv", ["Example Show"], structure),
    ).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(
      releaseEpisode("15. Example Show.mkv", ["Example Show"], structure),
    ).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(
      releaseEpisode("Example.Show.5.mkv", ["Example Show"], structure),
    ).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
  });

  it("accepts explicit season notation and unique episode titles", () => {
    expect(
      releaseEpisode("Example.Show.S01E05.mkv", ["Example Show"], structure),
    ).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(
      releaseEpisode("Example.Show.1x05.mkv", ["Example Show"], structure),
    ).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(
      releaseEpisode(
        "Example.Show.77.The.Heirs.of.the.Dragon.mkv",
        ["Example Show"],
        structure,
      ),
    ).toEqual({ seasonNumber: 1, episodeNumber: 5 });
  });

  it("does not interpret the year or video quality as an episode", () => {
    expect(
      releaseEpisode(
        "Example.Show.2024.1080p.mkv",
        ["Example Show"],
        structure,
      ),
    ).toBeNull();
    expect(
      releaseEpisode("Unrelated.Movie.15.mkv", ["Example Show"], structure),
    ).toBeNull();
  });

  it("searches canonical, title, cumulative and local number variants", () => {
    expect(
      episodeSearchTerms({ seasonNumber: 1, episodeNumber: 5 }, structure),
    ).toEqual(["S01E05", "1x05", "The Heirs of the Dragon", "5", "15", "05"]);
  });
});
