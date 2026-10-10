import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MediaCandidateRefSchema,
  MediaSearchRequestSchema,
  PlaybackGrantSchema,
  PlaybackRequestSchema,
  PlaybackSourceRefreshRequestSchema,
  ProviderHealthSchema,
  type MediaCandidate,
  type MediaCandidateRef,
  type MediaProvider,
  type MediaVariant,
  type PlaybackGrant,
  type PlaybackRequest,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth,
} from "@streamer-ai/contracts";
import type { PlaybackTicketInput } from "../services/playback-ticket-store.js";
import {
  LocalMediaLibrary,
  type LocalMediaFile,
} from "../services/local-media-library.js";

const VERSION = "0.1.0";
const normalize = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const episode = (name: string) => {
  const match =
    /(?:^|[\s._-])S(\d{1,2})E(\d{1,3})(?:[\s._-]|$)/i.exec(name) ??
    /(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:[\s._-]|$)/i.exec(name);
  return match ? { season: Number(match[1]), number: Number(match[2]) } : null;
};

export class LocalMediaProvider implements MediaProvider {
  constructor(
    private readonly library: LocalMediaLibrary,
    private readonly issuePlaybackTicket: (
      input: PlaybackTicketInput,
    ) => string,
    private readonly now = () => new Date(),
  ) {}

  descriptor(): ProviderDescriptor & { family: "media" } {
    return {
      id: "local-files",
      family: "media",
      displayName: "Local folder or drive",
      connectorVersion: VERSION,
      capabilities: [
        "movie-search",
        "episode-search",
        "direct-play",
        "local-files",
        "embedded-subtitles",
      ],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "informed-consent",
      credentialFields: [],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: null,
      privacySummary:
        "Files are scanned and played on your home server. File paths remain server-side.",
    };
  }

  async health(_context: ProviderContext): Promise<ProviderHealth> {
    return ProviderHealthSchema.parse({
      status: this.library.getConfig().roots.length ? "healthy" : "unavailable",
      checkedAt: this.now().toISOString(),
      latencyMs: null,
      code: this.library.getConfig().roots.length ? null : "PERMISSION_MISSING",
      connectorVersion: VERSION,
    });
  }

  async search(
    raw: Parameters<MediaProvider["search"]>[0],
    _context: ProviderContext,
  ): Promise<MediaCandidate[]> {
    const request = MediaSearchRequestSchema.parse(raw);
    const title = normalize(request.title);
    const original = request.originalTitle && normalize(request.originalTitle);
    const retrievedAt = this.now().toISOString();
    return this.library
      .allFiles()
      .filter((file) => {
        const name = normalize(file.name);
        if (!name.includes(title) && (!original || !name.includes(original)))
          return false;
        const parsed = episode(file.name);
        if (request.kind === "movie" && parsed) return false;
        if (request.kind === "series" && !parsed) return false;
        if (
          request.seasonNumber !== null &&
          parsed?.season !== request.seasonNumber
        )
          return false;
        if (
          request.episodeNumber !== null &&
          parsed?.number !== request.episodeNumber
        )
          return false;
        return true;
      })
      .slice(0, request.limit)
      .map((file) => ({
        ref: { providerId: "local-files", candidateId: file.id },
        releaseName: file.name,
        sizeBytes: file.sizeBytes,
        seasonNumber: episode(file.name)?.season ?? null,
        episodeNumber: episode(file.name)?.number ?? null,
        confidence: 0.9,
        provenance: {
          providerId: "local-files",
          retrievedAt,
          connectorVersion: VERSION,
          confidence: 0.9,
          validationState: "verified" as const,
          expiresAt: null,
        },
      }));
  }

  private async file(raw: MediaCandidateRef): Promise<LocalMediaFile> {
    const ref = MediaCandidateRefSchema.parse(raw);
    if (ref.providerId !== "local-files")
      throw new Error("Invalid local media source.");
    return this.library.resolveFile(ref.candidateId);
  }

  async inspect(
    raw: MediaCandidateRef,
    _context: ProviderContext,
  ): Promise<MediaVariant> {
    const file = await this.file(raw);
    const ext = extname(file.name).slice(1).toLowerCase();
    return {
      ref: { providerId: "local-files", candidateId: file.id },
      variantId: file.id,
      format: {
        label: ext.toUpperCase(),
        container: ext,
        resolution: null,
        videoCodec: null,
        audioLanguages: [],
        subtitleLanguages: [],
      },
      directPlay: true,
      supportsHttpRange: true,
      embeddedSubtitles: [],
      provenance: {
        providerId: "local-files",
        retrievedAt: this.now().toISOString(),
        connectorVersion: VERSION,
        confidence: 1,
        validationState: "verified",
        expiresAt: null,
      },
      expiresAt: null,
    };
  }

  async createPlayback(
    raw: PlaybackRequest,
    context: ProviderContext,
  ): Promise<PlaybackGrant> {
    const request = PlaybackRequestSchema.parse(raw);
    const file = await this.file({
      providerId: request.variant.providerId,
      candidateId: request.variant.candidateId,
    });
    if (request.variant.variantId !== file.id)
      throw new Error("Local media variant changed.");
    const grantId = randomUUID();
    const expiresAt = new Date(this.now().getTime() + 60_000).toISOString();
    const url = this.issuePlaybackTicket({
      grantId,
      profileId: request.profileId,
      providerId: "local-files",
      titleId: request.titleId,
      seasonNumber: request.seasonNumber,
      episodeNumber: request.episodeNumber,
      candidateId: file.id,
      variantId: file.id,
      directUrl: pathToFileURL(file.path).href,
      expiresAt,
      supportsHttpRange: true,
      sourceSizeBytes: file.sizeBytes,
      sourceFilename: file.name,
    });
    context.signal?.throwIfAborted();
    return PlaybackGrantSchema.parse({
      grantId,
      titleId: request.titleId,
      providerId: "local-files",
      variantId: file.id,
      url,
      supportsHttpRange: true,
      expiresAt,
      embeddedSubtitles: [],
    });
  }

  async refreshPlaybackSource(
    raw: Parameters<NonNullable<MediaProvider["refreshPlaybackSource"]>>[0],
  ): Promise<string> {
    const request = PlaybackSourceRefreshRequestSchema.parse(raw);
    return pathToFileURL((await this.file(request.candidate)).path).href;
  }
}
