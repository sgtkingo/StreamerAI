import { z } from "zod";

import {
  ExternalEntityRefSchema,
  FieldProvenanceSchema,
} from "./provider-common.js";

export const MEDIA_KINDS = ["movie", "series"] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const AVAILABILITY_STATES = [
  "available",
  "partial",
  "unavailable",
  "unknown",
] as const;
export const AvailabilityStateSchema = z.enum(AVAILABILITY_STATES);
export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;

export const CONTENT_MODES = ["live", "preview"] as const;
export const ContentModeSchema = z.enum(CONTENT_MODES);
export type ContentMode = z.infer<typeof ContentModeSchema>;

export const SourceRatingSchema = z
  .object({
    source: z.string().trim().min(1).max(60),
    value: z.number().min(0),
    scale: z.number().positive(),
    votes: z.number().int().nonnegative().nullable(),
    /** Required for live provider results; optional only for explicit preview fixtures. */
    provenance: FieldProvenanceSchema.optional(),
  })
  .strict()
  .superRefine((rating, context) => {
    if (rating.value > rating.scale) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value"],
        message: "Rating value cannot exceed its declared scale.",
      });
    }
  });
export type SourceRating = z.infer<typeof SourceRatingSchema>;

export const MediaFormatSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    container: z.string().trim().min(1).max(24).nullable(),
    resolution: z.string().trim().min(1).max(24).nullable(),
    videoCodec: z.string().trim().min(1).max(32).nullable(),
    audioLanguages: z.array(z.string().trim().min(2).max(16)).max(12),
    subtitleLanguages: z.array(z.string().trim().min(2).max(16)).max(12),
  })
  .strict();
export type MediaFormat = z.infer<typeof MediaFormatSchema>;

/** A selectable provider file, never a direct playback URL. */
export const TitleSourceSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    providerId: z.string().trim().min(1).max(80),
    candidateId: z.string().trim().min(1).max(240),
    releaseName: z.string().trim().min(1).max(500),
    sizeBytes: z.number().int().nonnegative().nullable(),
    format: MediaFormatSchema,
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    checkedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((source, context) => {
    if ((source.seasonNumber === null) !== (source.episodeNumber === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A source must identify both season and episode or neither.",
      });
    }
  });
export type TitleSource = z.infer<typeof TitleSourceSchema>;
export type PlaybackLanguageAvailability = Pick<
  MediaFormat,
  "audioLanguages" | "subtitleLanguages"
>;

export const SeriesCoverageSchema = z
  .object({
    seasonsAvailable: z.number().int().nonnegative(),
    seasonsTotal: z.number().int().nonnegative(),
    episodesAvailable: z.number().int().nonnegative(),
    episodesTotal: z.number().int().nonnegative(),
    complete: z.boolean(),
    nextEpisodeLabel: z.string().trim().min(1).max(80).nullable(),
  })
  .strict()
  .superRefine((coverage, context) => {
    if (
      coverage.seasonsAvailable > coverage.seasonsTotal ||
      coverage.episodesAvailable > coverage.episodesTotal
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Available series coverage cannot exceed the expected structure.",
      });
    }
    const actuallyComplete =
      coverage.seasonsTotal > 0 &&
      coverage.episodesTotal > 0 &&
      coverage.seasonsAvailable === coverage.seasonsTotal &&
      coverage.episodesAvailable === coverage.episodesTotal;
    if (coverage.complete !== actuallyComplete) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Series completeness must match verified season and episode coverage.",
      });
    }
  });
export type SeriesCoverage = z.infer<typeof SeriesCoverageSchema>;

