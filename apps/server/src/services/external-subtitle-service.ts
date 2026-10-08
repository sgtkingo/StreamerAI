import { ProviderRequestError } from "../integrations/provider-http.js";
import type { WebshareClient } from "../integrations/webshare-client.js";

export type ExternalSubtitleExtension = "srt" | "vtt" | "ass" | "ssa";
export type ExternalSubtitleMatchType =
  "exact" | "language" | "normalized" | "fuzzy";

export interface ExternalSubtitleCandidate {
  fileId: string;
  filename: string;
  extension: ExternalSubtitleExtension;
  language: string | null;
  forced: boolean;
  default: boolean;
  matchScore: number;
  matchType: ExternalSubtitleMatchType;
}

export const MAX_EXTERNAL_SUBTITLE_BYTES = 5 * 1024 * 1024;

type SubtitleClient = Pick<
  WebshareClient,
  "fileInfo" | "similarSubtitles" | "downloadFile"
>;

const LANGUAGES: Readonly<Record<string, string>> = {
  cs: "cs",
  cz: "cs",
  cze: "cs",
  ces: "cs",
  czech: "cs",
  en: "en",
  eng: "en",
  english: "en",
  de: "de",
  ger: "de",
  deu: "de",
  german: "de",
  sk: "sk",
  slo: "sk",
  slk: "sk",
  slovak: "sk",
  fr: "fr",
  fre: "fr",
  fra: "fr",
  french: "fr",
  es: "es",
  spa: "es",
  spanish: "es",
  it: "it",
  ita: "it",
  italian: "it",
  pl: "pl",
  pol: "pl",
  polish: "pl",
  hu: "hu",
  hun: "hu",
  hungarian: "hu",
  pt: "pt",
  por: "pt",
  portuguese: "pt",
  ja: "ja",
  jpn: "ja",
  japanese: "ja",
  ko: "ko",
  kor: "ko",
  korean: "ko",
};

const STATUS_SUFFIXES = new Set(["forced", "default", "sdh", "hi", "cc"]);
const RELEASE_TOKENS = new Set([
  "2160p",
  "1080p",
  "720p",
  "480p",
  "4k",
  "uhd",
  "hdr",
  "hdr10",
  "dv",
  "dolbyvision",
  "web",
  "dl",
  "webdl",
  "webrip",
  "bluray",
  "bdrip",
  "brrip",
  "hdtv",
  "pdtv",
  "dvdrip",
  "remux",
  "proper",
  "repack",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "aac",
  "ac3",
  "eac3",
  "dts",
  "truehd",
  "atmos",
  "ddp5",
  "ddp",
  "10bit",
  "8bit",
]);

interface ParsedFilename {
  stem: string;
  extension: string;
}

interface NameShape {
  title: string[];
  context: string | null;
  release: string[];
  hasReleaseMarker: boolean;
  episode: string | null;
  hasEpisodeSyntax: boolean;
  year: string | null;
}

function validFileId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

function splitFilename(value: string): ParsedFilename | null {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    return null;
  const match = /^(.*)\.([A-Za-z0-9]{2,5})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return { stem: match[1], extension: match[2].toLowerCase() };
}

function subtitleExtension(value: string): ExternalSubtitleExtension | null {
  const extension = splitFilename(value)?.extension;
  return extension === "srt" ||
    extension === "vtt" ||
    extension === "ass" ||
    extension === "ssa"
    ? extension
    : null;
}

