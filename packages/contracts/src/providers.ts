import { z } from "zod";

import {
  CatalogTitleSchema,
  DiscoveryRequestSchema,
  MediaFormatSchema,
  MediaKindSchema,
  SourceRatingSchema,
  type PlaybackLanguageAvailability,
} from "./media.js";
import {
  ExternalEntityRefSchema,
  FieldProvenanceSchema,
  ProviderDescriptorSchema,
  type ExternalEntityRef,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth,
} from "./provider-common.js";

type FamilyDescriptor<TFamily extends ProviderDescriptor["family"]> = Omit<
  ProviderDescriptor,
  "family"
> & { family: TFamily };

export type MetadataProviderDescriptor = FamilyDescriptor<"metadata">;
export type MediaProviderDescriptor = FamilyDescriptor<"media">;
export type SubtitleProviderDescriptor = FamilyDescriptor<"subtitle">;
export type SearchProviderDescriptor = FamilyDescriptor<"search">;
export type AgentProviderDescriptor = FamilyDescriptor<"agent">;
export type SyncProviderDescriptor = FamilyDescriptor<"sync">;

export const MetadataSearchQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    kind: MediaKindSchema.nullable(),
    year: z.number().int().min(1870).max(2200).nullable(),
    person: z.string().trim().min(1).max(160).nullable(),
    locale: z.string().trim().min(2).max(16),
    limit: z.number().int().min(1).max(50),
  })
  .strict();
export type MetadataSearchQuery = z.infer<typeof MetadataSearchQuerySchema>;

