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

/** Stream details a provider measured on the file (e.g. Webshare file_info). */
export interface MeasuredMedia {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  bitrate: number | null;
  videoCodec: string | null;
  audio: {
    codec: string | null;
    channels: number | null;
    language: string | null;
  }[];
}

const LANGUAGE_CODES: Record<string, string> = {
  cze: "cs",
  ces: "cs",
  cz: "cs",
  slo: "sk",
  slk: "sk",
  eng: "en",
  ger: "de",
  deu: "de",
  fre: "fr",
  fra: "fr",
  spa: "es",
  ita: "it",
  pol: "pl",
  hun: "hu",
  rus: "ru",
  ukr: "uk",
  jpn: "ja",
  jap: "ja",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  por: "pt",
  dut: "nl",
  nld: "nl",
};

/** ISO 639-2 (ENG, CZE) and similar tags as the two-letter codes we use. */
export function languageCode(value: string | null): string | null {
  const code = value?.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (!code || code === "und" || code === "unknown") return null;
  const mapped = LANGUAGE_CODES[code] ?? code;
  return /^[a-z]{2,3}$/.test(mapped) ? mapped : null;
}

/**
 * Resolution class of a picture. Width decides first because widescreen
 * releases are shorter than their class (1920×816 is still 1080p).
 */
export function resolutionClass(
  width: number | null,
  height: number | null,
): string | null {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w === 0 && h === 0) return null;
  if (w >= 3200 || h >= 1800) return "2160p";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  if (w >= 1000 || h >= 560) return "576p";
  return "480p";
}

export function videoCodecName(value: string | null): string | null {
  const codec =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") ?? "";
  if (!codec) return null;
  if (/^(h265|hevc|x265)$/.test(codec)) return "H.265";
  if (/^(h264|avc|avc1|x264)$/.test(codec)) return "H.264";
  if (codec === "av1") return "AV1";
  if (codec === "vp9") return "VP9";
  if (/^(xvid|divx|mpeg4|mp4v|mpeg4visual)$/.test(codec)) return "MPEG-4";
  if (/^(mpeg2|mpeg2video)$/.test(codec)) return "MPEG-2";
  return value!.trim().toUpperCase().slice(0, 32);
}

/**
 * Format from measured streams, falling back to the name for anything the
 * provider did not report (e.g. untagged audio languages).
 */
export function formatFromMeasuredMedia(
  name: string,
  type: string | null,
  media: MeasuredMedia | null,
): MediaFormat {
  const guessed = formatFromReleaseName(name, type);
  if (!media) return guessed;
  const resolution =
    resolutionClass(media.width, media.height) ?? guessed.resolution;
  const videoCodec = videoCodecName(media.videoCodec) ?? guessed.videoCodec;
  const audioTracks = media.audio.slice(0, 16).map((track) => ({
    codec: track.codec?.trim().slice(0, 32) || null,
    channels: track.channels,
    language: languageCode(track.language),
  }));
  const tagged = [
    ...new Set(
      audioTracks
        .map((track) => track.language)
        .filter((language): language is string => language !== null),
    ),
  ].slice(0, 12);
  // Untagged tracks keep the name's hint; tagged tracks replace it.
  const audioLanguages =
    tagged.length > 0 && tagged.length === audioTracks.length
      ? tagged
      : [...new Set([...tagged, ...guessed.audioLanguages])].slice(0, 12);
  return {
    label:
      [resolution, videoCodec, type ?? guessed.container]
        .filter(Boolean)
        .join(" · ") || "Video",
    container: guessed.container,
    resolution,
    videoCodec,
    audioLanguages,
    subtitleLanguages: [],
    details: {
      durationSeconds: media.durationSeconds,
      width: media.width,
      height: media.height,
      bitrate: media.bitrate,
      audioTracks,
    },
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
