import type { DiscoveryResponse, RankedTitle } from "@streamer-ai/contracts";

function entries(result: DiscoveryResponse): RankedTitle[] {
  return [
    ...(result.bestMatch ? [result.bestMatch] : []),
    ...result.available,
    ...result.unavailable,
    ...result.unverified,
  ];
}

function streamable(item: RankedTitle): boolean {
  return (
    item.title.availability === "available" ||
    item.title.availability === "partial"
  );
}

function normalizeTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A direct title lookup is stronger evidence than an agent's thematic score. */
export function isDirectTitleMatch(query: string, item: RankedTitle): boolean {
  const normalizedInput = normalizeTitle(query);
  const episodeMatch = / (?:s(\d{1,2})e(\d{1,3})|(\d{1,2})x(\d{1,3}))$/.exec(
    normalizedInput,
  );
  if (
    episodeMatch &&
    (!item.episode ||
      item.episode.seasonNumber !==
        Number(episodeMatch[1] ?? episodeMatch[3]) ||
      item.episode.episodeNumber !== Number(episodeMatch[2] ?? episodeMatch[4]))
  )
    return false;
  const normalizedQuery = normalizedInput.replace(
    / (?:s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/,
    "",
  );
  if (!normalizedQuery) return false;
  const possibleTitles = [item.title.title, item.title.originalTitle]
    .filter((title): title is string => Boolean(title))
    .map(normalizeTitle);
  const releaseYear = item.title.year;
  return possibleTitles.some(
    (title) =>
      normalizedQuery === title ||
      (releaseYear !== null && normalizedQuery === `${title} ${releaseYear}`),
  );
}

/** Verified streams survive conflicting availability; direct title lookups win exact matches. */
export function mergeDiscoveryResults(
  quick: DiscoveryResponse,
  deep: DiscoveryResponse,
  query = "",
): DiscoveryResponse {
  const quickIds = new Set(entries(quick).map((item) => item.title.id));
  const deepIds = new Set(entries(deep).map((item) => item.title.id));
  const episodeMatch =
    /(?:^| )(?:s(\d{1,2})e(\d{1,3})|(\d{1,2})x(\d{1,3}))$/.exec(
      normalizeTitle(query),
    );
  const requestedEpisode = episodeMatch
    ? {
        seasonNumber: Number(episodeMatch[1] ?? episodeMatch[3]),
        episodeNumber: Number(episodeMatch[2] ?? episodeMatch[4]),
      }
    : null;
  const byId = new Map<string, RankedTitle>();
  for (const item of entries(quick)) byId.set(item.title.id, item);
  for (const item of entries(deep)) {
    const prior = byId.get(item.title.id);
    if (!prior) {
      byId.set(item.title.id, item);
      continue;
    }
    const chosen = streamable(item) || !streamable(prior) ? item : prior;
    const other = chosen === item ? prior : item;
    const episodeResult =
      [chosen, other].find(
        (candidate) =>
          requestedEpisode &&
          candidate.episode?.seasonNumber === requestedEpisode.seasonNumber &&
          candidate.episode.episodeNumber === requestedEpisode.episodeNumber,
      ) ?? (chosen.episode ? chosen : other);
    const remainingResult = episodeResult === chosen ? other : chosen;
    const sameEpisode =
      episodeResult.episode?.seasonNumber ===
        remainingResult.episode?.seasonNumber &&
      episodeResult.episode?.episodeNumber ===
        remainingResult.episode?.episodeNumber;
    const sources = [
      ...(chosen.title.sources ?? []),
      ...(other.title.sources ?? []),
    ]
      .filter(
        (source, index, all) =>
          all.findIndex((candidate) => candidate.id === source.id) === index,
      )
      .slice(0, 24);
    byId.set(item.title.id, {
      ...chosen,
      reason: item.reason,
      episode: episodeResult.episode,
      episodeTitle:
        episodeResult.episodeTitle ??
        (sameEpisode ? remainingResult.episodeTitle : undefined),
      episodeSynopsis:
        episodeResult.episodeSynopsis ??
        (sameEpisode ? remainingResult.episodeSynopsis : undefined),
      title: {
        ...chosen.title,
        ...(chosen.title.sources || other.title.sources ? { sources } : {}),
      },
    });
  }
  const exactQuickIds = new Set(
    [...byId.values()]
      .filter(
        (item) =>
          quickIds.has(item.title.id) && isDirectTitleMatch(query, item),
      )
      .map((item) => item.title.id),
  );
  const ranked = [...byId.values()]
    .map((item) =>
      exactQuickIds.has(item.title.id)
        ? { ...item, title: { ...item.title, matchPercent: 100 } }
        : item,
    )
    .sort((a, b) => {
      const exactDifference =
        Number(exactQuickIds.has(b.title.id)) -
        Number(exactQuickIds.has(a.title.id));
      if (exactDifference) return exactDifference;
      const deepDifference =
        Number(deepIds.has(b.title.id)) - Number(deepIds.has(a.title.id));
      if (deepDifference) return deepDifference;
      return (b.title.matchPercent ?? 0) - (a.title.matchPercent ?? 0);
    });
  const available = ranked.filter(streamable);
  const first = available.shift() ?? null;
  const highestScore = Math.max(
    0,
    ...ranked.map((item) => item.title.matchPercent ?? 0),
  );
  const bestMatch =
    first && (first.title.matchPercent ?? 0) < highestScore
      ? {
          ...first,
          title: { ...first.title, matchPercent: highestScore },
        }
      : first;
  return {
    ...deep,
    bestMatch,
    available,
    unavailable: ranked.filter(
      (item) => item.title.availability === "unavailable",
    ),
    unverified: ranked.filter((item) => item.title.availability === "unknown"),
    warnings: [...new Set([...quick.warnings, ...deep.warnings])].slice(0, 20),
  };
}

export type PlaybackCheckStatus = "checking" | "ready" | "failed" | undefined;

export interface DiscoveryDisplayGroups {
  bestMatch: RankedTitle | null;
  available: RankedTitle[];
  checking: RankedTitle[];
  unavailable: RankedTitle[];
}

/** Playback probes are fresher than discovery's bounded media inspection. */
export function groupDiscoveryResults(
  result: DiscoveryResponse,
  statusFor: (item: RankedTitle) => PlaybackCheckStatus,
  query = "",
): DiscoveryDisplayGroups {
  const available: RankedTitle[] = [];
  const checking: RankedTitle[] = [];
  const unavailable: RankedTitle[] = [];
  const ranked = entries(result).sort(
    (a, b) =>
      Number(isDirectTitleMatch(query, b)) -
      Number(isDirectTitleMatch(query, a)),
  );
  for (const item of ranked) {
    const status = result.mode === "live" ? statusFor(item) : undefined;
    if (status === "ready") {
      available.push(item);
    } else if (status === "failed") {
      if (item.title.kind === "series" && streamable(item))
        available.push(item);
      else unavailable.push(item);
    } else if (streamable(item)) {
      available.push(item);
    } else if (result.mode === "live") {
      checking.push(item);
    } else if (item.title.availability === "unknown") {
      checking.push(item);
    } else {
      unavailable.push(item);
    }
  }
  const hasDirectMatch = ranked.some((item) => isDirectTitleMatch(query, item));
  const bestIndex = hasDirectMatch
    ? available.findIndex((item) => isDirectTitleMatch(query, item))
    : available.length > 0
      ? 0
      : -1;
  return {
    bestMatch:
      bestIndex >= 0 ? (available.splice(bestIndex, 1)[0] ?? null) : null,
    available,
    checking,
    unavailable,
  };
}
