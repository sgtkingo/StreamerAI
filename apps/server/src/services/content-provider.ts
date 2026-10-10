import {
  CatalogTitleSchema,
  DiscoveryResponseSchema,
  HomeFeedSchema,
  type CatalogTitle,
  type ContentMode,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type HomeFeed,
  type PlaybackGrant,
  type PlaybackLanguageAvailability,
  type SeriesDetail,
  type EpisodeSelection,
  type TitleSource,
} from "@streamer-ai/contracts";
import { randomUUID } from "node:crypto";

export interface HomeFeedInput {
  profileId: string;
  generatedAt: string;
  titles: readonly CatalogTitle[];
}

/**
 * Coordinates agent discovery and deterministic provider validation.
 * Implementations may compose any AgentProvider, MetadataProvider and
 * MediaProvider adapters, while StreamerCore remains responsible for local
 * profiles, canonical persistence, Library and History.
 */
export interface StreamerContentProvider {
  readonly id: string;
  readonly mode: ContentMode;
  bootstrapTitles(): readonly CatalogTitle[];
  buildHome(input: HomeFeedInput): HomeFeed;
  discover(
    request: DiscoveryRequest,
    completedAt: string,
    context?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse>;
  /** Deterministic metadata/media search with no agent invocation. */
  discoverFast?(
    request: DiscoveryRequest,
    completedAt: string,
    context?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse>;
  /** Revalidate availability and mint a short-lived URL immediately before playback. */
  checkPlayback?(
    profileId: string,
    title: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): Promise<PlaybackLanguageAvailability | void>;
  preparePlayback?(
    profileId: string,
    title: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): Promise<PlaybackGrant>;
  getSeriesDetail?(
    profileId: string,
    title: CatalogTitle,
    retry?: boolean,
  ): Promise<SeriesDetail>;
  /** Explicit title-wide media recheck; automatic episode discovery remains independent. */
  forceSearchTitle?(
    profileId: string,
    title: CatalogTitle,
  ): Promise<CatalogTitle>;
  forceSearchEpisode?(
    profileId: string,
    title: CatalogTitle,
    episode: EpisodeSelection,
  ): Promise<TitleSource[]>;
}

export interface DiscoveryConversationMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: unknown;
  readonly createdAt: string;
}

export interface DiscoveryConversationContext {
  readonly sessionId: string;
  readonly messages: readonly DiscoveryConversationMessage[];
  readonly unseen?: {
    readonly titleIds: readonly string[];
    readonly titles: readonly string[];
  };
  readonly signal?: AbortSignal;
}

const format = {
  label: "1080p - H.264",
  container: "mkv",
  resolution: "1080p",
  videoCodec: "H.264",
  audioLanguages: ["en"],
  subtitleLanguages: ["cs", "en"],
} as const;

function title(
  input: Pick<
    CatalogTitle,
    "id" | "kind" | "title" | "year" | "synopsis" | "accentColor" | "genres"
  > &
    Partial<
      Pick<CatalogTitle, "availability" | "progressPercent" | "seriesCoverage">
    >,
): CatalogTitle {
  const available = input.availability ?? "available";
  return CatalogTitleSchema.parse({
    id: input.id,
    kind: input.kind,
    title: input.title,
    originalTitle: null,
    year: input.year,
    synopsis: input.synopsis,
    posterUrl: null,
    backdropUrl: null,
    accentColor: input.accentColor,
    genres: input.genres,
    ratings: [{ source: "Preview", value: 8.1, scale: 10, votes: null }],
    matchPercent: null,
    availability: available,
    availabilityProvider: "preview-fixture",
    availabilityCheckedAt: "2026-09-27T12:00:00.000Z",
    formats:
      available === "available" || available === "partial" ? [format] : [],
    seriesCoverage: input.seriesCoverage ?? null,
    metadataProvider: "preview-fixture",
    metadataValidatedAt: "2026-09-27T12:00:00.000Z",
    inLibrary: false,
    progressPercent: input.progressPercent ?? null,
  });
}

const previewTitles = [
  title({
    id: "sai:preview:lake-house",
    kind: "movie",
    title: "The Lake House",
    year: 2006,
    synopsis:
      "Two people discover that a lakeside mailbox can bridge the years between them.",
    accentColor: "#6b4a3f",
    genres: ["Romance", "Drama"],
  }),
  title({
    id: "sai:preview:practical-magic",
    kind: "movie",
    title: "Practical Magic",
    year: 1998,
    synopsis:
      "Two sisters navigate family magic, love and a small town full of secrets.",
    accentColor: "#3b584a",
    genres: ["Fantasy", "Romance"],
  }),
  title({
    id: "sai:preview:knives-out",
    kind: "movie",
    title: "Knives Out",
    year: 2019,
    synopsis:
      "A detective untangles the secrets surrounding a novelist's unusual death.",
    accentColor: "#79322f",
    genres: ["Mystery", "Comedy"],
  }),
  title({
    id: "sai:preview:arrival",
    kind: "movie",
    title: "Arrival",
    year: 2016,
    synopsis:
      "A linguist is asked to find a way to communicate with visitors from beyond Earth.",
    accentColor: "#384c59",
    genres: ["Science fiction", "Drama"],
  }),
  title({
    id: "sai:preview:only-murders",
    kind: "series",
    title: "Only Murders in the Building",
    year: 2021,
    synopsis:
      "Three neighbours turn their shared obsession with true crime into an investigation.",
    accentColor: "#aa6c32",
    genres: ["Comedy", "Mystery"],
    availability: "partial",
    seriesCoverage: {
      seasonsAvailable: 3,
      seasonsTotal: 5,
      episodesAvailable: 26,
      episodesTotal: 50,
      complete: false,
      nextEpisodeLabel: "S02 E04",
    },
  }),
  title({
    id: "sai:preview:before-sunrise",
    kind: "movie",
    title: "Before Sunrise",
    year: 1995,
    synopsis:
      "Two travellers spend one night walking and talking through Vienna.",
    accentColor: "#73564c",
    genres: ["Romance", "Drama"],
    availability: "unavailable",
  }),
  title({
    id: "sai:preview:past-lives",
    kind: "movie",
    title: "Past Lives",
    year: 2023,
    synopsis:
      "Childhood friends reunite years later and reflect on the lives they might have shared.",
    accentColor: "#5d7480",
    genres: ["Drama", "Romance"],
    availability: "unknown",
  }),
  title({
    id: "sai:preview:dark",
    kind: "series",
    title: "Dark",
    year: 2017,
    synopsis:
      "A missing child exposes a mystery spanning generations in a German town.",
    accentColor: "#39413e",
    genres: ["Mystery", "Science fiction"],
    seriesCoverage: {
      seasonsAvailable: 3,
      seasonsTotal: 3,
      episodesAvailable: 26,
      episodesTotal: 26,
      complete: true,
      nextEpisodeLabel: "S01 E01",
    },
  }),
] as const;

/** Explicit development fallback. It never claims to contain live provider data. */
export class PreviewContentProvider implements StreamerContentProvider {
  readonly id = "preview";
  readonly mode = "preview" as const;

