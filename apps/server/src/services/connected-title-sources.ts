import { CatalogTitleSchema, type CatalogTitle } from "@streamer-ai/contracts";

/** Viewer projection only: never delete another account's canonical source records. */
export function connectedTitleSources(
  title: CatalogTitle,
  enabled: (providerId: string) => boolean,
  checkedAt: string,
): CatalogTitle {
  if (!title.sources) return title;
  const sources = title.sources.filter((source) => enabled(source.providerId));
  if (sources.length === title.sources.length) return title;
  const playable = sources.length > 0;
  const nextEpisode = sources.find((source) => (source.seasonNumber ?? 0) > 0);
  const episodes = new Set(
    sources
      .filter(
        (source) =>
          (source.seasonNumber ?? 0) > 0 && source.episodeNumber !== null,
      )
      .map((source) => `${source.seasonNumber}:${source.episodeNumber}`),
  );
  const coverage =
    title.seriesCoverage && playable
      ? {
          ...title.seriesCoverage,
          seasonsAvailable: new Set(
            sources
              .filter((source) => (source.seasonNumber ?? 0) > 0)
              .map((source) => source.seasonNumber),
          ).size,
          episodesAvailable: episodes.size,
          complete:
            title.seriesCoverage.complete &&
            episodes.size === title.seriesCoverage.episodesTotal,
          nextEpisodeLabel: nextEpisode
            ? `S${String(nextEpisode.seasonNumber).padStart(2, "0")} E${String(nextEpisode.episodeNumber).padStart(2, "0")}`
            : null,
        }
      : null;
  return CatalogTitleSchema.parse({
    ...title,
    sources,
    availability: playable
      ? title.kind === "series"
        ? coverage?.complete
          ? "available"
          : "partial"
        : "available"
      : "unknown",
    formats: playable
      ? [
          ...new Map(
            sources.map((source) => [
              JSON.stringify(source.format),
              source.format,
            ]),
          ).values(),
        ]
      : [],
    seriesCoverage: coverage,
    availabilityProvider: "streamer-ai",
    availabilityCheckedAt: checkedAt,
    availabilityProvenance: {
      providerId: "streamer-ai",
      connectorVersion: "1",
      retrievedAt: checkedAt,
      confidence: playable ? 1 : 0,
      validationState: "derived",
      expiresAt: null,
    },
  });
}
