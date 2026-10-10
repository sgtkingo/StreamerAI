import type { CatalogTitle } from "@streamer-ai/contracts";

const sourceMarks: Record<string, { label: string; asset: string }> = {
  tmdb: { label: "TMDB", asset: "tmdb" },
  webshare: { label: "Webshare", asset: "webshare" },
  csfd: { label: "ČSFD", asset: "csfd" },
  "local-files": { label: "Local files", asset: "local-files" },
  ftp: { label: "FTP", asset: "ftp" },
  ftps: { label: "FTPS", asset: "ftps" },
  nas: { label: "NAS", asset: "nas" },
  opensubtitles: { label: "OpenSubtitles", asset: "opensubtitles" },
  "titulky-com": { label: "Titulky.com", asset: "titulky-com" },
};

export function sourceName(providerId: string): string {
  return (
    sourceMarks[providerId]?.label ??
    providerId
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function SourceIcon({ providerId }: { providerId: string }) {
  const asset = sourceMarks[providerId]?.asset ?? "generic";
  return (
    <img
      className="source-icon"
      src={`/source-icons/${asset}.svg`}
      alt=""
      width="20"
      height="20"
      loading="lazy"
    />
  );
}

/** Stream providers take priority; preview and legacy records fall back to provenance. */
export function titleSourceProviderIds(
  title: CatalogTitle,
  episode?: { seasonNumber: number; episodeNumber: number },
): string[] {
  const sources = (title.sources ?? []).filter((source) =>
    episode
      ? source.seasonNumber === episode.seasonNumber &&
        source.episodeNumber === episode.episodeNumber
      : title.kind === "series" ||
        (source.seasonNumber === null && source.episodeNumber === null),
  );
  const providers = [...new Set(sources.map((source) => source.providerId))];
  if (providers.length > 0) return providers;
  if (
    !episode &&
    title.availability !== "unavailable" &&
    title.availabilityProvider
  ) {
    return [title.availabilityProvider];
  }
  return [title.metadataProvider];
}

export function SourceOriginStack({ providerIds }: { providerIds: string[] }) {
  const unique = [...new Set(providerIds)];
  if (unique.length === 0) return null;
  const visible = unique.slice(0, 3);
  return (
    <span
      className={`source-origin source-origin--${visible.length}${unique.length > 3 ? " source-origin--overflow" : ""}`}
      role="img"
      aria-label={`Sources: ${visible.map(sourceName).join(", ")}${unique.length > 3 ? `, and ${unique.length - 3} more` : ""}`}
    >
      {visible.map((providerId, index) => (
        <span
          className={`source-origin__item source-origin__item--${index}`}
          key={providerId}
        >
          <SourceIcon providerId={providerId} />
        </span>
      ))}
    </span>
  );
}
