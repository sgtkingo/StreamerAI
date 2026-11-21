import { createHash } from "node:crypto";
import type {
  CatalogTitle,
  MediaCandidate,
  MediaCandidateRef,
  MediaFormat,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import {
  episodeFromReleaseName,
  formatFromReleaseName,
} from "../integrations/release-name.js";

/**
 * Fast Search plays and downloads provider files that have no canonical title.
 * Such playback uses a synthetic title id derived from the provider reference;
 * it never creates titles, Library entries or history.
 */
const DIRECT_PREFIX = "direct-";

export function directTitleId(ref: MediaCandidateRef): string {
  return `${DIRECT_PREFIX}${directSourceId(ref)}`;
}
/** 32 hex characters, the shape every source id has. */
export function directSourceId(ref: MediaCandidateRef): string {
  return createHash("sha256")
    .update(`${ref.providerId}\u0000${ref.candidateId}`)
    .digest("hex")
    .slice(0, 32);
}
export function isDirectTitleId(titleId: string): boolean {
  return /^direct-[0-9a-f]{32}$/.test(titleId);
}

export const DOWNLOADABLE_EXTENSIONS =
  /\.(mkv|avi|mp4|m4v|mov|webm|mpg|mpeg|ts|m2ts)$/i;

export interface DirectSearchItem {
  providerId: string;
  candidateId: string;
  /** Synthetic title id used for playback position and downloads. */
  directId: string;
  releaseName: string;
  sizeBytes: number | null;
  /** 0-based position in the provider's own result order. */
  providerRank: number;
  /** 0..1 similarity between the query and the file name. */
  similarity: number;
  format: Pick<
    MediaFormat,
    "container" | "resolution" | "videoCodec" | "audioLanguages"
  >;
  episode: { seasonNumber: number; episodeNumber: number } | null;
  votes: { positive: number; negative: number } | null;
  /** Webshare video files can be saved; local files are already on disk. */
  downloadable: boolean;
}

const NOISE = new Set([
  "2160p",
  "1080p",
  "720p",
  "576p",
  "480p",
  "4k",
  "uhd",
  "hdr",
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "web",
  "webrip",
  "webdl",
  "bluray",
  "brrip",
  "bdrip",
  "dvdrip",
  "hdtv",
  "mkv",
  "mp4",
  "avi",
  "m4v",
  "mov",
  "webm",
  "ts",
  "aac",
  "ac3",
  "dts",
  "cz",
  "cze",
  "en",
  "eng",
  "dabing",
  "titulky",
]);

export function searchWords(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * How well a file name matches the query: mostly the share of query words
 * present, then how much of the name is unrelated, plus a bonus for the exact
 * phrase. Technical tags (resolution, codec, language) do not dilute it.
 */
export function similarity(query: string, releaseName: string): number {
  const wanted = [...new Set(searchWords(query))];
  if (wanted.length === 0) return 0;
  const words = searchWords(releaseName);
  const meaningful = words.filter(
    (word) => !NOISE.has(word) && !/^(?:19|20)\d{2}$/.test(word),
  );
  const present = new Set(words);
  const matched = wanted.filter((word) => present.has(word)).length;
  const coverage = matched / wanted.length;
  const focus =
    meaningful.length === 0
      ? 0
      : Math.min(1, matched / new Set(meaningful).size);
  const phrase = ` ${words.join(" ")} `.includes(` ${wanted.join(" ")} `)
    ? 0.1
    : 0;
  return (
    Math.round(Math.min(1, coverage * 0.7 + focus * 0.2 + phrase) * 1000) / 1000
  );
}

export function directSearchItems(
  query: string,
  candidates: MediaCandidate[],
  offset = 0,
): DirectSearchItem[] {
  return candidates.map((candidate, index) => {
    const format = formatFromReleaseName(candidate.releaseName);
    return {
      providerId: candidate.ref.providerId,
      candidateId: candidate.ref.candidateId,
      directId: directTitleId(candidate.ref),
      releaseName: candidate.releaseName,
      sizeBytes: candidate.sizeBytes,
      providerRank: offset + index,
      similarity: similarity(query, candidate.releaseName),
      format: {
        container: format.container,
        resolution: format.resolution,
        videoCodec: format.videoCodec,
        audioLanguages: format.audioLanguages,
      },
      episode: episodeFromReleaseName(candidate.releaseName),
      votes: candidate.qualityVotes ?? null,
      downloadable:
        candidate.ref.providerId === "webshare" &&
        DOWNLOADABLE_EXTENSIONS.test(candidate.releaseName),
    };
  });
}

/** A title-shaped stand-in so the player can show the file and resume it. */
export function directCatalogTitle(
  ref: MediaCandidateRef,
  releaseName: string,
  position: DirectPosition | null,
  now: Date,
): CatalogTitle {
  return {
    id: directTitleId(ref),
    kind: "movie",
    title: releaseName.slice(0, 240) || "Video",
    originalTitle: null,
    year: null,
    synopsis: "",
    posterUrl: null,
    backdropUrl: null,
    accentColor: "#1f2937",
    genres: [],
    ratings: [],
    matchPercent: null,
    availability: "available",
    availabilityProvider: ref.providerId,
    availabilityCheckedAt: now.toISOString(),
    formats: [],
    seriesCoverage: null,
    metadataProvider: ref.providerId,
    metadataValidatedAt: now.toISOString(),
    inLibrary: false,
    progressPercent: position?.progressPercent ?? null,
    resumePositionSeconds: position?.positionSeconds ?? null,
  };
}

export interface DirectPosition {
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  updatedAt: string;
}
const MAX_POSITIONS = 200;
const positionsKey = (profileId: string) =>
  `direct-search.positions.${Buffer.from(profileId, "utf8").toString("base64url")}`;

/** Resume positions for Fast Search playback; no history or Library entry. */
export class DirectPositionStore {
  constructor(private readonly database: StreamerDatabase) {}

  get(profileId: string, titleId: string): DirectPosition | null {
    return this.#all(profileId)[titleId] ?? null;
  }

  set(
    profileId: string,
    titleId: string,
    position: Omit<DirectPosition, "updatedAt">,
    now: Date,
  ): void {
    const all = this.#all(profileId);
    all[titleId] = { ...position, updatedAt: now.toISOString() };
    const kept = Object.entries(all)
      .sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_POSITIONS);
    this.database.settings.set(
      positionsKey(profileId),
      Object.fromEntries(kept),
    );
  }

  deleteProfile(profileId: string): void {
    this.database.settings.delete(positionsKey(profileId));
  }

  #all(profileId: string): Record<string, DirectPosition> {
    const saved = this.database.settings.get<unknown>(positionsKey(profileId));
    return saved && typeof saved === "object"
      ? { ...(saved as Record<string, DirectPosition>) }
      : {};
  }
}