export const CatalogTitleSchema = z
  .object({
    id: z.string().trim().min(1).max(160),
    kind: MediaKindSchema,
    title: z.string().trim().min(1).max(240),
    originalTitle: z.string().trim().min(1).max(240).nullable(),
    year: z.number().int().min(1870).max(2200).nullable(),
    synopsis: z.string().trim().max(1_500),
    posterUrl: z.string().url().nullable(),
    backdropUrl: z.string().url().nullable(),
    accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    genres: z.array(z.string().trim().min(1).max(60)).max(20),
    ratings: z.array(SourceRatingSchema).max(12),
    matchPercent: z.number().int().min(0).max(100).nullable(),
    availability: AvailabilityStateSchema,
    availabilityProvider: z.string().trim().min(1).max(80).nullable(),
    availabilityCheckedAt: z.string().datetime({ offset: true }).nullable(),
    formats: z.array(MediaFormatSchema).max(24),
    /** Ranked, distinct files for this title. Empty for legacy and preview records. */
    sources: z.array(TitleSourceSchema).max(1_000).optional(),
    seriesCoverage: SeriesCoverageSchema.nullable(),
    metadataProvider: z.string().trim().min(1).max(80),
    /** Stable source reference when the provider-backed title ID is shortened. */
    metadataRef: ExternalEntityRefSchema.optional(),
    metadataValidatedAt: z.string().datetime({ offset: true }),
    /** Rich provenance is mandatory when a containing response is in live mode. */
    metadataProvenance: FieldProvenanceSchema.optional(),
    availabilityProvenance: FieldProvenanceSchema.optional(),
    inLibrary: z.boolean(),
    progressPercent: z.number().min(0).max(100).nullable(),
    resumePositionSeconds: z.number().nonnegative().nullable().optional(),
    resumeEpisode: z
      .object({
        seasonNumber: z.number().int().positive(),
        episodeNumber: z.number().int().positive(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((title, context) => {
    const sourceIds = new Set<string>();
    for (const [index, source] of (title.sources ?? []).entries()) {
      if (sourceIds.has(source.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", index, "id"],
          message: "A title cannot contain the same source twice.",
        });
      }
      sourceIds.add(source.id);
      if (title.kind === "movie" && source.seasonNumber !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", index, "seasonNumber"],
          message: "Movie sources cannot identify an episode.",
        });
      }
      if (title.kind === "series" && source.seasonNumber === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources", index, "seasonNumber"],
          message: "Series sources must identify an episode.",
        });
      }
    }
    if (title.kind === "movie" && title.seriesCoverage !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Movies cannot contain series coverage.",
      });
    }
    if (title.kind === "movie" && title.availability === "partial") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availability"],
        message: "Movies cannot have partial series availability.",
      });
    }
    const streamable = ["available", "partial"].includes(title.availability);
    if (streamable && title.formats.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formats"],
        message: "Available titles require at least one verified format.",
      });
    }
    if (!streamable && title.formats.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["formats"],
        message: "Unplayable titles cannot expose playable formats.",
      });
    }
    const hasProvider = title.availabilityProvider !== null;
    const hasCheckedAt = title.availabilityCheckedAt !== null;
    if (hasProvider !== hasCheckedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availabilityCheckedAt"],
        message:
          "Availability provider and check timestamp must be present together.",
      });
    }
    if (title.availability !== "unknown" && (!hasProvider || !hasCheckedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availabilityProvider"],
        message:
          "Known availability requires provider provenance and a timestamp.",
      });
    }
    if (title.kind === "series") {
      if (streamable && title.seriesCoverage === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["seriesCoverage"],
          message: "Streamable series require verified episode coverage.",
        });
      }
      if (
        title.availability === "available" &&
        title.seriesCoverage !== null &&
        !title.seriesCoverage.complete
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["availability"],
          message: "Incomplete series coverage must be marked partial.",
        });
      }
      if (
        title.availability === "partial" &&
        (title.seriesCoverage === null ||
          title.seriesCoverage.complete ||
          title.seriesCoverage.episodesAvailable === 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["seriesCoverage"],
          message:
            "Partial series availability requires verified, incomplete playable coverage.",
        });
      }
    }
    if (
      title.metadataProvenance !== undefined &&
      title.metadataProvenance.providerId !== title.metadataProvider
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadataProvenance", "providerId"],
        message: "Metadata provenance must identify the metadata provider.",
      });
    }
    if (
      title.metadataRef !== undefined &&
      (title.metadataRef.providerId !== title.metadataProvider ||
        title.metadataRef.entityType !== title.kind)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadataRef"],
        message:
          "Metadata reference must identify the title and its metadata provider.",
      });
    }
    if (
      title.availabilityProvenance !== undefined &&
      title.availabilityProvider !== title.availabilityProvenance.providerId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["availabilityProvenance", "providerId"],
        message:
          "Availability provenance must identify the availability provider.",
      });
    }
  });
export type CatalogTitle = z.infer<typeof CatalogTitleSchema>;

export const SeriesEpisodeDetailSchema = z.object({
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().positive(),
  title: z.string().min(1).max(240),
  synopsis: z.string().trim().max(1_500).optional(),
  airDate: z.string().date().nullable(),
  availability: z.enum(["available", "searching", "unavailable"]),
});
export type SeriesEpisodeDetail = z.infer<typeof SeriesEpisodeDetailSchema>;

