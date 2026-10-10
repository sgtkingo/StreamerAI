import {
  MediaCandidateRefSchema,
  MediaSearchRequestSchema,
  PlaybackGrantSchema,
  PlaybackRequestSchema,
  ProviderHealthSchema,
  type MediaCandidate,
  type MediaCandidateRef,
  type MediaFormat,
  type MediaProvider,
  type MediaSearchRequest,
  type MediaVariant,
  type PlaybackGrant,
  type PlaybackLanguageAvailability,
  type PlaybackMediaInfo,
  type PlaybackRequest,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth,
} from "@streamer-ai/contracts";
import { randomUUID } from "node:crypto";
import { ProviderRequestError } from "./provider-http.js";
import { WebshareClient, type WebshareFileInfo } from "./webshare-client.js";

const CONNECTOR_VERSION = "0.1.0";

export interface PlaybackTicketInput {
  grantId: string;
  profileId: string;
  providerId: string;
  titleId: string;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  variantId: string;
  directUrl: string;
  expiresAt: string;
  supportsHttpRange?: boolean;
  sourceSizeBytes?: number | null;
  sourceFilename?: string | null;
}

export interface WebshareMediaProviderOptions {
  client: WebshareClient;
  /** Stores the direct URL ephemerally and returns a same-origin ticket path. */
  issuePlaybackTicket: (input: PlaybackTicketInput) => Promise<string> | string;
  /** Reads verified audio and playable subtitle tracks after the source check. */
  probeMedia?: (directUrl: string) => Promise<PlaybackMediaInfo>;
  now?: () => Date;
}

function provenance(retrievedAt: string) {
  return {
    providerId: "webshare",
    retrievedAt,
    connectorVersion: CONNECTOR_VERSION,
    confidence: 1,
    validationState: "verified" as const,
    expiresAt: null,
  };
}

