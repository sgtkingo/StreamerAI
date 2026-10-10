import type {
  CatalogTitle,
  RankedTitle,
  DiscoveryResponse,
} from "@streamer-ai/contracts";

export function normalizeWatchedTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function requestsUnseenTitles(message: string): boolean {
  const text = normalizeWatchedTitle(message);
  return (
    /\b(nevidel|nevidela|nevideli|nevidene|nevideny|nezhlednute|nezhlednuteho)\b/.test(
      text,
    ) ||
    /\b(haven t seen|have not seen|never seen|unseen|not watched|haven t watched)\b/.test(
      text,
    ) ||
    /\b(noch nicht gesehen|ungesehen)\b/.test(text)
  );
}

export function watchedTitlesFromReply(message: string): string[] {
  return message
    .replace(
      /^(?:(?:u\u017e|uz)\s+)?(?:jsem\s+)?(?:vid[e\u011b]l(?:a)?\s+(?:jsem\s+)?)?(?:tyto\s+)?(?:filmy|seri\u00e1ly|serialy|tituly)?\s*[:-]?\s*/iu,
      "",
    )
    .replace(
      /^(?:i(?:'ve| have) seen|i(?:'ve| have) watched|already seen|already watched)\s*[:-]?\s*/iu,
      "",
    )
    .split(/[,;\n\u2022]+/u)
    .map((title) =>
      title
        .trim()
        .replace(/^[-*\d.)\s]+/u, "")
        .trim(),
    )
    .filter((title) => title.length > 0 && title.length <= 240);
}

export interface UnseenExclusions {
  readonly titleIds: readonly string[];
  readonly titles: readonly string[];
}

export function excludeWatchedTitles(
  response: DiscoveryResponse,
  exclusions: UnseenExclusions,
): DiscoveryResponse {
  const ids = new Set(exclusions.titleIds);
  const names = new Set(exclusions.titles.map(normalizeWatchedTitle));
  const isNew = (item: RankedTitle) => {
    const title: CatalogTitle = item.title;
    return (
      !ids.has(title.id) &&
      !names.has(normalizeWatchedTitle(title.title)) &&
      (title.originalTitle === null ||
        !names.has(normalizeWatchedTitle(title.originalTitle)))
    );
  };
  const available = response.available.filter(isNew);
  let bestMatch =
    response.bestMatch && isNew(response.bestMatch)
      ? response.bestMatch
      : (available.shift() ?? null);
  const unavailable = response.unavailable.filter(isNew);
  const unverified = response.unverified.filter(isNew);
  const highestScore = Math.max(
    0,
    ...available.map((item) => item.title.matchPercent ?? 0),
    ...unavailable.map((item) => item.title.matchPercent ?? 0),
    ...unverified.map((item) => item.title.matchPercent ?? 0),
  );
  if (bestMatch && (bestMatch.title.matchPercent ?? 0) < highestScore) {
    bestMatch = {
      ...bestMatch,
      title: { ...bestMatch.title, matchPercent: highestScore },
    };
  }
  return {
    ...response,
    bestMatch,
    available,
    unavailable,
    unverified,
  };
}
