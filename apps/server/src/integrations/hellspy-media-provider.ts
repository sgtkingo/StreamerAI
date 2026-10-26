import { randomUUID } from "node:crypto";
import {
  CONNECTOR_CONTRACT_VERSION,
  MediaCandidateRefSchema,
  MediaSearchRequestSchema,
  PlaybackRequestSchema,
  PlaybackGrantSchema,
  PlaybackSourceRefreshRequestSchema,
  type MediaProvider,
  type ProviderDescriptor,
  type ProviderContext,
  type ProviderHealth,
  type MediaCandidate,
  type MediaCandidateRef,
  type MediaSearchRequest,
  type MediaVariant,
  type PlaybackRequest,
  type PlaybackGrant,
  type PlaybackMediaInfo,
  type PlaybackLanguageAvailability,
} from "@streamer-ai/contracts";
import {
  HellspyClient,
  hellspyCandidateId,
  type HellspyVideoDetail,
} from "./hellspy-client.js";
import { ProviderRequestError } from "./provider-http.js";
import type { PlaybackTicketInput } from "../services/playback-ticket-store.js";

const VERSION = "0.1.0";
export interface HellspyMediaProviderOptions {
  client: HellspyClient;
  issuePlaybackTicket: (input: PlaybackTicketInput) => string | Promise<string>;
  probeMedia?: (url: string) => Promise<PlaybackMediaInfo>;
  now?: () => Date;
}
/** API data and signed conversion URLs stay inside this adapter. */
export class HellspyMediaProvider implements MediaProvider {
  readonly #now: () => Date;
  constructor(private readonly options: HellspyMediaProviderOptions) {
    this.#now = options.now ?? (() => new Date());
  }
  descriptor(): ProviderDescriptor & { family: "media" } {
    return {
      id: "hellspy",
      family: "media",
      displayName: "Hellspy",
      connectorVersion: VERSION,
      contractVersion: CONNECTOR_CONTRACT_VERSION,
      capabilities: ["movie-search", "episode-search", "direct-play", "https"],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "credentials",
      credentialFields: [
        {
          id: "username",
          label: "Email",
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
      documentationUrl: "https://www.hellspy.to/",
      privacySummary:
        "Title searches and playback requests are sent to Hellspy only with a verified account. The session token stays on the home server.",
    };
  }
  private provenance(derived = false) {
    return {
      providerId: "hellspy",
      retrievedAt: this.#now().toISOString(),
      connectorVersion: VERSION,
      confidence: derived ? 0.5 : 1,
      validationState: derived ? ("derived" as const) : ("verified" as const),
      expiresAt: null,
    };
  }
  async health(context: ProviderContext): Promise<ProviderHealth> {
    try {
      await this.options.client.authorize(
        context.profileId ?? "default",
        context.signal,
      );
      return {
        status: "healthy",
        checkedAt: this.#now().toISOString(),
        latencyMs: null,
        code: null,
        connectorVersion: VERSION,
      };
    } catch (error) {
      const code =
        error instanceof ProviderRequestError &&
        ["unauthorized", "not-configured"].includes(error.kind)
          ? "INVALID_CREDENTIALS"
          : "PROVIDER_UNAVAILABLE";
      return {
        status: "unavailable",
        checkedAt: this.#now().toISOString(),
        latencyMs: null,
        code,
        connectorVersion: VERSION,
      };
    }
  }
  async search(
    raw: MediaSearchRequest,
    context: ProviderContext,
  ): Promise<MediaCandidate[]> {
    const request = MediaSearchRequestSchema.parse(raw);
    const episode =
      request.seasonNumber !== null && request.episodeNumber !== null
        ? ` ${request.episodeSearchTerm ?? `S${String(request.seasonNumber).padStart(2, "0")}E${String(request.episodeNumber).padStart(2, "0")}`}`
        : "";
    const query = `${request.originalTitle ?? request.title}${!episode && request.year !== null ? ` ${request.year}` : ""}${episode}`;
    const items = await this.options.client.search(
      context.profileId ?? "default",
      query,
      request.limit,
      context.signal,
    );
    return items.map((item) => ({
      ref: { providerId: "hellspy", candidateId: hellspyCandidateId(item) },
      releaseName: item.title,
      sizeBytes: item.size,
      seasonNumber: request.seasonNumber,
      episodeNumber: request.episodeNumber,
      confidence: 0.5,
      provenance: this.provenance(true),
    }));
  }
  private async resolve(
    raw: MediaCandidateRef,
    context: ProviderContext,
    quality?: string,
  ): Promise<{ file: HellspyVideoDetail; variant: MediaVariant; url: string }> {
    const candidate = MediaCandidateRefSchema.parse(raw);
    if (candidate.providerId !== "hellspy")
      throw new ProviderRequestError("hellspy", "invalid-response", false);
    const file = await this.options.client.detail(
      context.profileId ?? "default",
      candidate.candidateId,
      context.signal,
    );
    const selected =
      quality ??
      (file.conversions["0"]
        ? "0"
        : Object.keys(file.conversions).sort(
            (a, b) => Number(b) - Number(a),
          )[0]);
    const url = selected ? file.conversions[selected] : undefined;
    if (!selected || !url)
      throw new ProviderRequestError("hellspy", "forbidden", false);
    const original = selected === "0";
    return {
      file,
      url,
      variant: {
        ref: candidate,
        variantId: `${candidate.candidateId}:${selected}`,
        format: {
          label: original ? "Original" : `${selected}p`,
          container: original
            ? (/\.([a-z0-9]{2,5})$/i.exec(file.filename)?.[1]?.toLowerCase() ??
              null)
            : "mp4",
          resolution: original ? null : `${selected}p`,
          videoCodec: null,
          audioLanguages: [],
          subtitleLanguages: [],
        },
        directPlay: true,
        supportsHttpRange: false,
        embeddedSubtitles: [],
        provenance: this.provenance(),
        expiresAt: null,
      },
    };
  }
  async inspect(
    candidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<MediaVariant> {
    const { variant, url } = await this.resolve(candidate, context);
    return {
      ...variant,
      supportsHttpRange: await this.options.client.probeUrl(
        url,
        context.signal,
      ),
    };
  }
  private quality(candidateId: string, variantId: string): string {
    if (!variantId.startsWith(`${candidateId}:`))
      throw new ProviderRequestError("hellspy", "invalid-response", false);
    const quality = variantId.slice(candidateId.length + 1);
    if (!/^(0|240|360|480|576|720|1080|1440|2160|4320)$/.test(quality))
      throw new ProviderRequestError("hellspy", "invalid-response", false);
    return quality;
  }
  async createPlayback(
    raw: PlaybackRequest,
    context: ProviderContext,
  ): Promise<PlaybackGrant> {
    const request = PlaybackRequestSchema.parse(raw);
    if (request.profileId !== (context.profileId ?? "default"))
      throw new ProviderRequestError("hellspy", "forbidden", false);
    const { file, url, variant } = await this.resolve(
      {
        providerId: request.variant.providerId,
        candidateId: request.variant.candidateId,
      },
      context,
      this.quality(request.variant.candidateId, request.variant.variantId),
    );
    const supportsHttpRange = await this.options.client.probeUrl(
      url,
      context.signal,
    );
    const grantId = randomUUID();
    const expiresAt = new Date(this.#now().getTime() + 60_000).toISOString();
    const ticketUrl = await this.options.issuePlaybackTicket({
      grantId,
      profileId: request.profileId,
      providerId: "hellspy",
      titleId: request.titleId,
      seasonNumber: request.seasonNumber ?? null,
      episodeNumber: request.episodeNumber ?? null,
      candidateId: request.variant.candidateId,
      variantId: variant.variantId,
      directUrl: url,
      expiresAt,
      supportsHttpRange,
      // Search size belongs to the original upload, not necessarily the selected conversion.
      sourceSizeBytes: variant.variantId.endsWith(":0") ? file.size : null,
      sourceFilename: file.filename,
    });
    return PlaybackGrantSchema.parse({
      grantId,
      titleId: request.titleId,
      providerId: "hellspy",
      variantId: variant.variantId,
      url: ticketUrl,
      supportsHttpRange,
      expiresAt,
      embeddedSubtitles: [],
    });
  }
  async refreshPlaybackSource(
    raw: Parameters<NonNullable<MediaProvider["refreshPlaybackSource"]>>[0],
    context: ProviderContext,
  ): Promise<string> {
    const request = PlaybackSourceRefreshRequestSchema.parse(raw);
    return (
      await this.resolve(
        request.candidate,
        context,
        this.quality(request.candidate.candidateId, request.variantId),
      )
    ).url;
  }
  async checkPlayback(
    candidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<PlaybackLanguageAvailability | void> {
    const { url } = await this.resolve(candidate, context);
    await this.options.client.probeUrl(url, context.signal);
    if (!this.options.probeMedia) return;
    const media = await this.options.probeMedia(url);
    return {
      audioLanguages: [
        ...new Set(
          media.audioTracks.flatMap((t) => (t.language ? [t.language] : [])),
        ),
      ],
      subtitleLanguages: [
        ...new Set(
          media.subtitleTracks.flatMap((t) => (t.language ? [t.language] : [])),
        ),
      ],
    };
  }
}