  bootstrapTitles(): readonly CatalogTitle[] {
    return previewTitles;
  }

  buildHome(input: HomeFeedInput): HomeFeed {
    const items = input.titles;
    return HomeFeedSchema.parse({
      profileId: input.profileId,
      mode: "preview",
      generatedAt: input.generatedAt,
      sections: [
        {
          id: "continue-watching",
          title: "Continue Watching",
          subtitle: "Pick up where you left off",
          freshness: "fresh",
          items: items
            .filter((item) => item.progressPercent !== null)
            .slice(0, 3),
        },
        {
          id: "new-releases",
          title: "New Releases",
          subtitle: "Recently validated",
          freshness: "fresh",
          items: items.slice(4, 8),
        },
        {
          id: "trending",
          title: "Trending",
          subtitle: "What people are watching",
          freshness: "refreshing",
          items: items.slice(1, 6),
        },
        {
          id: "top-rated",
          title: "Top Rated",
          subtitle: "Strong source ratings",
          freshness: "fresh",
          items: items.slice(2, 7),
        },
        {
          id: "for-you",
          title: "Picks for You",
          subtitle: "A starting point for this profile",
          freshness: "fresh",
          items: items.slice(0, 5),
        },
      ],
    });
  }

  async discover(
    request: DiscoveryRequest,
    completedAt: string,
  ): Promise<DiscoveryResponse> {
    const normalized = request.message.toLocaleLowerCase("en");
    const lead =
      normalized.includes("sandra") || normalized.includes("autumn")
        ? previewTitles[0]
        : normalized.includes("series") || normalized.includes("seri")
          ? previewTitles[4]
          : previewTitles[2];
    const remainingAvailable = previewTitles.filter(
      (item) =>
        item.id !== lead.id &&
        (item.availability === "available" || item.availability === "partial"),
    );
    const unavailable = previewTitles.filter(
      (item) => item.availability === "unavailable",
    );
    const unverified = previewTitles.filter(
      (item) => item.availability === "unknown",
    );

    return DiscoveryResponseSchema.parse({
      sessionId: request.sessionId ?? randomUUID(),
      mode: "preview",
      stage: "completed",
      reply:
        "Here is a provider-neutral preview of the validated result layout. Connect live providers to replace preview records. Is this what you had in mind? Tell me what to change.",
      bestMatch: {
        title: { ...lead, matchPercent: 94 },
        reason: "Closest match to the mood, people and format in your request.",
      },
      available: remainingAvailable.slice(0, 4).map((item, index) => ({
        title: { ...item, matchPercent: 88 - index * 4 },
        reason: "A related validated option with a playable preview variant.",
      })),
      unavailable: unavailable.map((item) => ({
        title: { ...item, matchPercent: 72 },
        reason: "Metadata found; no playable preview variant.",
      })),
      unverified: unverified.map((item) => ({
        title: { ...item, matchPercent: 68 },
        reason: "Metadata found; media source needs a recheck.",
      })),
      warnings: [
        "Preview fixture - ratings and availability are not live provider claims.",
      ],
      completedAt,
    });
  }
}