export const MetadataCandidateSchema = z
  .object({
    ref: ExternalEntityRefSchema,
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(240),
    originalTitle: z.string().trim().min(1).max(240).nullable(),
    year: z.number().int().min(1870).max(2200).nullable(),
    confidence: z.number().min(0).max(1),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type MetadataCandidate = z.infer<typeof MetadataCandidateSchema>;

export const CanonicalTitlePayloadSchema = z
  .object({
    ref: ExternalEntityRefSchema,
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(240),
    originalTitle: z.string().trim().min(1).max(240).nullable(),
    localizedTitles: z
      .array(
        z
          .object({
            locale: z.string().trim().min(2).max(16),
            value: z.string().trim().min(1).max(240),
            provenance: FieldProvenanceSchema,
          })
          .strict(),
      )
      .max(50),
    year: z.number().int().min(1870).max(2200).nullable(),
    synopsis: z.string().trim().max(1_500),
    genres: z.array(z.string().trim().min(1).max(60)).max(20),
    posterUrl: z.string().url().nullable(),
    backdropUrl: z.string().url().nullable(),
    fieldProvenance: z.record(z.string().min(1), FieldProvenanceSchema),
  })
  .strict();
export type CanonicalTitlePayload = z.infer<typeof CanonicalTitlePayloadSchema>;

export const EpisodeStructureSchema = z
  .object({
    ref: ExternalEntityRefSchema,
    episodeNumber: z.number().int().positive(),
    title: z.string().trim().min(1).max(240),
    airDate: z.string().date().nullable(),
    runtimeMinutes: z.number().int().positive().nullable(),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type EpisodeStructure = z.infer<typeof EpisodeStructureSchema>;

export const SeasonStructureSchema = z
  .object({
    ref: ExternalEntityRefSchema,
    seasonNumber: z.number().int().nonnegative(),
    title: z.string().trim().min(1).max(240).nullable(),
    episodes: z.array(EpisodeStructureSchema).max(1_000),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type SeasonStructure = z.infer<typeof SeasonStructureSchema>;

export const SeriesStructureSchema = z
  .object({
    seriesRef: ExternalEntityRefSchema,
    seasons: z.array(SeasonStructureSchema).max(200),
    complete: z.boolean(),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type SeriesStructure = z.infer<typeof SeriesStructureSchema>;

export const DiscoveryFeedRequestSchema = z
  .object({
    feed: z.enum(["new-releases", "trending", "top-rated"]),
    kind: MediaKindSchema.nullable(),
    locale: z.string().trim().min(2).max(16),
    region: z.string().trim().length(2).nullable(),
    from: z.string().date().nullable(),
    to: z.string().date().nullable(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export type DiscoveryFeedRequest = z.infer<typeof DiscoveryFeedRequestSchema>;

export const MediaSearchRequestSchema = z
  .object({
    titleId: z.string().trim().min(1).max(160),
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(240),
    originalTitle: z.string().trim().min(1).max(240).nullable(),
    year: z.number().int().min(1870).max(2200).nullable(),
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    externalRefs: z.array(ExternalEntityRefSchema).max(20),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export type MediaSearchRequest = z.infer<typeof MediaSearchRequestSchema>;

export const MediaCandidateRefSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    candidateId: z.string().trim().min(1).max(240),
  })
  .strict();
export type MediaCandidateRef = z.infer<typeof MediaCandidateRefSchema>;

export const MediaCandidateSchema = z
  .object({
    ref: MediaCandidateRefSchema,
    releaseName: z.string().trim().min(1).max(500),
    sizeBytes: z.number().int().nonnegative().nullable(),
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    confidence: z.number().min(0).max(1),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type MediaCandidate = z.infer<typeof MediaCandidateSchema>;

export const EmbeddedSubtitleTrackSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    language: z.string().trim().min(2).max(16),
    label: z.string().trim().min(1).max(120).nullable(),
    format: z.string().trim().min(1).max(24),
    forced: z.boolean(),
    hearingImpaired: z.boolean(),
  })
  .strict();
export type EmbeddedSubtitleTrack = z.infer<typeof EmbeddedSubtitleTrackSchema>;

export const MediaVariantSchema = z
  .object({
    ref: MediaCandidateRefSchema,
    variantId: z.string().trim().min(1).max(240),
    format: MediaFormatSchema,
    directPlay: z.boolean(),
    supportsHttpRange: z.boolean(),
    embeddedSubtitles: z.array(EmbeddedSubtitleTrackSchema).max(100),
    provenance: FieldProvenanceSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type MediaVariant = z.infer<typeof MediaVariantSchema>;

export const PlaybackRequestSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    titleId: z.string().trim().min(1).max(160),
    seasonNumber: z.number().int().positive().nullable().optional(),
    episodeNumber: z.number().int().positive().nullable().optional(),
    variant: MediaCandidateRefSchema.extend({
      variantId: z.string().trim().min(1).max(240),
    }).strict(),
    startPositionSeconds: z.number().nonnegative(),
  })
  .strict();
export type PlaybackRequest = z.infer<typeof PlaybackRequestSchema>;

export const PlaybackGrantSchema = z
  .object({
    grantId: z.string().trim().min(1).max(160),
    titleId: z.string().trim().min(1).max(160),
    providerId: z.string().trim().min(1).max(80),
    variantId: z.string().trim().min(1).max(240),
    url: z.string().refine((value) => {
      if (/^\/api\/v1\/playback\/grants\/[A-Za-z0-9_-]+$/.test(value)) {
        return true;
      }
      try {
        const parsed = new URL(value);
        return (
          parsed.protocol === "https:" ||
          (parsed.protocol === "http:" &&
            ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))
        );
      } catch {
        return false;
      }
    }, "Expected a secure URL or a same-origin playback grant path"),
    supportsHttpRange: z.boolean(),
    expiresAt: z.string().datetime({ offset: true }),
    embeddedSubtitles: z.array(EmbeddedSubtitleTrackSchema).max(100),
  })
  .strict();
export type PlaybackGrant = z.infer<typeof PlaybackGrantSchema>;

export const PlaybackAudioTrackSchema = z
  .object({
    streamIndex: z.number().int().nonnegative(),
    codec: z.string().trim().min(1).max(80),
    channels: z.number().int().min(1).max(8),
    channelLayout: z.string().trim().max(80).nullable(),
    language: z.string().trim().max(16).nullable(),
    title: z.string().trim().max(80).nullable(),
  })
  .strict();
export type PlaybackAudioTrack = z.infer<typeof PlaybackAudioTrackSchema>;

export const PlaybackSubtitleTrackSchema = z
  .object({
    streamIndex: z.number().int().nonnegative(),
    codec: z.string().trim().min(1).max(80),
    language: z.string().trim().max(16).nullable(),
    title: z.string().trim().max(80).nullable(),
  })
  .strict();
export type PlaybackSubtitleTrack = z.infer<typeof PlaybackSubtitleTrackSchema>;

/** Embedded subtitles are extracted near playback, never from the entire film. */
export const SUBTITLE_WINDOW_SECONDS = 10;
export const SUBTITLE_WINDOW_OVERLAP_SECONDS = 2;

export function subtitleWindowStart(seconds: number): number {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return (
    Math.floor(safeSeconds / SUBTITLE_WINDOW_SECONDS) * SUBTITLE_WINDOW_SECONDS
  );
}

export const PlaybackMediaInfoSchema = z
  .object({
    durationSeconds: z.number().positive().max(86_400).nullable(),
    videoCodec: z.string().trim().min(1).max(80),
    videoPixelFormat: z.string().trim().max(80).nullable(),
    audioTracks: z.array(PlaybackAudioTrackSchema).max(20),
    subtitleTracks: z.array(PlaybackSubtitleTrackSchema).max(20),
  })
  .strict();
export type PlaybackMediaInfo = z.infer<typeof PlaybackMediaInfoSchema>;

export const SubtitleSearchRequestSchema = z
  .object({
    titleId: z.string().trim().min(1).max(160),
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(240),
    year: z.number().int().min(1870).max(2200).nullable(),
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    languages: z.array(z.string().trim().min(2).max(16)).min(1).max(20),
    mediaHash: z.string().trim().min(8).max(256).nullable(),
    releaseName: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();
export type SubtitleSearchRequest = z.infer<typeof SubtitleSearchRequestSchema>;

export const SubtitleCandidateRefSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    candidateId: z.string().trim().min(1).max(240),
  })
  .strict();
export type SubtitleCandidateRef = z.infer<typeof SubtitleCandidateRefSchema>;

export const SubtitleCandidateSchema = z
  .object({
    ref: SubtitleCandidateRefSchema,
    language: z.string().trim().min(2).max(16),
    format: z.enum(["srt", "vtt", "ass", "ssa"]),
    releaseName: z.string().trim().min(1).max(500).nullable(),
    hearingImpaired: z.boolean(),
    matchConfidence: z.number().min(0).max(1),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type SubtitleCandidate = z.infer<typeof SubtitleCandidateSchema>;

export const SubtitleAssetSchema = z
  .object({
    ref: SubtitleCandidateRefSchema,
    language: z.string().trim().min(2).max(16),
    format: z.enum(["srt", "vtt", "ass", "ssa"]),
    content: z.string().min(1).max(10_000_000),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/i),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type SubtitleAsset = z.infer<typeof SubtitleAssetSchema>;

export const WebSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    locale: z.string().trim().min(2).max(16),
    maxResults: z.number().int().min(1).max(20),
    allowedHosts: z.array(z.string().trim().min(1).max(253)).max(100),
    blockedHosts: z.array(z.string().trim().min(1).max(253)).max(100),
    publishedAfter: z.string().date().nullable(),
  })
  .strict();
export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

export const WebSearchResultSchema = z
  .object({
    url: z.string().url(),
    title: z.string().trim().min(1).max(500),
    snippet: z.string().trim().max(2_000),
    publishedAt: z.string().datetime({ offset: true }).nullable(),
    sanitized: z.literal(true),
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

export const WebSearchResponseSchema = z
  .object({
    results: z.array(WebSearchResultSchema).max(20),
    queryBudgetRemaining: z.number().int().nonnegative(),
    cacheExpiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type WebSearchResponse = z.infer<typeof WebSearchResponseSchema>;

export const AgentCapabilitiesSchema = z
  .object({
    models: z.array(z.string().trim().min(1).max(160)).max(100),
    structuredOutput: z.boolean(),
    toolCalling: z.boolean(),
    maxContextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentGenerationRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(160),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant", "tool"]),
            content: z.string().max(50_000),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    outputSchemaName: z.string().trim().min(1).max(120),
    outputJsonSchema: z.record(z.string(), z.unknown()),
    allowedToolNames: z.array(z.string().trim().min(1).max(120)).max(30),
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().positive().max(65_536),
  })
  .strict();
export type AgentGenerationRequest = z.infer<
  typeof AgentGenerationRequestSchema
>;

export interface AgentGenerationResult<TOutput = unknown> {
  output: TOutput;
  model: string;
  finishReason: "completed" | "length" | "cancelled" | "failed";
  inputTokens: number | null;
  outputTokens: number | null;
  provenance: z.infer<typeof FieldProvenanceSchema>;
}

export const SyncOperationSchema = z
  .object({
    operationId: z.string().trim().min(1).max(120),
    deviceId: z.string().trim().min(1).max(120),
    profileId: z.string().trim().min(1).max(120).nullable(),
    entityType: z.string().trim().min(1).max(120),
    entityId: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    hybridLogicalClock: z.string().trim().min(1).max(120),
    payload: z.unknown(),
    tombstone: z.boolean(),
  })
  .strict();
export type SyncOperation = z.infer<typeof SyncOperationSchema>;

export const SyncPushRequestSchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).nullable(),
    operations: z.array(SyncOperationSchema).max(1_000),
  })
  .strict();
export type SyncPushRequest = z.infer<typeof SyncPushRequestSchema>;

export const SyncPushResultSchema = z
  .object({
    acceptedOperationIds: z.array(z.string().trim().min(1).max(120)).max(1_000),
    cursor: z.string().trim().min(1).max(512),
  })
  .strict();
export type SyncPushResult = z.infer<typeof SyncPushResultSchema>;

export const SyncPullRequestSchema = z
  .object({
    cursor: z.string().trim().min(1).max(512).nullable(),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();
export type SyncPullRequest = z.infer<typeof SyncPullRequestSchema>;

export const SyncPullResultSchema = z
  .object({
    operations: z.array(SyncOperationSchema).max(1_000),
    cursor: z.string().trim().min(1).max(512),
    hasMore: z.boolean(),
  })
  .strict();
export type SyncPullResult = z.infer<typeof SyncPullResultSchema>;

export const SyncSnapshotSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    cursor: z.string().trim().min(1).max(512),
    createdAt: z.string().datetime({ offset: true }),
    state: z.unknown(),
  })
  .strict();
export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;

/** Concrete adapters must not leak provider SDK response types past these boundaries. */
export interface MetadataProvider {
  descriptor(): MetadataProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(
    query: MetadataSearchQuery,
    context: ProviderContext,
  ): Promise<MetadataCandidate[]>;
  getTitle(
    ref: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<CanonicalTitlePayload>;
  getSeriesStructure(
    ref: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<SeriesStructure>;
  getRatings(
    ref: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<z.infer<typeof SourceRatingSchema>[]>;
  getFeed(
    request: DiscoveryFeedRequest,
    context: ProviderContext,
  ): Promise<MetadataCandidate[]>;
}

export interface MediaProvider {
  descriptor(): MediaProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(
    request: MediaSearchRequest,
    context: ProviderContext,
  ): Promise<MediaCandidate[]>;
  inspect(
    candidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<MediaVariant>;
  /** Verifies the source can serve media without minting a playback grant. */
  checkPlayback?(
    candidate: MediaCandidateRef,
    context: ProviderContext,
  ): Promise<PlaybackLanguageAvailability | void>;
  createPlayback(
    request: PlaybackRequest,
    context: ProviderContext,
  ): Promise<PlaybackGrant>;
}

export interface SubtitleProvider {
  descriptor(): SubtitleProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(
    request: SubtitleSearchRequest,
    context: ProviderContext,
  ): Promise<SubtitleCandidate[]>;
  fetch(
    candidate: SubtitleCandidateRef,
    context: ProviderContext,
  ): Promise<SubtitleAsset>;
}

export interface SearchProvider {
  descriptor(): SearchProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  search(
    request: WebSearchRequest,
    context: ProviderContext,
  ): Promise<WebSearchResponse>;
}

export interface AgentProvider {
  descriptor(): AgentProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  capabilities(context: ProviderContext): Promise<AgentCapabilities>;
  generateStructured<TOutput>(
    request: AgentGenerationRequest,
    context: ProviderContext,
  ): Promise<AgentGenerationResult<TOutput>>;
}

export interface SyncProvider {
  descriptor(): SyncProviderDescriptor;
  health(context: ProviderContext): Promise<ProviderHealth>;
  push(
    request: SyncPushRequest,
    context: ProviderContext,
  ): Promise<SyncPushResult>;
  pull(
    request: SyncPullRequest,
    context: ProviderContext,
  ): Promise<SyncPullResult>;
  getSnapshot(context: ProviderContext): Promise<SyncSnapshot>;
  putSnapshot(snapshot: SyncSnapshot, context: ProviderContext): Promise<void>;
}

/** Optional compatibility boundary for an agent dedicated to discovery turns. */
export interface DiscoveryAgentProvider extends AgentProvider {
  discover(
    request: z.infer<typeof DiscoveryRequestSchema>,
    context: ProviderContext,
  ): Promise<z.infer<typeof CatalogTitleSchema>[]>;
}

/** Runtime registries depend only on descriptor family, never concrete ids. */
export interface ProviderRegistry<TProvider> {
  list(): readonly TProvider[];
  get(id: string): TProvider | null;
  require(id: string): TProvider;
}

export function assertProviderDescriptorFamily<
  TFamily extends ProviderDescriptor["family"],
>(descriptor: ProviderDescriptor, family: TFamily): FamilyDescriptor<TFamily> {
  const parsed = ProviderDescriptorSchema.parse(descriptor);
  if (parsed.family !== family) {
    throw new Error(
      `Provider '${parsed.id}' belongs to '${parsed.family}', expected '${family}'.`,
    );
  }
  return parsed as FamilyDescriptor<TFamily>;
}