export const SeriesDetailSchema = z.object({
  status: z.enum(["searching", "complete", "partial", "unavailable", "failed"]),
  seasons: z.array(
    z.object({
      seasonNumber: z.number().int().nonnegative(),
      title: z.string().max(240).nullable(),
      episodes: z.array(SeriesEpisodeDetailSchema),
    }),
  ),
});
export type SeriesDetail = z.infer<typeof SeriesDetailSchema>;

export const TitleDetailSchema = z.object({
  title: CatalogTitleSchema,
  series: SeriesDetailSchema.nullable(),
  related: z.array(CatalogTitleSchema).max(12),
});
export type TitleDetail = z.infer<typeof TitleDetailSchema>;

export const EpisodeSelectionSchema = z
  .object({
    seasonNumber: z.number().int().nonnegative(),
    episodeNumber: z.number().int().positive(),
  })
  .strict();
export type EpisodeSelection = z.infer<typeof EpisodeSelectionSchema>;

function addMissingLiveProvenanceIssues(
  title: CatalogTitle,
  context: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (title.metadataProvenance === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "metadataProvenance"],
      message: "Live metadata requires complete field provenance.",
    });
  }
  if (title.availabilityProvenance === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "availabilityProvenance"],
      message: "Live availability requires complete field provenance.",
    });
  }
  for (const [ratingIndex, rating] of title.ratings.entries()) {
    if (rating.provenance === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "ratings", ratingIndex, "provenance"],
        message: "Live ratings require independent source provenance.",
      });
    }
  }
}

export const HOME_SECTION_IDS = [
  "continue-watching",
  "new-releases",
  "trending",
  "top-rated",
  "for-you",
] as const;
export const HomeSectionIdSchema = z.enum(HOME_SECTION_IDS);
export type HomeSectionId = z.infer<typeof HomeSectionIdSchema>;

export const HomeSectionSchema = z
  .object({
    id: HomeSectionIdSchema,
    title: z.string().trim().min(1).max(80),
    subtitle: z.string().trim().max(160),
    freshness: z.enum(["fresh", "refreshing", "stale"]),
    items: z.array(CatalogTitleSchema).max(30),
  })
  .strict();
export type HomeSection = z.infer<typeof HomeSectionSchema>;

export const HomeFeedSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    mode: ContentModeSchema,
    generatedAt: z.string().datetime({ offset: true }),
    sections: z.array(HomeSectionSchema).max(HOME_SECTION_IDS.length),
  })
  .strict()
  .superRefine((feed, context) => {
    if (feed.mode !== "live") return;
    for (const [sectionIndex, section] of feed.sections.entries()) {
      for (const [itemIndex, item] of section.items.entries()) {
        addMissingLiveProvenanceIssues(item, context, [
          "sections",
          sectionIndex,
          "items",
          itemIndex,
        ]);
      }
    }
  });
export type HomeFeed = z.infer<typeof HomeFeedSchema>;

export const DISCOVERY_STAGES = [
  "understanding",
  "finding-candidates",
  "validating-metadata",
  "checking-availability",
  "ranking",
  "completed",
  "needs-input",
  "needs-setup",
  "failed",
] as const;
export const DiscoveryStageSchema = z.enum(DISCOVERY_STAGES);
export type DiscoveryStage = z.infer<typeof DiscoveryStageSchema>;

export const DiscoveryRequestSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    message: z.string().trim().min(2).max(2_000),
    sessionId: z.string().trim().min(1).max(120).optional(),
    /** Initial parallel search may create its client-selected shared session. */
    createSession: z.boolean().optional(),
    idempotencyKey: z.string().trim().min(8).max(120),
  })
  .strict();
export type DiscoveryRequest = z.infer<typeof DiscoveryRequestSchema>;

const RankedTitleSchema = z
  .object({
    title: CatalogTitleSchema,
    reason: z.string().trim().min(1).max(320),
    episode: EpisodeSelectionSchema.optional(),
    episodeTitle: z.string().trim().min(1).max(240).optional(),
    episodeSynopsis: z.string().trim().min(1).max(1_500).optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if ((item.episodeTitle || item.episodeSynopsis) && !item.episode)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["episode"],
        message: "Episode metadata requires an episode selection.",
      });
    if (item.episode && item.title.kind !== "series")
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["episode"],
        message: "An episode result requires a series title.",
      });
  });