function folded(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokensWithPositions(
  value: string,
): Array<{ token: string; start: number; end: number }> {
  return [...folded(value).matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    token: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function suffixMetadata(
  stem: string,
  mediaStem: string,
): {
  basename: string;
  language: string | null;
  forced: boolean;
  default: boolean;
  hadSuffix: boolean;
} {
  let basename = stem;
  let language: string | null = null;
  let forced = false;
  let isDefault = false;
  let hadSuffix = false;
  for (let count = 0; count < 4; count++) {
    const match = /[. _-]+([\p{L}]+)$/u.exec(basename);
    if (!match?.[1]) break;
    const token = folded(match[1]);
    const detected = LANGUAGES[token];
    if (!detected && !STATUS_SUFFIXES.has(token)) break;
    hadSuffix = true;
    // The rightmost language suffix describes the subtitle; earlier tags may
    // describe the media release or another audio track.
    if (detected && language === null) language = detected;
    if (token === "forced") forced = true;
    if (token === "default") isDefault = true;
    basename = basename.slice(0, match.index);
    if (folded(basename) === folded(mediaStem)) break;
  }
  return { basename, language, forced, default: isDefault, hadSuffix };
}

function nameShape(stem: string): NameShape {
  const normalized = folded(stem);
  const pieces = tokensWithPositions(stem);
  // Do not infer an episode from a bare number: it could be a movie year.
  const episodeMatches = [
    ...normalized.matchAll(
      /(?:^|[^a-z0-9])(?:s(\d{1,2})e(\d{1,2})|(\d{1,2})x(\d{1,2}))(?=$|[^a-z0-9])/g,
    ),
  ];
  const hasEpisodeSyntax =
    /(?:^|[^a-z0-9])(?:s\d{1,2}e\d{1,2}|\d{1,2}x\d{1,2})/i.test(normalized);
  const episodeMatch =
    episodeMatches.length === 1 ? episodeMatches[0] : undefined;
  const season = episodeMatch?.[1] ?? episodeMatch?.[3];
  const number = episodeMatch?.[2] ?? episodeMatch?.[4];
  const episode =
    season && number ? `${Number(season)}:${Number(number)}` : null;
  const episodeStart = episodeMatch
    ? episodeMatch.index +
      (episodeMatch[0].startsWith("s") || /^\d/.test(episodeMatch[0]) ? 0 : 1)
    : -1;
  const episodeEnd = episodeMatch
    ? episodeMatch.index + episodeMatch[0].length
    : -1;
  const yearPieces = pieces.filter((piece) =>
    /^(?:19|20)\d{2}$/.test(piece.token),
  );
  const yearPiece = yearPieces.at(-1);
  // For series, a year before SxxEyy is part of the show title.
  const year = episode ? null : (yearPiece?.token ?? null);
  const releaseMarker =
    !episode && !year
      ? pieces.find((piece) => RELEASE_TOKENS.has(piece.token))
      : undefined;
  const markerStart = episode
    ? episodeStart
    : (yearPiece?.start ?? releaseMarker?.start ?? -1);
  const markerEnd = episode
    ? episodeEnd
    : (yearPiece?.end ?? releaseMarker?.start ?? -1);
  const title =
    markerStart >= 0
      ? pieces
          .filter((piece) => piece.end <= markerStart)
          .map((piece) => piece.token)
      : pieces.map((piece) => piece.token);
  const release =
    markerEnd >= 0
      ? pieces
          .filter((piece) => piece.start >= markerEnd)
          .map((piece) => piece.token)
          .filter((piece) => !RELEASE_TOKENS.has(piece))
      : [];
  return {
    title,
    context: episode ? `episode:${episode}` : year ? `year:${year}` : null,
    release,
    hasReleaseMarker: releaseMarker !== undefined,
    episode,
    hasEpisodeSyntax,
    year,
  };
}

function singleAdjacentTransposition(left: string, right: string): boolean {
  if (left.length !== right.length || left === right) return false;
  let index = 0;
  while (index < left.length && left[index] === right[index]) index++;
  return (
    index + 1 < left.length &&
    left[index] === right[index + 1] &&
    left[index + 1] === right[index] &&
    left.slice(index + 2) === right.slice(index + 2)
  );
}

/** Conservative scoring: episode identity and movie year are hard constraints. */
export function matchExternalSubtitleFilename(
  mediaFilename: string,
  subtitleFilename: string,
): Omit<ExternalSubtitleCandidate, "fileId" | "filename" | "extension"> | null {
  const media = splitFilename(mediaFilename);
  const subtitle = splitFilename(subtitleFilename);
  if (!media || !subtitle || !subtitleExtension(subtitleFilename)) return null;
  const metadata = suffixMetadata(subtitle.stem, media.stem);
  const common = {
    language: metadata.language,
    forced: metadata.forced,
    default: metadata.default,
  };
  if (folded(media.stem) === folded(subtitle.stem)) {
    // A token shared with the media basename is part of the release name;
    // treating it as a subtitle suffix would mislabel titles like "The English".
    return {
      language: null,
      forced: false,
      default: false,
      matchScore: 1,
      matchType: "exact",
    };
  }
  if (metadata.hadSuffix && folded(media.stem) === folded(metadata.basename)) {
    return { ...common, matchScore: 0.97, matchType: "language" };
  }

  const mediaShape = nameShape(media.stem);
  const subtitleShape = nameShape(metadata.basename);
  if (
    mediaShape.hasEpisodeSyntax !== subtitleShape.hasEpisodeSyntax ||
    mediaShape.episode !== subtitleShape.episode ||
    mediaShape.year !== subtitleShape.year ||
    mediaShape.context !== subtitleShape.context ||
    mediaShape.title.length === 0 ||
    subtitleShape.title.length === 0
  )
    return null;
  const sameRelease =
    mediaShape.release.join(" ") === subtitleShape.release.join(" ");
  if (!sameRelease) return null;
  if (mediaShape.title.join(" ") === subtitleShape.title.join(" ")) {
    if (
      mediaShape.context === null &&
      (mediaShape.title.length < 2 ||
        (!mediaShape.hasReleaseMarker && !subtitleShape.hasReleaseMarker))
    )
      return null;
    return { ...common, matchScore: 0.88, matchType: "normalized" };
  }
  if (
    mediaShape.context === null ||
    mediaShape.title.length < 2 ||
    mediaShape.title.length !== subtitleShape.title.length
  )
    return null;
  let differingTokens = 0;
  for (let index = 0; index < mediaShape.title.length; index++) {
    const left = mediaShape.title[index]!;
    const right = subtitleShape.title[index]!;
    if (left === right) continue;
    if (
      ++differingTokens > 1 ||
      Math.min(left.length, right.length) < 5 ||
      !singleAdjacentTransposition(left, right)
    )
      return null;
  }
  return differingTokens === 1
    ? { ...common, matchScore: 0.72, matchType: "fuzzy" }
    : null;
}

function decodeSubtitle(bytes: Buffer): string {
  if (bytes.includes(0) && bytes[0] !== 0xff && bytes[0] !== 0xfe) {
    throw new ProviderRequestError("webshare", "invalid-response", false);
  }
  const utf16Encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : null;
  if (utf16Encoding !== null) {
    try {
      return new TextDecoder(utf16Encoding, { fatal: true }).decode(
        bytes.subarray(2),
      );
    } catch {
      throw new ProviderRequestError("webshare", "invalid-response", false);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
  } catch {
    // Older Czech/Slovak SRT files are often Windows-1250 encoded.
    return new TextDecoder("windows-1250", { fatal: true }).decode(bytes);
  }
}

/** Grant ownership of discovered IDs is enforced by the playback route. */
export class WebshareExternalSubtitleService {
  constructor(private readonly client: SubtitleClient) {}

  async discover(
    mediaFileId: string,
    mediaFilename?: string,
    signal?: AbortSignal,
  ): Promise<ExternalSubtitleCandidate[]> {
    if (!validFileId(mediaFileId))
      throw new TypeError("Media file ID is invalid.");
    const filename =
      mediaFilename ?? (await this.client.fileInfo(mediaFileId, signal)).name;
    if (!splitFilename(filename)) return [];
    const items = await this.client.similarSubtitles(filename, signal);
    const byFileId = new Map<string, ExternalSubtitleCandidate>();
    for (const item of items) {
      if (
        !validFileId(item.ident) ||
        item.ident === mediaFileId ||
        item.size === null ||
        item.size < 1 ||
        item.size > MAX_EXTERNAL_SUBTITLE_BYTES
      )
        continue;
      const extension = subtitleExtension(item.name);
      if (!extension) continue;
      if (item.type !== null && item.type.toLowerCase() !== extension) continue;
      const match = matchExternalSubtitleFilename(filename, item.name);
      if (!match) continue;
      const candidate = {
        fileId: item.ident,
        filename: item.name,
        extension,
        ...match,
      };
      const previous = byFileId.get(item.ident);
      if (!previous || previous.matchScore < candidate.matchScore) {
        byFileId.set(item.ident, candidate);
      }
    }
    return [...byFileId.values()]
      .sort(
        (left, right) =>
          right.matchScore - left.matchScore ||
          left.filename.localeCompare(right.filename) ||
          left.fileId.localeCompare(right.fileId),
      )
      .slice(0, 20);
  }

  async load(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ filename: string; content: string }> {
    if (!validFileId(fileId))
      throw new TypeError("Subtitle file ID is invalid.");
    const file = await this.client.fileInfo(fileId, signal);
    const extension = subtitleExtension(file.name);
    if (
      !file.downloadable ||
      file.passwordProtected ||
      file.copyrighted ||
      !extension ||
      (file.type !== null && file.type.toLowerCase() !== extension) ||
      file.size === null ||
      file.size < 1 ||
      file.size > MAX_EXTERNAL_SUBTITLE_BYTES
    ) {
      throw new ProviderRequestError("webshare", "forbidden", false);
    }
    const bytes = await this.client.downloadFile(
      fileId,
      MAX_EXTERNAL_SUBTITLE_BYTES,
      signal,
    );
    return { filename: file.name, content: decodeSubtitle(bytes) };
  }
}