function mediaFormat(name: string, type: string | null): MediaFormat {
  const normalized = name.toLowerCase();
  const resolutionHint =
    /(?:^|[. _-])(2160p|4k|uhd|1080p|720p|480p)(?:[. _-]|$)/i
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

function isVideoType(type: string | null): boolean {
  return (
    type === null ||
    /^(?:video|mkv|mp4|avi|webm|mov|m4v|mpg|mpeg|ts|m2ts)$/i.test(type.trim())
  );
}

/** Deterministic media adapter; it never exposes WST or a Webshare direct URL. */
export class WebshareMediaProvider implements MediaProvider {
  readonly #client: WebshareClient;
  readonly #issuePlaybackTicket: WebshareMediaProviderOptions["issuePlaybackTicket"];
  readonly #probeMedia: WebshareMediaProviderOptions["probeMedia"];
  readonly #now: () => Date;
  readonly #languageCache = new Map<
    string,
    {
      expiresAt: number;
      languages: PlaybackLanguageAvailability;
    }
  >();
  readonly #probeJobs = new Map<
    string,
    Promise<PlaybackLanguageAvailability | void>
  >();

  constructor(options: WebshareMediaProviderOptions) {
    this.#client = options.client;
    this.#issuePlaybackTicket = options.issuePlaybackTicket;
    this.#probeMedia = options.probeMedia;
    this.#now = options.now ?? (() => new Date());
  }

  descriptor(): ProviderDescriptor & { family: "media" } {
    return {
      id: "webshare",
      family: "media",
      displayName: "Webshare",
      connectorVersion: CONNECTOR_VERSION,
      capabilities: ["movie-search", "episode-search", "direct-play", "https"],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "credentials",
      credentialFields: [
        {
          id: "username",
          label: "Username",
          input: "text",
          required: true,
          secret: false,
        },
        {
          id: "password",
          label: "Password",
          input: "password",
          required: true,
          secret: true,
        },
      ],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: "https://webshare.cz/apidoc/",
      privacySummary:
        "Canonical title searches and playback requests are sent to Webshare; credentials stay on the home server.",
    };
  }

  async health(_context: ProviderContext): Promise<ProviderHealth> {
    const configured = await this.#client.hasCredential();
    return ProviderHealthSchema.parse({
      status: configured ? "degraded" : "unavailable",
      checkedAt: this.#now().toISOString(),
      latencyMs: null,
      code: configured ? null : "INVALID_CREDENTIALS",
      connectorVersion: CONNECTOR_VERSION,
    });
  }

  async search(
    rawRequest: MediaSearchRequest,
    context: ProviderContext,
  ): Promise<MediaCandidate[]> {
    const request = MediaSearchRequestSchema.parse(rawRequest);
    const episode =
      request.seasonNumber !== null && request.episodeNumber !== null
        ? ` ${request.episodeSearchTerm ?? `S${String(request.seasonNumber).padStart(2, "0")}E${String(request.episodeNumber).padStart(2, "0")}`}`
        : "";
    // Episode release names frequently omit the series premiere year. Keeping
    // it in the deep-search query would hide otherwise valid SxxEyy files.
    const query = `${request.originalTitle ?? request.title}${
      episode || request.year === null ? "" : ` ${request.year}`
    }${episode}`;
    const result = await this.#client.search(
      { query, limit: request.limit },
      context.signal,
    );
    const retrievedAt = this.#now().toISOString();
    return result.items
      .filter((item) => !item.passwordProtected)
      .map((item) => ({
        ref: { providerId: "webshare", candidateId: item.ident },
        releaseName: item.name,
        sizeBytes: item.size,
        seasonNumber: request.seasonNumber,
        episodeNumber: request.episodeNumber,
        confidence: 0.5,
        provenance: {
          ...provenance(retrievedAt),
          confidence: 0.5,
          validationState: "derived" as const,
        },
      }));
  }

  private async inspectFile(
    rawCandidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<{ variant: MediaVariant; file: WebshareFileInfo }> {
    const candidate = MediaCandidateRefSchema.parse(rawCandidate);
    if (candidate.providerId !== "webshare") {
      throw new ProviderRequestError("webshare", "invalid-response", false);
    }
    const file = await this.#client.fileInfo(
      candidate.candidateId,
      context.signal,
    );
    if (
      !file.downloadable ||
      file.passwordProtected ||
      file.copyrighted ||
      !isVideoType(file.type)
    ) {
      throw new ProviderRequestError("webshare", "forbidden", false);
    }
    return {
      file,
      variant: {
        ref: candidate,
        variantId: candidate.candidateId,
        format: mediaFormat(file.name, file.type),
        directPlay: true,
        supportsHttpRange: false,
        embeddedSubtitles: [],
        provenance: provenance(this.#now().toISOString()),
        expiresAt: null,
      },
    };
  }

  async inspect(
    rawCandidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<MediaVariant> {
    return (await this.inspectFile(rawCandidate, context)).variant;
  }

  async createPlayback(
    rawRequest: PlaybackRequest,
    context: ProviderContext,
  ): Promise<PlaybackGrant> {
    const request = PlaybackRequestSchema.parse(rawRequest);
    if (request.variant.providerId !== "webshare") {
      throw new ProviderRequestError("webshare", "invalid-response", false);
    }
    // Required just-in-time restriction and availability recheck.
    const { variant, file } = await this.inspectFile(
      {
        providerId: request.variant.providerId,
        candidateId: request.variant.candidateId,
      },
      context,
    );
    if (variant.variantId !== request.variant.variantId) {
      throw new ProviderRequestError("webshare", "invalid-response", false);
    }
    const directUrl = await this.#client.createVideoLink(
      request.variant.candidateId,
    );
    const grantId = randomUUID();
    const expiresAt = new Date(this.#now().getTime() + 60_000).toISOString();
    const ticketUrl = await this.#issuePlaybackTicket({
      grantId,
      profileId: request.profileId,
      providerId: "webshare",
      titleId: request.titleId,
      seasonNumber: request.seasonNumber ?? null,
      episodeNumber: request.episodeNumber ?? null,
      variantId: variant.variantId,
      directUrl,
      expiresAt,
      supportsHttpRange: true,
      sourceSizeBytes: file.size,
      sourceFilename: file.name,
    });
    return PlaybackGrantSchema.parse({
      grantId,
      titleId: request.titleId,
      providerId: "webshare",
      variantId: variant.variantId,
      url: ticketUrl,
      supportsHttpRange: true,
      expiresAt,
      embeddedSubtitles: variant.embeddedSubtitles,
    });
  }

  async checkPlayback(
    rawCandidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<PlaybackLanguageAvailability | void> {
    const candidate = MediaCandidateRefSchema.parse(rawCandidate);
    if (candidate.providerId !== "webshare") {
      throw new ProviderRequestError("webshare", "invalid-response", false);
    }
    const variant = await this.inspect(candidate, context);
    // createVideoLink performs a byte-range probe but does not issue a ticket.
    const directUrl = await this.#client.createVideoLink(candidate.candidateId);
    if (!this.#probeMedia) return;
    const cached = this.#languageCache.get(candidate.candidateId);
    if (cached && cached.expiresAt > this.#now().getTime())
      return cached.languages;
    const active = this.#probeJobs.get(candidate.candidateId);
    if (active) return active;
    const job = this.#probeMedia(directUrl)
      .then((media: PlaybackMediaInfo) => {
        const taggedAudio = media.audioTracks
          .map((track) => track.language?.toLowerCase())
          .filter((language): language is string =>
            Boolean(language && language !== "und"),
          );
        const languages: PlaybackLanguageAvailability = {
          audioLanguages: [
            ...new Set(
              taggedAudio.length > 0
                ? taggedAudio
                : variant.format.audioLanguages,
            ),
          ],
          subtitleLanguages: [
            ...new Set(
              media.subtitleTracks.map(
                (track) => track.language?.toLowerCase() ?? "und",
              ),
            ),
          ],
        };
        if (this.#languageCache.size >= 500) {
          const oldest = this.#languageCache.keys().next().value;
          if (oldest) this.#languageCache.delete(oldest);
        }
        this.#languageCache.set(candidate.candidateId, {
          expiresAt: this.#now().getTime() + 10 * 60_000,
          languages,
        });
        return languages;
      })
      .catch(() => undefined)
      .finally(() => this.#probeJobs.delete(candidate.candidateId));
    this.#probeJobs.set(candidate.candidateId, job);
    return job;
  }
}