export type RankedTitle = z.infer<typeof RankedTitleSchema>;

export const DiscoveryResponseSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(120),
    mode: ContentModeSchema,
    stage: DiscoveryStageSchema,
    reply: z.string().trim().min(1).max(1_000),
    bestMatch: RankedTitleSchema.nullable(),
    available: z.array(RankedTitleSchema).max(30),
    unavailable: z.array(RankedTitleSchema).max(30),
    unverified: z.array(RankedTitleSchema).max(30),
    warnings: z.array(z.string().trim().min(1).max(240)).max(20),
    completedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.bestMatch !== null &&
      !["available", "partial"].includes(result.bestMatch.title.availability)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The best match must be streamable.",
      });
    }
    for (const [index, item] of result.available.entries()) {
      if (!["available", "partial"].includes(item.title.availability)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["available", index, "title", "availability"],
          message: "Available results must be deterministically streamable.",
        });
      }
    }
    for (const [index, item] of result.unavailable.entries()) {
      if (item.title.availability !== "unavailable") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unavailable", index, "title", "availability"],
          message: "Unavailable results must have confirmed unavailability.",
        });
      }
    }
    for (const [index, item] of result.unverified.entries()) {
      if (item.title.availability !== "unknown") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["unverified", index, "title", "availability"],
          message: "Unverified results must require an availability recheck.",
        });
      }
    }
    const ids = [
      ...(result.bestMatch === null ? [] : [result.bestMatch.title.id]),
      ...result.available.map((item) => item.title.id),
      ...result.unavailable.map((item) => item.title.id),
      ...result.unverified.map((item) => item.title.id),
    ];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Discovery groups cannot contain duplicates.",
      });
    }
    const ranked = [
      ...(result.bestMatch === null ? [] : [result.bestMatch]),
      ...result.available,
      ...result.unavailable,
      ...result.unverified,
    ];
    for (const [index, item] of ranked.entries()) {
      if (item.title.matchPercent === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ranking", index, "title", "matchPercent"],
          message: "Discovery results require an explicit match percentage.",
        });
      }
    }
    if (result.bestMatch === null && result.available.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bestMatch"],
        message:
          "A completed response with streamable candidates requires a best match.",
      });
    }
    if (result.bestMatch !== null) {
      const bestScore = result.bestMatch.title.matchPercent;
      const competingScores = [
        ...result.available,
        ...result.unavailable,
        ...result.unverified,
      ].flatMap((item) =>
        item.title.matchPercent === null ? [] : [item.title.matchPercent],
      );
      if (
        bestScore !== null &&
        competingScores.some((score) => score > bestScore)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["bestMatch", "title", "matchPercent"],
          message: "The best match must have the highest ranking score.",
        });
      }
    }
    const terminal = [
      "completed",
      "needs-input",
      "needs-setup",
      "failed",
    ].includes(result.stage);
    if (terminal !== (result.completedAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["completedAt"],
        message: "Only terminal discovery stages have a completion timestamp.",
      });
    }
    if (result.mode === "live") {
      for (const [index, item] of ranked.entries()) {
        addMissingLiveProvenanceIssues(item.title, context, ["ranking", index]);
      }
    }
  });
export type DiscoveryResponse = z.infer<typeof DiscoveryResponseSchema>;

export const LIBRARY_STATES = ["saved", "in-progress", "completed"] as const;
export const LibraryStateSchema = z.enum(LIBRARY_STATES);
export type LibraryState = z.infer<typeof LibraryStateSchema>;

export const LibraryEntrySchema = z
  .object({
    title: CatalogTitleSchema,
    state: LibraryStateSchema,
    membershipReason: z.enum(["explicit", "playback"]),
    addedAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
    lastPlayedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export const LibraryResponseSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    items: z.array(LibraryEntrySchema),
  })
  .strict();
export type LibraryResponse = z.infer<typeof LibraryResponseSchema>;

export const HistoryEventSchema = z
  .object({
    id: z.string().trim().min(1).max(120),
    title: CatalogTitleSchema,
    episodeLabel: z.string().trim().min(1).max(120).nullable(),
    occurredAt: z.string().datetime({ offset: true }),
    progressPercent: z.number().min(0).max(100),
    completed: z.boolean(),
  })
  .strict();
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export const HistoryResponseSchema = z
  .object({
    profileId: z.string().trim().min(1).max(120),
    items: z.array(HistoryEventSchema),
  })
  .strict();
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;
