import { describe, expect, it } from "vitest";
import {
  rankPlayableSources,
  sourceAutoScore,
  sourceRatingFraction,
  sourceResolutionFraction,
  type SourceSelectionContext,
} from "../src/index.js";

const context: SourceSelectionContext = {
  title: "Naruto Shippuden",
  originalTitle: null,
  playback: {
    primaryAudioLanguage: "cs",
    secondaryAudioLanguage: "en",
  },
  displayHeight: 1080,
  preferences: {
    mode: "auto",
    providerOrder: ["local-files", "webshare"],
    requireSeeking: false,
    requireDirectPlay: false,
  },
};

describe("source selection", () => {
  it("ranks preferred audio above a higher scoring source", () => {
    const sources = [
      {
        providerId: "webshare",
        releaseName: "Naruto.Shippuden.S01E01.1080p.mkv",
        format: { resolution: "1080p", audioLanguages: ["ja"] },
        qualityVotes: { positive: 100, negative: 0 },
      },
      {
        providerId: "local-files",
        releaseName: "Naruto.Shippuden.S01E01.720p.mkv",
        format: { resolution: "720p", audioLanguages: ["cs"] },
      },
    ];
    expect(sourceAutoScore(sources[0]!, context)).toBeGreaterThan(
      sourceAutoScore(sources[1]!, context),
    );
    expect(rankPlayableSources(sources, context)[0]).toBe(sources[1]);
  });

  it("uses progressive file votes and gives unrated sources zero rating points", () => {
    expect(sourceRatingFraction(undefined)).toBe(0);
    expect(sourceRatingFraction({ positive: 0, negative: 0 })).toBe(0);
    const one = sourceRatingFraction({ positive: 1, negative: 0 });
    const ten = sourceRatingFraction({ positive: 10, negative: 0 });
    const hundred = sourceRatingFraction({ positive: 100, negative: 0 });
    expect(one).toBeGreaterThan(0);
    expect(one).toBeLessThan(ten);
    expect(ten).toBeLessThan(hundred);
    expect(hundred).toBeLessThan(1);
  });

  it("caps resolution at device height", () => {
    expect(sourceResolutionFraction("720p", 1080)).toBeCloseTo(2 / 3);
    expect(sourceResolutionFraction("1080p", 1080)).toBe(1);
    expect(sourceResolutionFraction("2160p", 1080)).toBe(1);
    expect(sourceResolutionFraction("1080p", 2160)).toBe(0.5);
  });

  it("applies capability filters and provider order before language in By Order", () => {
    const sources = [
      {
        providerId: "local-files",
        releaseName: "Naruto.Shippuden.S01E01.720p.mkv",
        format: { resolution: "720p", audioLanguages: ["cs"] },
        supportsHttpRange: false,
        directPlay: true,
      },
      {
        providerId: "webshare",
        releaseName: "Naruto.Shippuden.S01E01.1080p.mkv",
        format: { resolution: "1080p", audioLanguages: ["cs"] },
        supportsHttpRange: true,
        directPlay: true,
      },
    ];
    expect(
      rankPlayableSources(sources, {
        ...context,
        preferences: { ...context.preferences, mode: "by-order" },
      })[0],
    ).toBe(sources[0]);
    expect(
      rankPlayableSources(
        [
          {
            ...sources[0]!,
            format: { ...sources[0]!.format, audioLanguages: ["ja"] },
          },
          sources[1]!,
        ],
        {
          ...context,
          preferences: { ...context.preferences, mode: "by-order" },
        },
      )[0],
    ).toMatchObject({ providerId: "local-files" });
    expect(
      rankPlayableSources(sources, {
        ...context,
        preferences: {
          ...context.preferences,
          mode: "by-order",
          requireSeeking: true,
        },
      }),
    ).toEqual([sources[1]]);
  });
});
