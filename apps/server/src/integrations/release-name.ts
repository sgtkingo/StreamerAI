import type { MediaFormat } from "@streamer-ai/contracts";

/**
 * Best-effort technical details read from a release or file name. Providers
 * only return names in search results; real tracks need a media probe.
 */
export function formatFromReleaseName(
  name: string,
  type: string | null = null,
): MediaFormat {
  const normalized = name.toLowerCase();
  const resolutionHint =
    /(?:^|[. _-])(2160p|4k|uhd|1080p|720p|576p|480p)(?:[. _-]|$)/i
      .exec(name)?.[1]
      ?.toLowerCase() ?? null;
  const resolution =
    resolutionHint === "4k" || resolutionHint === "uhd"
      ? "2160p"
      : resolutionHint;
  const codec = /(?:x265|h[. ]?265|hevc)/i.test(name)
    ? "H.265"
    : /(?:x264|h[. ]?264|avc)/i.test(name)
      ? "H.264"
      : null;
  const extension =
    /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase() ?? null;
  const audioLanguages = [
    ...(/(?:^|[. _-])(?:cz|cze|ces)(?:[. _-]|$)/i.test(normalized)
      ? ["cs"]
      : []),
    ...(/(?:^|[. _-])(?:en|eng)(?:[. _-]|$)/i.test(normalized) ? ["en"] : []),
    ...(/(?:^|[^a-z0-9])(?:ja|jpn|jap|japanese)(?:[^a-z0-9]|$)/i.test(
      normalized,
    )
      ? ["ja"]
      : []),
  ];
  return {
    label:
      [resolution, codec, type ?? extension].filter(Boolean).join(" · ") ||
      "Video",
    container: extension,
    resolution,
    videoCodec: codec,
    audioLanguages,
    subtitleLanguages: [],
  };
}

/** S01E02 / 1x02 style episode markers. */
export function episodeFromReleaseName(
  name: string,
): { seasonNumber: number; episodeNumber: number } | null {
  const match =
    /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]?e(\d{1,3})(?:[^0-9]|$)/i.exec(name) ??
    /(?:^|[^a-z0-9])(\d{1,2})x(\d{2,3})(?:[^0-9]|$)/i.exec(name);
  if (!match) return null;
  const seasonNumber = Number(match[1]);
  const episodeNumber = Number(match[2]);
  return episodeNumber > 0 ? { seasonNumber, episodeNumber } : null;
}
