import { describe, expect, it } from "vitest";
import type {
  CatalogTitle,
  DiscoveryResponse,
  TitleSource,
} from "@streamer-ai/contracts";
import {
  groupDiscoveryResults,
  isDirectTitleMatch,
  mergeDiscoveryResults,
} from "./discovery-merge";

const format = {
  label: "1080p",
  container: "mkv",
  resolution: "1080p",
  videoCodec: "H.264",
  audioLanguages: ["en"],
  subtitleLanguages: [],
};
const source = (letter: string): TitleSource => ({
  id: letter.repeat(32),
  providerId: "webshare",
  candidateId: `file-${letter}`,
  releaseName: `Example.${letter}.mkv`,
  sizeBytes: 100,
  format,
  seasonNumber: null,
  episodeNumber: null,
  checkedAt: "2026-09-27T12:00:00.000Z",
});
const title: CatalogTitle = {
  id: "sai:tmdb:movie:1",
  kind: "movie",
  title: "Example",
  originalTitle: null,
  year: 2026,
  synopsis: "Example",
  posterUrl: null,
  backdropUrl: null,
  accentColor: "#334455",
  genres: [],
  ratings: [],
  matchPercent: 90,
  availability: "available",
  availabilityProvider: "webshare",
  availabilityCheckedAt: "2026-09-27T12:00:00.000Z",
  formats: [format],
  sources: [source("a")],
  seriesCoverage: null,
  metadataProvider: "tmdb",
  metadataValidatedAt: "2026-09-27T12:00:00.000Z",
  inLibrary: false,
  progressPercent: null,
};
const response = (
  bestMatch: DiscoveryResponse["bestMatch"],
): DiscoveryResponse => ({
  sessionId: "session-1",
  mode: "live",
  stage: "completed",
  reply: "Result",
  bestMatch,
  available: [],
  unavailable: [],
  unverified: [],
  warnings: [],
  completedAt: "2026-09-27T12:00:00.000Z",
});

