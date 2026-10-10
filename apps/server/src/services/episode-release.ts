import type { EpisodeSelection, SeriesStructure } from "@streamer-ai/contracts";

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function orderedEpisodes(
  structure: SeriesStructure,
  includeSpecials = false,
): EpisodeSelection[] {
  const seasons = includeSpecials
    ? structure.seasons
    : structure.seasons.some((season) => season.seasonNumber > 0)
      ? structure.seasons.filter((season) => season.seasonNumber > 0)
      : structure.seasons;
  return [...seasons]
    .sort((a, b) => a.seasonNumber - b.seasonNumber)
    .flatMap((season) =>
      [...season.episodes]
        .sort((a, b) => a.episodeNumber - b.episodeNumber)
        .map((episode) => ({
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        })),
    );
}

export function absoluteEpisodeNumber(
  structure: SeriesStructure | undefined,
  selected: EpisodeSelection,
): number | null {
  if (!structure) return null;
  const index = orderedEpisodes(structure).findIndex(
    (episode) =>
      episode.seasonNumber === selected.seasonNumber &&
      episode.episodeNumber === selected.episodeNumber,
  );
  return index < 0 ? null : index + 1;
}

export function episodeSearchTerms(
  selected: EpisodeSelection,
  structure?: SeriesStructure,
): string[] {
  const season = selected.seasonNumber;
  const episode = selected.episodeNumber;
  const title = structure?.seasons
    .find((item) => item.seasonNumber === season)
    ?.episodes.find((item) => item.episodeNumber === episode)?.title;
  const absolute = absoluteEpisodeNumber(structure, selected);
  const withSpecials = structure
    ? orderedEpisodes(structure, true).findIndex(
        (item) =>
          item.seasonNumber === season && item.episodeNumber === episode,
      ) + 1
    : 0;
  const terms = [
    `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    `${season}x${String(episode).padStart(2, "0")}`,
    ...(title &&
    !/^(?:episode|ep|dil|part|cast)\s*\d+$/i.test(normalized(title))
      ? [title]
      : []),
    ...(absolute !== null && absolute !== episode ? [String(absolute)] : []),
    String(episode),
    ...(withSpecials > 0 &&
    withSpecials !== absolute &&
    withSpecials !== episode
      ? [String(withSpecials)]
      : []),
    ...(episode < 10 ? [String(episode).padStart(2, "0")] : []),
  ];
  return [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
}

export function explicitEpisodeNumber(
  releaseName: string,
): EpisodeSelection | null {
  const searchable = normalized(releaseName);
  const match =
    /(?:^| )s(\d{1,2}) *e(\d{1,3})(?: |$)/.exec(searchable) ??
    /(?:^| )(\d{1,2})x(\d{1,3})(?: |$)/.exec(searchable) ??
    /(?:^| )(?:season|series|serie|rada) +(\d{1,2}) +(?:episode|ep|dil|part|cast) +(\d{1,3})(?: |$)/.exec(
      searchable,
    );
  if (!match?.[1] || !match[2]) return null;
  const episodeNumber = Number(match[2]);
  return episodeNumber > 0
    ? { seasonNumber: Number(match[1]), episodeNumber }
    : null;
}

function adjacentNumber(
  releaseName: string,
  seriesTitles: string[],
): number | null {
  const words = normalized(releaseName.replace(/\.[a-z0-9]{2,5}$/i, "")).split(
    " ",
  );
  for (const title of seriesTitles) {
    const titleWords = normalized(title).split(" ");
    if (titleWords.length === 0 || titleWords[0] === "") continue;
    for (let index = 0; index <= words.length - titleWords.length; index++) {
      if (!titleWords.every((word, offset) => words[index + offset] === word))
        continue;
      const neighboring = [words[index + titleWords.length], words[index - 1]];
      for (const value of neighboring) {
        if (value && /^\d{1,3}$/.test(value) && Number(value) > 0)
          return Number(value);
      }
    }
  }
  return null;
}

function numberedPart(
  releaseName: string,
  seriesTitles: string[],
): number | null {
  const match = /(?:^| )(?:episode|ep|dil|part|cast) +(\d{1,3})(?: |$)/.exec(
    normalized(releaseName),
  );
  return match?.[1]
    ? Number(match[1])
    : adjacentNumber(releaseName, seriesTitles);
}

function titleIdentifiedEpisode(
  releaseName: string,
  seriesTitles: string[],
  structure: SeriesStructure,
): EpisodeSelection | null {
  const release = ` ${normalized(releaseName)} `;
  const counts = new Map<string, number>();
  for (const season of structure.seasons) {
    for (const episode of season.episodes) {
      const title = normalized(episode.title);
      counts.set(title, (counts.get(title) ?? 0) + 1);
    }
  }
  const matches = structure.seasons.flatMap((season) =>
    season.episodes.flatMap((episode) => {
      const title = normalized(episode.title);
      if (
        title.length < 4 ||
        !/[a-z]{4}/.test(title) ||
        /^(?:episode|ep|dil|part|cast) \d+$/.test(title) ||
        seriesTitles.some((name) => normalized(name) === title) ||
        counts.get(title) !== 1 ||
        !release.includes(` ${title} `)
      )
        return [];
      return [
        {
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        },
      ];
    }),
  );
  return matches.length === 1 ? matches[0]! : null;
}

export function releaseEpisode(
  releaseName: string,
  seriesTitles: string[],
  structure?: SeriesStructure,
): EpisodeSelection | null {
  const explicit = explicitEpisodeNumber(releaseName);
  if (explicit) return explicit;
  if (!structure) return null;
  const release = ` ${normalized(releaseName)} `;
  if (
    !seriesTitles.some((title) => {
      const name = normalized(title);
      return name !== "" && release.includes(` ${name} `);
    })
  )
    return null;
  const byTitle = titleIdentifiedEpisode(releaseName, seriesTitles, structure);
  if (byTitle) return byTitle;
  const number = numberedPart(releaseName, seriesTitles);
  return number === null
    ? null
    : (orderedEpisodes(structure)[number - 1] ??
        orderedEpisodes(structure, true)[number - 1] ??
        null);
}
