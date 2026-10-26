import type { PlaybackPreferences } from "./onboarding.js";
import type { MediaSourcePreferences } from "./media-source-preferences.js";

export interface SourceSelectionEvidence {
  providerId: string;
  releaseName?: string;
  format?: {
    resolution?: string | null;
    audioLanguages?: readonly string[];
  };
  qualityVotes?: { positive: number; negative: number };
  supportsHttpRange?: boolean;
  directPlay?: boolean;
}

export interface SourceSelectionContext {
  title: string;
  originalTitle?: string | null;
  playback: Pick<
    PlaybackPreferences,
    "primaryAudioLanguage" | "secondaryAudioLanguage"
  >;
  displayHeight: number;
  preferences: MediaSourcePreferences;
}

const languageAliases: Record<string, string> = {
  ces: "cs",
  cze: "cs",
  cz: "cs",
  eng: "en",
  deu: "de",
  ger: "de",
  jpn: "ja",
  jap: "ja",
  slk: "sk",
  slo: "sk",
};

function language(value: string): string {
  const code = value.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return languageAliases[code] ?? code;
}

/** Unknown audio remains usable, but ranks below a known preferred language. */
export function sourceLanguageTier(
  source: SourceSelectionEvidence,
  playback: SourceSelectionContext["playback"],
): number {
  const audio = (source.format?.audioLanguages ?? [])
    .map(language)
    .filter((value) => value && value !== "und" && value !== "unknown");
  if (audio.includes(language(playback.primaryAudioLanguage))) return 3;
  if (audio.includes(language(playback.secondaryAudioLanguage))) return 2;
  return audio.length === 0 ? 1 : 0;
}

function normalizedWords(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export function sourceTitleFit(
  releaseName: string | undefined,
  title: string,
  originalTitle?: string | null,
): number {
  if (!releaseName) return 0;
  const release = normalizedWords(releaseName);
  const releaseSet = new Set(release);
  return Math.max(
    0,
    ...[title, originalTitle]
      .filter((value): value is string => Boolean(value))
      .map((alternative) => {
        const words = normalizedWords(alternative);
        if (words.length === 0) return 0;
        const coverage =
          words.filter((word) => releaseSet.has(word)).length / words.length;
        const exactPhrase = release.some((_, index) =>
          words.every((word, offset) => release[index + offset] === word),
        );
        return exactPhrase ? 1 : coverage * 0.9;
      }),
  );
}

/** Wilson lower bound: a single positive vote never receives the full 30 points. */
export function sourceRatingFraction(
  votes: SourceSelectionEvidence["qualityVotes"],
): number {
  if (!votes) return 0;
  const count = votes.positive + votes.negative;
  if (count === 0) return 0;
  const z = 1.96;
  const proportion = votes.positive / count;
  const zSquared = z * z;
  return Math.max(
    0,
    (proportion +
      zSquared / (2 * count) -
      z *
        Math.sqrt(
          (proportion * (1 - proportion) + zSquared / (4 * count)) / count,
        )) /
      (1 + zSquared / count),
  );
}

export function sourceResolutionFraction(
  resolution: string | null | undefined,
  displayHeight: number,
): number {
  const normalized = resolution?.toLowerCase() ?? "";
  const pixels =
    normalized.includes("4k") || normalized.includes("uhd")
      ? 2160
      : Number(/(\d{3,4})p?/.exec(normalized)?.[1] ?? 0);
  return Number.isFinite(displayHeight) && displayHeight > 0
    ? Math.min(1, pixels / displayHeight)
    : 0;
}

/** Score is 0–100: title fit 60, file ratings 30, device-capped resolution 10. */
export function sourceAutoScore(
  source: SourceSelectionEvidence,
  context: SourceSelectionContext,
): number {
  return (
    60 *
      sourceTitleFit(source.releaseName, context.title, context.originalTitle) +
    30 * sourceRatingFraction(source.qualityVotes) +
    10 *
      sourceResolutionFraction(source.format?.resolution, context.displayHeight)
  );
}

export function rankPlayableSources<T extends SourceSelectionEvidence>(
  sources: readonly T[],
  context: SourceSelectionContext,
): T[] {
  const { preferences } = context;
  const rank = (providerId: string) => {
    const index = preferences.providerOrder.indexOf(providerId);
    return index < 0 ? preferences.providerOrder.length : index;
  };
  return sources
    .filter(
      (source) =>
        (!preferences.requireSeeking || source.supportsHttpRange === true) &&
        (!preferences.requireDirectPlay || source.directPlay === true),
    )
    .sort(
      (a, b) =>
        (preferences.mode === "by-order"
          ? rank(a.providerId) - rank(b.providerId)
          : 0) ||
        sourceLanguageTier(b, context.playback) -
          sourceLanguageTier(a, context.playback) ||
        sourceAutoScore(b, context) - sourceAutoScore(a, context),
    );
}