describe("parallel discovery merge", () => {
  it("preserves the requested episode when quick and deep title results merge", () => {
    const series = {
      ...title,
      id: "sai:tmdb:series:42",
      kind: "series" as const,
      title: "Naruto",
      seriesCoverage: {
        seasonsAvailable: 1,
        seasonsTotal: 1,
        episodesAvailable: 1,
        episodesTotal: 1,
        complete: true,
        nextEpisodeLabel: "S01 E01",
      },
    };
    const quick = response({
      title: series,
      reason: "Episode found.",
      episode: { seasonNumber: 1, episodeNumber: 1 },
      episodeTitle: "Enter: Naruto Uzumaki!",
      episodeSynopsis: "Naruto begins his journey.",
    });
    const merged = mergeDiscoveryResults(
      quick,
      response({ title: series, reason: "Series found." }),
      "Naruto S01E01",
    );
    expect(merged.bestMatch?.episode).toEqual({
      seasonNumber: 1,
      episodeNumber: 1,
    });
    expect(merged.bestMatch?.episodeSynopsis).toBe(
      "Naruto begins his journey.",
    );
    expect(isDirectTitleMatch("Naruto S01E01", merged.bestMatch!)).toBe(true);
    expect(isDirectTitleMatch("Naruto S01E02", merged.bestMatch!)).toBe(false);
    expect(
      isDirectTitleMatch("Naruto S01E01", {
        title: series,
        reason: "Series found.",
      }),
    ).toBe(false);
  });

  it("keeps the requested episode and its synopsis together when another episode merges", () => {
    const series = {
      ...title,
      id: "sai:tmdb:series:42",
      kind: "series" as const,
      title: "Naruto",
    };
    const quick = response({
      title: series,
      reason: "Requested episode.",
      episode: { seasonNumber: 1, episodeNumber: 1 },
      episodeTitle: "Episode One",
      episodeSynopsis: "Story for episode one.",
    });
    const deep = response({
      title: series,
      reason: "Another episode.",
      episode: { seasonNumber: 1, episodeNumber: 2 },
      episodeTitle: "Episode Two",
      episodeSynopsis: "Story for episode two.",
    });
    const merged = mergeDiscoveryResults(quick, deep, "Naruto S01E01");
    expect(merged.bestMatch?.episode).toEqual({
      seasonNumber: 1,
      episodeNumber: 1,
    });
    expect(merged.bestMatch?.episodeTitle).toBe("Episode One");
    expect(merged.bestMatch?.episodeSynopsis).toBe("Story for episode one.");
  });

  it("keeps a verified quick stream when deep availability is weaker", () => {
    const quick = response({ title, reason: "Quick" });
    const deep: DiscoveryResponse = {
      ...response(null),
      unavailable: [
        {
          title: {
            ...title,
            availability: "unavailable",
            formats: [],
            sources: [],
          },
          reason: "Deep unavailable",
        },
      ],
    };
    const merged = mergeDiscoveryResults(quick, deep);
    expect(merged.bestMatch?.title.availability).toBe("available");
    expect(merged.bestMatch?.reason).toBe("Deep unavailable");
    expect(merged.unavailable).toHaveLength(0);
  });

  it("shows one canonical tile with sources from both streams", () => {
    const quick = response({ title, reason: "Quick" });
    const deep = response({
      title: { ...title, sources: [source("b")] },
      reason: "Deep",
    });
    const merged = mergeDiscoveryResults(quick, deep);
    expect(merged.bestMatch?.reason).toBe("Deep");
    expect(
      merged.bestMatch?.title.sources?.map((item) => item.candidateId),
    ).toEqual(["file-b", "file-a"]);
    expect(merged.available).toHaveLength(0);
  });

  it("keeps an exact-title quick hit above a higher-scored but wrong agent suggestion", () => {
    const panTau = {
      ...title,
      id: "sai:tmdb:tv:pan-tau",
      kind: "series" as const,
      title: "Pan Tau",
      matchPercent: 84,
      seriesCoverage: {
        seasonsAvailable: 1,
        seasonsTotal: 1,
        episodesAvailable: 1,
        episodesTotal: 1,
        complete: true,
        nextEpisodeLabel: null,
      },
    };
    const wrongAgentSuggestion = {
      ...title,
      id: "sai:tmdb:movie:unrelated",
      title: "The Magic Hat",
      matchPercent: 99,
    };
    const quick = response({ title: panTau, reason: "Exact title match." });
    const deep = response({
      title: wrongAgentSuggestion,
      reason: "Agent interpretation.",
    });

    const merged = mergeDiscoveryResults(quick, deep, "Pan Tau");

    expect(merged.bestMatch?.title.id).toBe(panTau.id);
    expect(merged.available.map((item) => item.title.id)).toEqual([
      wrongAgentSuggestion.id,
    ]);
  });

  it("keeps a contextual agent match first for a descriptive mood query", () => {
    const quickTitle = {
      ...title,
      id: "sai:tmdb:movie:quick",
      title: "Autumn Leaves",
      matchPercent: 98,
    };
    const contextualTitle = {
      ...title,
      id: "sai:tmdb:movie:contextual",
      title: "A Quiet September",
      matchPercent: 78,
    };

    const merged = mergeDiscoveryResults(
      response({ title: quickTitle, reason: "Quick candidate." }),
      response({ title: contextualTitle, reason: "Fits the stated mood." }),
      "a gentle autumn film to watch with the family",
    );

    expect(merged.bestMatch?.title.id).toBe(contextualTitle.id);
    expect(merged.available.map((item) => item.title.id)).toEqual([
      quickTitle.id,
    ]);
  });

  it("does not feature an unrelated agent title while an exact lookup is still checking", () => {
    const exact = {
      ...title,
      id: "sai:tmdb:movie:pan-tau",
      title: "Pan Tau",
      availability: "unknown" as const,
      formats: [],
      sources: [],
    };
    const merged = mergeDiscoveryResults(
      {
        ...response(null),
        unverified: [{ title: exact, reason: "Exact match." }],
      },
      response({ title, reason: "Agent guess." }),
      "Pan Tau",
    );

    const pending = groupDiscoveryResults(merged, () => "checking", "Pan Tau");
    expect(pending.bestMatch).toBeNull();
    expect(pending.checking.map((item) => item.title.title)).toEqual([
      "Pan Tau",
    ]);
    expect(pending.available.map((item) => item.title.title)).toEqual([
      "Example",
    ]);

    const checked = groupDiscoveryResults(
      merged,
      (item) => (item.title.title === "Pan Tau" ? "ready" : "checking"),
      "Pan Tau",
    );
    expect(checked.bestMatch?.title.title).toBe("Pan Tau");
  });
});
