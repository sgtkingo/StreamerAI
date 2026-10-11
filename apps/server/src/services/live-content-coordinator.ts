import {
  assertConnectorAttribution,
  CatalogTitleSchema,
  DiscoveryResponseSchema,
  HomeFeedSchema,
  MediaCandidateSchema,
  MetadataCandidateSchema,
  ProviderDescriptorSchema,
  TitleSourceSchema,
  type AgentProvider,
  type CatalogTitle,
  type DiscoveryRequest,
  type DiscoveryResponse,
  type FieldProvenance,
  type MediaCandidate,
  type MediaCandidateRef,
  type MediaFormat,
  type PlaybackLanguageAvailability,
  type MediaProvider,
  type MediaSearchRequest,
  type MetadataCandidate,
  type MetadataDiscoveryRequest,
  type MetadataProvider,
  type MetadataSearchQuery,
  type ProviderContext,
  type ProviderRegistry,
  type RankedTitle,
  type SeriesDetail,
  type SeriesStructure,
  type EpisodeSelection,
  type TitleSource,
} from "@streamer-ai/contracts";
import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../runtime-config.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";
import type {
  DiscoveryConversationContext,
  HomeFeedInput,
  StreamerContentProvider,
} from "./content-provider.js";
import {
  episodeSearchTerms,
  explicitEpisodeNumber,
  releaseEpisode,
} from "./episode-release.js";
import { discoveryInstructionPolicy } from "./discovery-instruction-policy.js";
import {
  parseThematicDiscoveryIntent,
  type ThematicDiscoveryIntent,
} from "./thematic-discovery-intent.js";

const AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["people", "candidates"],
  properties: {
    acknowledgement: { type: "string", maxLength: 220 },
    people: {
      type: "array",
      maxItems: 3,
      items: { type: "string", minLength: 1, maxLength: 160 },
    },
    candidates: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "kind", "year", "reason", "matchPercent"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 240 },
          kind: { type: "string", enum: ["movie", "series"] },
          year: {
            anyOf: [
              { type: "integer", minimum: 1870, maximum: 2200 },
              { type: "null" },
            ],
          },
          reason: { type: "string", minLength: 1, maxLength: 280 },
          matchPercent: { type: "integer", minimum: 1, maximum: 100 },
        },
      },
    },
  },
} as const;

interface AgentCandidate {
  title: string;
  kind: "movie" | "series";
  year: number | null;
  reason: string;
  matchPercent: number;
}

interface AgentPlan {
  acknowledgement: string;
  people: string[];
  candidates: AgentCandidate[];
}

interface ValidatedCandidate {
  ranked: RankedTitle;
  playbackCandidates: MediaCandidateRef[];
  seriesStructure?: SeriesStructure;
  episodeCandidates?: Map<string, MediaCandidateRef[]>;
}

interface SeriesSearchJob {
  structure?: SeriesStructure;
  candidates: Map<string, MediaCandidateRef[]>;
  running: boolean;
  failed: boolean;
  finished: boolean;
  lastAttemptAt?: number;
  controller?: AbortController;
}

function episodeKey(titleId: string, episode: EpisodeSelection): string {
  return `${titleId}:${episode.seasonNumber}:${episode.episodeNumber}`;
}

export interface LiveContentCoordinatorOptions {
  agent: AgentProvider;
  metadata: MetadataProvider | ProviderRegistry<MetadataProvider>;
  media: MediaProvider | ProviderRegistry<MediaProvider>;
  integrationStateStore: IntegrationStateStore;
  /** Resolve only opaque vault pointers; adapters fetch their own credentials. */
  secretRefForProvider?: (
    providerId: string,
    profileId: string,
  ) => string | null;
  inference: RuntimeConfig["inference"];
  inferenceForProfile?: (profileId: string) => RuntimeConfig["inference"];
  localeForProfile: (profileId: string) => "cs" | "en" | "de";
  loadEpisodeCandidates?: (titleId: string) => Array<{
    episode: EpisodeSelection;
    ref: MediaCandidateRef;
  }>;
  saveEpisodeCandidate?: (
    titleId: string,
    episode: EpisodeSelection,
    ref: MediaCandidateRef,
  ) => void;
  now?: () => Date;
}

function providerMap<T extends MetadataProvider | MediaProvider>(
  input: T | ProviderRegistry<T>,
  legacyId: string,
): ReadonlyMap<string, T> {
  // The single-provider form remains supported for existing integrations.
  // Real multi-provider composition uses AdapterRegistry, which validates IDs.
  const providers = "list" in input ? input.list() : [input];
  const registered = new Map<string, T>();
  for (const provider of providers) {
    const descriptor = provider.descriptor?.();
    const id = descriptor?.id ?? legacyId;
    if (registered.has(id))
      throw new Error(`Provider '${id}' is registered more than once.`);
    registered.set(id, provider);
  }
  if (registered.size === 0)
    throw new Error("At least one provider must be registered.");
  return registered;
}

function titleMetadataRef(
  title: CatalogTitle,
): MetadataCandidate["ref"] | null {
  if (title.metadataRef) return title.metadataRef;
  const match = /^sai:([^:]+):(movie|series):(.+)$/.exec(title.id);
  if (!match || match[2] !== title.kind) return null;
  return {
    providerId: match[1]!,
    entityType: title.kind,
    externalId: match[3]!,
  };
}

function canonicalTitleId(ref: MetadataCandidate["ref"]): string {
  const plain = `sai:${ref.providerId}:${ref.entityType}:${ref.externalId}`;
  if (plain.length <= 160) return plain;
  const digest = createHash("sha256")
    .update(ref.externalId)
    .digest("hex")
    .slice(0, 32);
  return `sai:${ref.providerId}:${ref.entityType}:sha256-${digest}`;
}

function metadataIdentity(candidate: MetadataCandidate): string {
  return `${candidate.kind}:${normalize(candidate.originalTitle ?? candidate.title)}:${candidate.year ?? ""}`;
}

function hasValidAttribution(
  provider: MetadataProvider | MediaProvider,
  candidate: { ref: { providerId: string }; provenance: FieldProvenance },
): boolean {
  const descriptor = ProviderDescriptorSchema.safeParse(
    provider.descriptor?.(),
  );
  // Legacy single-provider test fixtures may expose only a partial descriptor.
  // App registries validate every real adapter at composition time.
  if (!descriptor.success) return true;
  try {
    assertConnectorAttribution(descriptor.data, candidate);
    return true;
  } catch {
    return false;
  }
}

function preferNonPlayable(
  current: ValidatedCandidate | null,
  next: ValidatedCandidate,
): ValidatedCandidate {
  if (
    current === null ||
    (current.ranked.title.availability === "unavailable" &&
      next.ranked.title.availability === "unknown")
  )
    return next;
  return current;
}

function sourceQuality(
  candidate: MediaCandidate,
  variant: Awaited<ReturnType<MediaProvider["inspect"]>>,
): number {
  const resolution = variant.format.resolution?.toLowerCase() ?? "";
  const pixels =
    resolution.includes("2160") || resolution.includes("4k")
      ? 12
      : resolution.includes("1080")
        ? 8
        : resolution.includes("720")
          ? 4
          : 0;
  return (
    candidate.confidence * 100 +
    pixels +
    (variant.supportsHttpRange ? 4 : 0) +
    (variant.directPlay ? 2 : 0)
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAgentPlan(value: unknown): AgentPlan {
  const body = record(value);
  if (
    body === null ||
    !Array.isArray(body.people) ||
    !Array.isArray(body.candidates)
  ) {
    throw new Error("The discovery agent returned an invalid plan.");
  }
  const people = body.people.slice(0, 3).map((person) => {
    if (typeof person !== "string" || person.trim().length === 0) {
      throw new Error("The discovery agent returned an invalid person filter.");
    }
    return person.trim().slice(0, 160);
  });
  const candidates = body.candidates.slice(0, 6).map((raw) => {
    const item = record(raw);
    if (
      item === null ||
      typeof item.title !== "string" ||
      (item.kind !== "movie" && item.kind !== "series") ||
      !(
        item.year === null ||
        (Number.isInteger(item.year) &&
          Number(item.year) >= 1870 &&
          Number(item.year) <= 2200)
      ) ||
      typeof item.reason !== "string" ||
      !Number.isInteger(item.matchPercent)
    ) {
      throw new Error("The discovery agent returned an invalid candidate.");
    }
    const title = item.title.trim();
    const reason = item.reason.trim();
    const matchPercent = Number(item.matchPercent);
    if (
      title.length < 1 ||
      title.length > 240 ||
      reason.length < 1 ||
      reason.length > 280 ||
      matchPercent < 1 ||
      matchPercent > 100
    ) {
      throw new Error("The discovery agent returned an invalid candidate.");
    }
    return {
      title,
      kind: item.kind as "movie" | "series",
      year: item.year === null ? null : Number(item.year),
      reason,
      matchPercent,
    };
  });
  if (candidates.length === 0) {
    throw new Error("The discovery agent did not suggest any candidates.");
  }
  return {
    acknowledgement:
      typeof body.acknowledgement === "string"
        ? body.acknowledgement.trim().slice(0, 220)
        : "",
    people,
    candidates,
  };
}

function discoveryReply(
  locale: "cs" | "en" | "de",
  validatedCount: number,
  best: RankedTitle | null,
  acknowledgement: string,
  validationFailed = false,
): string {
  if (validatedCount === 0) {
    if (locale === "cs")
      return validationFailed
        ? "Ověření titulů teď selhalo. Zkontroluj připojení katalogu a zkus hledání znovu."
        : "Navržené tituly se nepodařilo potvrdit v katalogu. Zkus konkrétnější zadání.";
    if (locale === "de")
      return validationFailed
        ? "Die Titel konnten gerade nicht geprüft werden. Prüfe die Katalogverbindung und versuche es erneut."
        : "Die vorgeschlagenen Titel konnten im Katalog nicht bestätigt werden. Versuche eine genauere Anfrage.";
    return validationFailed
      ? "Title verification failed. Check the catalog connection and try again."
      : "I couldn't confirm the suggested titles in the catalog. Try a more specific request.";
  }
  let summary: string;
  let question: string;
  if (locale === "cs") {
    question = "Je to to, co sis představoval? Napiš mi, co mám změnit.";
    if (best !== null) summary = `Nejlepší ověřený tip je ${best.title.title}.`;
    else if (validatedCount > 0)
      summary = `Našel jsem ${validatedCount} odpovídající tituly, ale u žádného zatím nemám potvrzené přehrání.`;
    else
      summary =
        "Našel jsem několik námětů, ale žádný se nepodařilo spolehlivě ověřit.";
  } else if (locale === "de") {
    question =
      "Ist das, was du dir vorgestellt hast? Sag mir, was ich ändern soll.";
    if (best !== null)
      summary = `Der beste geprüfte Tipp ist ${best.title.title}.`;
    else if (validatedCount > 0)
      summary = `${validatedCount} passende Titel wurden gefunden, aber für keinen ist die Wiedergabe bisher bestätigt.`;
    else
      summary =
        "Einige Ideen wurden gefunden, aber keine konnte zuverlässig geprüft werden.";
  } else {
    question = "Is this what you had in mind? Tell me what to change.";
    if (best !== null)
      summary = `The best validated match is ${best.title.title}.`;
    else if (validatedCount > 0)
      summary = `${validatedCount} matching titles were found, but playback has not been confirmed for any of them.`;
    else summary = "I found some ideas, but none could be validated reliably.";
  }
  return `${acknowledgement ? `${acknowledgement} ` : ""}${summary} ${question}`;
}

function thematicReason(
  intent: ThematicDiscoveryIntent,
  locale: string,
): string {
  const scienceFiction = intent.genres.includes("Science fiction");
  if (locale === "cs") {
    if (intent.completeOnly)
      return scienceFiction
        ? "Ukončený sci-fi seriál; dostupnost všech dílů se ověřuje zvlášť."
        : "Ukončený seriál; dostupnost všech dílů se ověřuje zvlášť.";
    return "Odpovídá požadovanému žánru.";
  }
  if (locale === "de") {
    if (intent.completeOnly)
      return "Abgeschlossene Serie; die Verfügbarkeit aller Folgen wird getrennt geprüft.";
    return "Passt zum gewünschten Genre.";
  }
  if (intent.completeOnly)
    return "A concluded series; every episode is checked separately.";
  return "Matches the requested genre.";
}

function thematicReply(
  locale: string,
  intent: ThematicDiscoveryIntent,
  validatedCount: number,
  best: RankedTitle | null,
  validationFailed: boolean,
): string {
  if (validatedCount === 0) {
    if (locale === "cs")
      return validationFailed
        ? "Ověření nalezených titulů selhalo. Zkontroluj připojení katalogu a zkus to znovu."
        : "V katalogu jsem pro tento žánr nenašel vhodný titul.";
    if (locale === "de")
      return validationFailed
        ? "Die gefundenen Titel konnten nicht geprüft werden. Prüfe die Katalogverbindung und versuche es erneut."
        : "Im Katalog wurde kein passender Titel für dieses Genre gefunden.";
    return validationFailed
      ? "I found catalog matches but could not verify them. Check the catalog connection and try again."
      : "I couldn't find a matching title in the connected catalog.";
  }
  if (intent.completeOnly) {
    const confirmedComplete =
      best?.title.availability === "available" &&
      best.title.seriesCoverage?.complete === true;
    if (locale === "cs")
      return confirmedComplete
        ? `Našel jsem ukončený seriál s ověřenými všemi díly: ${best.title.title}. Je to ono?`
        : "Našel jsem ukončené seriály, ale zatím nemohu potvrdit dostupnost všech dílů. U návrhů vidíš aktuální dostupnost.";
    if (locale === "de")
      return confirmedComplete
        ? `Ich habe eine abgeschlossene Serie mit allen bestätigten Folgen gefunden: ${best.title.title}. Passt das?`
        : "Ich habe abgeschlossene Serien gefunden, kann aber noch nicht bestätigen, dass alle Folgen verfügbar sind. Die Vorschläge zeigen die aktuelle Verfügbarkeit.";
    return confirmedComplete
      ? `I found a concluded series with every episode confirmed playable: ${best.title.title}. Is this what you had in mind?`
      : "I found concluded series, but could not confirm that every episode is playable. The suggestions show current availability.";
  }
  if (locale === "cs")
    return best
      ? `Našel jsem tipy v požadovaném žánru. Nejlepší dostupný je ${best.title.title}. Je to ono?`
      : "Našel jsem odpovídající tituly, ale zatím nemohu potvrdit přehrávání.";
  if (locale === "de")
    return best
      ? `Ich habe passende Titel gefunden. Der beste verfügbare Treffer ist ${best.title.title}. Passt das?`
      : "Ich habe passende Titel gefunden, kann die Wiedergabe aber noch nicht bestätigen.";
  return best
    ? `I found matching titles. The best playable match is ${best.title.title}. Is this what you had in mind?`
    : "I found matching titles, but could not confirm playback yet.";
}

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 1);
}

function directEpisodeRequest(
  message: string,
): { episode: EpisodeSelection; titleQuery: string } | null {
  const match =
    /(?:^|[^a-z0-9])s\d{1,2}[ ._-]*e\d{1,3}(?:[^a-z0-9]|$)/i.exec(message) ??
    /(?:^|[^a-z0-9])\d{1,2}x\d{1,3}(?:[^a-z0-9]|$)/i.exec(message);
  if (!match) return null;
  const episode = explicitEpisodeNumber(match[0]);
  const titleQuery = message
    .replace(match[0], " ")
    .replace(/^(?:find|play|watch|najdi|pusť|pust|chci|hledám|hledam)\s+/i, "")
    .replace(/^[\s.,:;-]+|[\s.,:;-]+$/g, "");
  return episode && words(titleQuery).length > 0
    ? { episode, titleQuery }
    : null;
}

function titleMatchesRelease(
  candidate: MediaCandidate,
  title: string,
  originalTitle: string | null,
  year: number | null,
): boolean {
  const release = normalize(candidate.releaseName);
  const alternatives = [title, originalTitle]
    .filter((value): value is string => value !== null)
    .map(normalize);
  const matchingTitle = alternatives.some((alternative) => {
    if (alternative !== "" && ` ${release} `.includes(` ${alternative} `))
      return true;
    const titleWords = words(alternative);
    if (titleWords.length === 0) return false;
    const releaseWords = new Set(words(release));
    return (
      titleWords.filter((word) => releaseWords.has(word)).length /
        titleWords.length >=
      0.75
    );
  });
  if (!matchingTitle) return false;
  const releaseYears = candidate.releaseName.match(/\b(?:19|20)\d{2}\b/g);
  return (
    year === null ||
    releaseYears === null ||
    releaseYears.includes(String(year))
  );
}

function metadataScore(
  agent: AgentCandidate,
  candidate: MetadataCandidate,
): number {
  const requested = normalize(agent.title);
  const titles = [candidate.title, candidate.originalTitle]
    .filter((value): value is string => value !== null)
    .map(normalize);
  const titleScore = titles.includes(requested)
    ? 100
    : titles.some(
          (value) => value.includes(requested) || requested.includes(value),
        )
      ? 70
      : 0;
  const yearScore =
    agent.year === null || candidate.year === null
      ? 5
      : agent.year === candidate.year
        ? 20
        : Math.abs(agent.year - candidate.year) === 1
          ? 5
          : -30;
  return titleScore + yearScore + candidate.confidence * 10;
}

const FAST_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "film",
  "filmy",
  "filmů",
  "movie",
  "movies",
  "na",
  "nejaky",
  "nejaký",
  "o",
  "pro",
  "se",
  "serial",
  "seriál",
  "show",
  "the",
  "to",
  "with",
  "want",
  "chci",
  "mam",
  "mám",
]);

function fastSimilarity(
  message: string,
  candidate: MetadataCandidate,
  position: number,
): number {
  const query = normalize(message);
  const titles = [candidate.title, candidate.originalTitle]
    .filter((value): value is string => value !== null)
    .map(normalize);
  const terms = words(message).filter((term) => !FAST_STOP_WORDS.has(term));
  const overlap = Math.max(
    0,
    ...titles.map((title) => {
      const titleTerms = new Set(words(title));
      return terms.filter((term) => titleTerms.has(term)).length;
    }),
  );
  const exact = titles.some((title) => title === query);
  const contains = titles.some(
    (title) => query.includes(title) || title.includes(query),
  );
  const year = /\b(?:19|20)\d{2}\b/.exec(message)?.[0];
  const yearBonus = year && candidate.year === Number(year) ? 8 : 0;
  return Math.min(
    98,
    exact
      ? 98
      : contains
        ? 80 + yearBonus
        : 35 + overlap * 15 + yearBonus + Math.max(0, 9 - position),
  );
}

function accentColor(id: string): string {
  const digest = createHash("sha256").update(id).digest();
  const channels = [...digest.subarray(0, 3)].map((value) => 48 + (value % 96));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function uniqueFormats(formats: readonly MediaFormat[]): MediaFormat[] {
  const seen = new Set<string>();
  return formats.filter((format) => {
    const key = JSON.stringify(format);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sourceId(titleId: string, ref: MediaCandidateRef): string {
  return createHash("sha256")
    .update(`${titleId}\u0000${ref.providerId}\u0000${ref.candidateId}`)
    .digest("hex")
    .slice(0, 32);
}

function episodeNumber(
  releaseName: string,
  seriesTitle = "",
  originalTitle: string | null = null,
  structure?: SeriesStructure,
): { season: number; episode: number } | null {
  const selected = releaseEpisode(
    releaseName,
    [seriesTitle, originalTitle].filter((value): value is string =>
      Boolean(value),
    ),
    structure,
  );
  return selected
    ? { season: selected.seasonNumber, episode: selected.episodeNumber }
    : null;
}

function mediaSearchVariants(
  title: string,
  originalTitle: string | null,
  year: number | null,
  episode?: EpisodeSelection,
  structure?: SeriesStructure,
): {
  originalTitle: string | null;
  year: number | null;
  episodeSearchTerm?: string;
}[] {
  const distinctLocalizedTitle =
    originalTitle !== null && normalize(originalTitle) !== normalize(title);
  // Webshare's episode query already omits the premiere year.
  const searchYear = episode ? null : year;
  if (episode) {
    const titles = distinctLocalizedTitle
      ? [originalTitle, null]
      : [originalTitle];
    return episodeSearchTerms(episode, structure).flatMap((episodeSearchTerm) =>
      titles.map((name) => ({
        originalTitle: name,
        year: null,
        episodeSearchTerm,
      })),
    );
  }
  return [
    { originalTitle, year: searchYear },
    ...(distinctLocalizedTitle
      ? [{ originalTitle: null, year: searchYear }]
      : []),
    ...(searchYear === null
      ? []
      : [
          { originalTitle, year: null },
          ...(distinctLocalizedTitle
            ? [{ originalTitle: null, year: null }]
            : []),
        ]),
  ];
}

function providerContext(
  request: DiscoveryRequest,
  locale: "cs" | "en" | "de",
  now: Date,
  signal?: AbortSignal,
): ProviderContext {
  return {
    requestId: request.idempotencyKey,
    profileId: request.profileId,
    locale,
    deadlineAt: new Date(now.getTime() + 55_000).toISOString(),
    secretRef: null,
    signal,
  };
}

/**
 * Live provider-neutral coordinator. The agent may only propose names and
 * ranking rationale; every field shown as fact comes from deterministic
 * metadata and media adapters.
 */
export class LiveContentCoordinator implements StreamerContentProvider {
  readonly id = "live";
  readonly mode = "live" as const;
  readonly #agent: AgentProvider;
  readonly #metadataProviders: ReadonlyMap<string, MetadataProvider>;
  readonly #mediaProviders: ReadonlyMap<string, MediaProvider>;
  readonly #integrationStateStore: IntegrationStateStore;
  readonly #secretRefForProvider: (
    providerId: string,
    profileId: string,
  ) => string | null;
  readonly #inference: RuntimeConfig["inference"];
  readonly #inferenceForProfile: (
    profileId: string,
  ) => RuntimeConfig["inference"];
  readonly #localeForProfile: LiveContentCoordinatorOptions["localeForProfile"];
  readonly #now: () => Date;
  readonly #loadEpisodeCandidates: NonNullable<
    LiveContentCoordinatorOptions["loadEpisodeCandidates"]
  >;
  readonly #saveEpisodeCandidate: NonNullable<
    LiveContentCoordinatorOptions["saveEpisodeCandidate"]
  >;
  readonly #playbackCandidates = new Map<string, MediaCandidateRef[]>();
  readonly #seriesJobs = new Map<string, SeriesSearchJob>();
  readonly #manualSeriesSearches = new Set<string>();
  readonly #forcedEpisodeSources = new Map<string, TitleSource[]>();

  constructor(options: LiveContentCoordinatorOptions) {
    this.#agent = options.agent;
    this.#metadataProviders = providerMap(options.metadata, "tmdb");
    this.#mediaProviders = providerMap(options.media, "webshare");
    this.#integrationStateStore = options.integrationStateStore;
    this.#secretRefForProvider = options.secretRefForProvider ?? (() => null);
    this.#inference = options.inference;
    this.#inferenceForProfile =
      options.inferenceForProfile ?? (() => this.#inference);
    this.#localeForProfile = options.localeForProfile;
    this.#loadEpisodeCandidates = options.loadEpisodeCandidates ?? (() => []);
    this.#saveEpisodeCandidate =
      options.saveEpisodeCandidate ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
  }

  bootstrapTitles(): readonly CatalogTitle[] {
    return [];
  }

  buildHome(input: HomeFeedInput) {
    const items = input.titles.filter(
      (item) =>
        item.metadataProvenance !== undefined &&
        item.availabilityProvenance !== undefined &&
        item.ratings.every((rating) => rating.provenance !== undefined),
    );
    return HomeFeedSchema.parse({
      profileId: input.profileId,
      mode: "live",
      generatedAt: input.generatedAt,
      sections: [
        {
          id: "continue-watching",
          title: "Continue Watching",
          subtitle: "Pick up where you left off",
          freshness: "fresh",
          items: items
            .filter((item) => item.progressPercent !== null)
            .slice(0, 10),
        },
        {
          id: "new-releases",
          title: "New Releases",
          subtitle: "Recently validated titles",
          freshness: "fresh",
          items: [...items]
            .sort((a, b) => (b.year ?? 0) - (a.year ?? 0))
            .slice(0, 10),
        },
        {
          id: "trending",
          title: "Trending",
          subtitle: "Titles discovered on this device",
          freshness: "stale",
          items: items.slice(0, 10),
        },
        {
          id: "top-rated",
          title: "Top Rated",
          subtitle: "Strong source ratings",
          freshness: "fresh",
          items: [...items]
            .sort(
              (a, b) => (b.ratings[0]?.value ?? 0) - (a.ratings[0]?.value ?? 0),
            )
            .slice(0, 10),
        },
        {
          id: "for-you",
          title: "Picks for You",
          subtitle: "Validated discoveries for this profile",
          freshness: "refreshing",
          items: items.slice(0, 10),
        },
      ],
    });
  }

  async discover(
    request: DiscoveryRequest,
    completedAt: string,
    conversation?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse> {
    conversation?.signal?.throwIfAborted();
    const directEpisode = directEpisodeRequest(request.message);
    if (directEpisode)
      return this.discoverFast(request, completedAt, conversation);
    const missing = await this.missingRequiredIntegrations(
      true,
      request.profileId,
    );
    conversation?.signal?.throwIfAborted();
    if (missing.length > 0) {
      return DiscoveryResponseSchema.parse({
        sessionId: request.sessionId,
        mode: "live",
        stage: "needs-setup",
        reply: `Complete the required connections before live discovery: ${missing.join(", ")}.`,
        bestMatch: null,
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [
          "No preview records were substituted for missing live providers.",
        ],
        completedAt,
      });
    }

    const locale = this.#localeForProfile(request.profileId);
    const context = providerContext(
      request,
      locale,
      this.#now(),
      conversation?.signal,
    );
    const thematicIntent = parseThematicDiscoveryIntent(request.message);
    if (thematicIntent) {
      const thematic = await this.discoverThematic(
        request,
        completedAt,
        context,
        thematicIntent,
        conversation,
      );
      if (thematic) return thematic;
    }
    const history = (conversation?.messages ?? []).flatMap((message) => {
      const data = record(message.content);
      const previousTitles = Array.isArray(data?.titles)
        ? data.titles
            .filter((title): title is string => typeof title === "string")
            .slice(0, 6)
        : [];
      if (data?.stage === "quick") {
        return previousTitles.length > 0
          ? [
              {
                role: "system" as const,
                content: `Deterministic metadata search found these title candidates: ${previousTitles.join(", ")}. They are metadata matches, not proof of playback or preference fit. For a direct title query, include an exact matching title unless the user has ruled it out.`,
              },
            ]
          : [];
      }
      return [
        {
          role: message.role,
          content:
            typeof data?.message === "string"
              ? data.message
              : typeof data?.reply === "string"
                ? `${data.reply}${previousTitles.length ? ` Previously suggested: ${previousTitles.join(", ")}.` : ""}`
                : typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
        },
      ];
    });
    const policy = discoveryInstructionPolicy({
      model: this.#inferenceForProfile(context.profileId ?? "default").model,
      contextTokens: this.#inferenceForProfile(context.profileId ?? "default")
        .contextTokens,
      maxOutputTokens: this.#inferenceForProfile(context.profileId ?? "default")
        .maxOutputTokens,
      locale,
    });
    const instruction = policy.instruction;
    const displayInstruction = policy.displayInstruction;
    const seenNote = conversation?.unseen
      ? `The user asked for something unseen. Never propose these already watched titles: ${conversation.unseen.titles.join(", ")}. The application also filters them by canonical ID.`
      : "";
    // Keep durable conversation in SQLite, but send a compact view to small models.
    // Roughly three characters per token leaves room for schema and output.
    const inputBudget = Math.max(
      400,
      (this.#inferenceForProfile(context.profileId ?? "default").contextTokens -
        this.#inferenceForProfile(context.profileId ?? "default")
          .maxOutputTokens -
        400) *
        3,
    );
    const note = seenNote.slice(0, Math.max(0, Math.floor(inputBudget / 4)));
    let remaining = Math.max(
      200,
      inputBudget -
        instruction.length -
        displayInstruction.length -
        note.length,
    );
    const older = history.slice(0, Math.max(0, history.length - 6));
    const olderUserRequests = older
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    const earlierPreferences = [
      ...olderUserRequests.slice(0, 1),
      ...olderUserRequests.slice(-2),
    ]
      .filter((message, index, all) => all.indexOf(message) === index)
      .join(" | ")
      .slice(0, Math.min(500, Math.floor(remaining / 3)));
    remaining -= earlierPreferences.length;
    const recent = [] as typeof history;
    for (const message of history.slice(-6).reverse()) {
      if (remaining < 80) break;
      const content = message.content.slice(0, Math.min(1_200, remaining));
      recent.unshift({ ...message, content });
      remaining -= content.length;
    }
    const compactHistory = [
      ...(earlierPreferences
        ? [
            {
              role: "system" as const,
              content: `Earlier user requests and corrections: ${earlierPreferences}`,
            },
          ]
        : []),
      ...recent,
    ];
    const lastCurrentUser = compactHistory.findLastIndex(
      (message) =>
        message.role === "user" && message.content === request.message,
    );
    if (lastCurrentUser >= 0) compactHistory.splice(lastCurrentUser, 1);
    const agentMessages = [
      { role: "system" as const, content: instruction },
      { role: "system" as const, content: displayInstruction },
      ...(note ? [{ role: "system" as const, content: note }] : []),
      ...compactHistory,
      { role: "user" as const, content: request.message },
    ];
    const generation = await this.#agent.generateStructured<unknown>(
      {
        model: this.#inferenceForProfile(context.profileId ?? "default").model,
        messages: agentMessages,
        outputSchemaName: "streamer_ai_discovery_candidates",
        outputJsonSchema: AGENT_SCHEMA,
        allowedToolNames: [],
        temperature: policy.temperature,
        maxOutputTokens: this.#inferenceForProfile(
          context.profileId ?? "default",
        ).maxOutputTokens,
      },
      context,
    );
    context.signal?.throwIfAborted();
    let plan = parseAgentPlan(generation.output);
    const validated: ValidatedCandidate[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const attemptedHints = new Set<string>();
    let unresolvedHints = 0;
    const validatePlan = async (proposal: AgentPlan) => {
      for (const candidate of proposal.candidates) {
        context.signal?.throwIfAborted();
        const hint = `${normalize(candidate.title)}:${candidate.kind}:${candidate.year ?? ""}`;
        if (attemptedHints.has(hint)) continue;
        attemptedHints.add(hint);
        try {
          const result = await this.validateCandidate(
            candidate,
            proposal.people[0] ?? null,
            context,
          );
          if (result === null) {
            unresolvedHints += 1;
            continue;
          }
          if (seen.has(result.ranked.title.id)) continue;
          seen.add(result.ranked.title.id);
          validated.push(result);
        } catch {
          context.signal?.throwIfAborted();
          warnings.push(
            `Could not validate '${candidate.title}' against live providers.`,
          );
        }
      }
    };
    await validatePlan(plan);
    if (
      validated.length === 0 &&
      unresolvedHints > 0 &&
      Date.parse(context.deadlineAt) - this.#now().getTime() >= 15_000
    ) {
      try {
        const retry = await this.#agent.generateStructured<unknown>(
          {
            model: this.#inferenceForProfile(context.profileId ?? "default")
              .model,
            messages: [
              ...agentMessages.slice(0, -1),
              {
                role: "system",
                content: policy.retryInstruction(
                  plan.candidates.map((item) => item.title),
                ),
              },
              agentMessages.at(-1)!,
            ],
            outputSchemaName: "streamer_ai_discovery_candidates",
            outputJsonSchema: AGENT_SCHEMA,
            allowedToolNames: [],
            temperature: policy.retryTemperature,
            maxOutputTokens: this.#inferenceForProfile(
              context.profileId ?? "default",
            ).maxOutputTokens,
          },
          context,
        );
        const retryPlan = parseAgentPlan(retry.output);
        await validatePlan(retryPlan);
        if (validated.length > 0) plan = retryPlan;
      } catch {
        context.signal?.throwIfAborted();
        // Retain the first attempt's diagnostic result if the retry fails.
      }
    }

    context.signal?.throwIfAborted();

    const available = validated
      .filter((item) =>
        ["available", "partial"].includes(item.ranked.title.availability),
      )
      .sort(
        (a, b) =>
          (b.ranked.title.matchPercent ?? 0) -
          (a.ranked.title.matchPercent ?? 0),
      );
    const best = available.shift() ?? null;
    const highestOther = Math.max(
      0,
      ...validated
        .filter((item) => item !== best)
        .map((item) => item.ranked.title.matchPercent ?? 0),
    );
    if (best !== null && (best.ranked.title.matchPercent ?? 0) < highestOther) {
      best.ranked = {
        ...best.ranked,
        title: { ...best.ranked.title, matchPercent: highestOther },
      };
    }
    this.rememberValidated(request.profileId, validated);

    return DiscoveryResponseSchema.parse({
      sessionId: request.sessionId,
      mode: "live",
      stage: "completed",
      reply: discoveryReply(
        locale,
        validated.length,
        best?.ranked ?? null,
        plan.acknowledgement,
        warnings.length > 0,
      ),
      bestMatch: best?.ranked ?? null,
      available: available.map((item) => item.ranked),
      unavailable: validated
        .filter((item) => item.ranked.title.availability === "unavailable")
        .map((item) => item.ranked),
      unverified: validated
        .filter((item) => item.ranked.title.availability === "unknown")
        .map((item) => item.ranked),
      warnings: [...new Set(warnings)].slice(0, 20),
      completedAt,
    });
  }

  private async discoverThematic(
    request: DiscoveryRequest,
    completedAt: string,
    context: ProviderContext,
    intent: ThematicDiscoveryIntent,
    conversation?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse | null> {
    let candidates: MetadataCandidate[] | null;
    try {
      candidates = await this.thematicMetadata(intent, context);
    } catch {
      context.signal?.throwIfAborted();
      // A temporarily unavailable genre endpoint may still allow exact title
      // proposals through the agent and the ordinary metadata search path.
      return null;
    }
    if (candidates === null) return null;
    const emptyResponse = () =>
      DiscoveryResponseSchema.parse({
        sessionId: request.sessionId,
        mode: "live",
        stage: "completed",
        reply: thematicReply(context.locale, intent, 0, null, false),
        bestMatch: null,
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt,
      });
    if (candidates.length === 0) return emptyResponse();

    const excludedIds = new Set(conversation?.unseen?.titleIds ?? []);
    const excludedNames = new Set(
      (conversation?.unseen?.titles ?? []).map(normalize),
    );
    for (const message of conversation?.messages ?? []) {
      if (message.role !== "assistant") continue;
      const body = record(message.content);
      if (body?.stage === "quick" || !Array.isArray(body?.titles)) continue;
      for (const title of body.titles) {
        if (typeof title === "string") excludedNames.add(normalize(title));
      }
    }
    const fresh = candidates.filter(
      (candidate) =>
        !excludedIds.has(canonicalTitleId(candidate.ref)) &&
        !excludedNames.has(normalize(candidate.title)) &&
        (candidate.originalTitle === null ||
          !excludedNames.has(normalize(candidate.originalTitle))),
    );
    if (fresh.length === 0) return emptyResponse();
    const grouped = new Map<string, MetadataCandidate[]>();
    for (const candidate of fresh) {
      const key = metadataIdentity(candidate);
      grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
    }
    const groups = [...grouped.values()];

    const validated: ValidatedCandidate[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const validationLimit = intent.completeOnly ? 4 : 8;
    for (
      let offset = 0;
      offset < Math.min(groups.length, validationLimit);
      offset += 2
    ) {
      context.signal?.throwIfAborted();
      const batch = await Promise.allSettled(
        groups.slice(offset, offset + 2).map(async (alternatives, index) => {
          let nonPlayable: ValidatedCandidate | null = null;
          let failed = false;
          for (const candidate of alternatives) {
            try {
              const result = await this.validateResolvedCandidate(
                candidate,
                Math.max(60, 88 - (offset + index) * 4),
                thematicReason(intent, context.locale),
                context,
                intent.completeOnly ? 30 : 12,
                intent.completeOnly ? 30 : 3,
                false,
                undefined,
                alternatives.map((item) => item.ref),
              );
              if (
                result.ranked.title.availability === "available" ||
                (!intent.completeOnly &&
                  result.ranked.title.availability === "partial")
              )
                return result;
              if (result.ranked.title.availability === "partial")
                nonPlayable = result;
              else if (nonPlayable?.ranked.title.availability !== "partial")
                nonPlayable = preferNonPlayable(nonPlayable, result);
            } catch {
              context.signal?.throwIfAborted();
              failed = true;
            }
          }
          if (nonPlayable === null && failed)
            throw new Error("All matching metadata sources failed validation.");
          return nonPlayable;
        }),
      );
      for (const [index, result] of batch.entries()) {
        if (result.status === "rejected") {
          context.signal?.throwIfAborted();
          warnings.push(
            `Could not validate '${groups[offset + index]![0]!.title}' against live providers.`,
          );
          continue;
        }
        if (result.value === null) continue;
        const id = result.value.ranked.title.id;
        if (seen.has(id)) continue;
        seen.add(id);
        validated.push(result.value);
      }
      const playable = validated.filter(
        (item) =>
          (item.ranked.title.availability === "available" ||
            (!intent.completeOnly &&
              item.ranked.title.availability === "partial")) &&
          (!intent.completeOnly ||
            item.ranked.title.seriesCoverage?.complete === true),
      );
      if (playable.length >= (intent.completeOnly ? 1 : 2)) break;
    }
    context.signal?.throwIfAborted();
    const ordered = await this.rerankThematic(
      request,
      context,
      validated,
      conversation,
    );
    this.rememberValidated(request.profileId, ordered);

    const available = ordered.filter((item) =>
      ["available", "partial"].includes(item.ranked.title.availability),
    );
    let bestIndex = available.findIndex(
      (item) =>
        !intent.completeOnly ||
        item.ranked.title.seriesCoverage?.complete === true,
    );
    if (bestIndex < 0 && available.length > 0) bestIndex = 0;
    const best = bestIndex < 0 ? null : available.splice(bestIndex, 1)[0]!;
    const highestOther = Math.max(
      0,
      ...ordered
        .filter((item) => item !== best)
        .map((item) => item.ranked.title.matchPercent ?? 0),
    );
    if (best && (best.ranked.title.matchPercent ?? 0) < highestOther) {
      best.ranked = {
        ...best.ranked,
        title: { ...best.ranked.title, matchPercent: highestOther },
      };
    }
    return DiscoveryResponseSchema.parse({
      sessionId: request.sessionId,
      mode: "live",
      stage: "completed",
      reply: thematicReply(
        context.locale,
        intent,
        validated.length,
        best?.ranked ?? null,
        warnings.length > 0,
      ),
      bestMatch: best?.ranked ?? null,
      available: available.map((item) => item.ranked),
      unavailable: ordered
        .filter((item) => item.ranked.title.availability === "unavailable")
        .map((item) => item.ranked),
      unverified: ordered
        .filter((item) => item.ranked.title.availability === "unknown")
        .map((item) => item.ranked),
      warnings: [...new Set(warnings)].slice(0, 20),
      completedAt,
    });
  }

  private async rerankThematic(
    request: DiscoveryRequest,
    context: ProviderContext,
    validated: ValidatedCandidate[],
    conversation?: DiscoveryConversationContext,
  ): Promise<ValidatedCandidate[]> {
    const policy = discoveryInstructionPolicy({
      model: this.#inferenceForProfile(context.profileId ?? "default").model,
      contextTokens: this.#inferenceForProfile(context.profileId ?? "default")
        .contextTokens,
      maxOutputTokens: this.#inferenceForProfile(context.profileId ?? "default")
        .maxOutputTokens,
      locale: this.#localeForProfile(request.profileId),
    });
    if (policy.tier !== "extended" || validated.length < 2) return validated;

    const ids = validated.map((item) => item.ranked.title.id);
    const allowed = new Set(ids);
    const candidates = validated.map((item) => ({
      id: item.ranked.title.id,
      title: item.ranked.title.title,
      kind: item.ranked.title.kind,
      genres: item.ranked.title.genres,
      synopsis: item.ranked.title.synopsis.slice(0, 350),
      availability: item.ranked.title.availability,
      episodeCoverage: item.ranked.title.seriesCoverage ?? null,
    }));
    const priorRequests = (conversation?.messages ?? [])
      .filter((message) => message.role === "user")
      .slice(-3)
      .map((message) => {
        const body = record(message.content);
        return typeof body?.message === "string"
          ? body.message.slice(0, 250)
          : "";
      })
      .filter(Boolean);
    try {
      const result = await this.#agent.generateStructured<unknown>(
        {
          model: this.#inferenceForProfile(context.profileId ?? "default")
            .model,
          messages: [
            {
              role: "system",
              content:
                "Rank only the listed catalog IDs for the user's request. Consider genre, mood, earlier corrections and playback coverage. Never add an ID or assert a fact not present in the list. Return JSON with orderedIds only.",
            },
            {
              role: "user",
              content: JSON.stringify({
                request: request.message,
                priorRequests,
                candidates,
              }),
            },
          ],
          outputSchemaName: "streamer_ai_grounded_rank",
          outputJsonSchema: {
            type: "object",
            additionalProperties: false,
            required: ["orderedIds"],
            properties: {
              orderedIds: {
                type: "array",
                minItems: 1,
                maxItems: ids.length,
                items: { type: "string", enum: ids },
              },
            },
          },
          allowedToolNames: [],
          temperature: 0.15,
          maxOutputTokens: Math.min(
            this.#inferenceForProfile(context.profileId ?? "default")
              .maxOutputTokens,
            160,
          ),
        },
        context,
      );
      const output = record(result.output);
      if (!Array.isArray(output?.orderedIds)) return validated;
      const preferred = output.orderedIds.filter(
        (id): id is string => typeof id === "string" && allowed.has(id),
      );
      if (preferred.length === 0) return validated;
      const priority = new Map(preferred.map((id, index) => [id, index]));
      return [...validated].sort(
        (a, b) =>
          (priority.get(a.ranked.title.id) ?? ids.length) -
          (priority.get(b.ranked.title.id) ?? ids.length),
      );
    } catch {
      context.signal?.throwIfAborted();
      return validated;
    }
  }

  async discoverFast(
    request: DiscoveryRequest,
    completedAt: string,
    conversation?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse> {
    conversation?.signal?.throwIfAborted();
    const directEpisode = directEpisodeRequest(request.message);
    const missing = await this.missingRequiredIntegrations(
      false,
      request.profileId,
    );
    if (missing.length > 0) {
      return DiscoveryResponseSchema.parse({
        sessionId: request.sessionId,
        mode: "live",
        stage: "needs-setup",
        reply: `Connect ${missing.join(" and ")} to show quick matches.`,
        bestMatch: null,
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt,
      });
    }
    const context = providerContext(
      request,
      this.#localeForProfile(request.profileId),
      this.#now(),
      conversation?.signal,
    );
    const locale = context.locale;
    const thematicIntent = parseThematicDiscoveryIntent(request.message);
    if (
      !directEpisode &&
      thematicIntent &&
      (
        await this.activeProviders(
          this.#metadataProviders,
          context.profileId ?? "default",
        )
      ).some(([, provider]) => typeof provider.discover === "function")
    ) {
      // The full pass will search by genre. A title-text search and unrelated
      // trending fallback do not provide a meaningful provisional result.
      return DiscoveryResponseSchema.parse({
        sessionId: request.sessionId,
        mode: "live",
        stage: "completed",
        reply:
          locale === "cs"
            ? "Hledám odpovídající tituly podle žánru."
            : locale === "de"
              ? "Ich suche passende Titel nach Genre."
              : "Searching for matching titles by genre.",
        bestMatch: null,
        available: [],
        unavailable: [],
        unverified: [],
        warnings: [],
        completedAt,
      });
    }
    let matches: MetadataCandidate[] = [];
    try {
      matches = await this.searchMetadata(
        {
          query: (directEpisode?.titleQuery ?? request.message).slice(0, 500),
          kind: directEpisode ? "series" : null,
          year: null,
          person: null,
          locale,
          limit: 12,
        },
        context,
      );
    } catch {
      context.signal?.throwIfAborted();
      // A feed can still provide a provisional starting point when search fails.
    }
    context.signal?.throwIfAborted();
    let usedFallback = false;
    if (matches.length === 0) {
      usedFallback = true;
      matches = await this.metadataFeed(
        {
          feed: "trending",
          kind: null,
          locale,
          region: null,
          from: null,
          to: null,
          limit: 12,
        },
        context,
      );
    }
    context.signal?.throwIfAborted();
    const ranked = matches
      .map((candidate, position) => ({
        candidate,
        score: fastSimilarity(
          directEpisode?.titleQuery ?? request.message,
          candidate,
          position,
        ),
      }))
      // Even a provider hit (and especially a trending fallback) can be
      // unrelated to a conversational request. Let the agent handle those.
      .filter(
        (item) =>
          item.score >= 55 &&
          (!directEpisode || item.candidate.kind === "series"),
      )
      .sort((a, b) => b.score - a.score)
      .filter(
        (item, index, items) =>
          items.findIndex(
            (other) =>
              other.candidate.ref.providerId ===
                item.candidate.ref.providerId &&
              other.candidate.ref.externalId ===
                item.candidate.ref.externalId &&
              other.candidate.kind === item.candidate.kind,
          ) === index,
      );
    const grouped = new Map<string, typeof ranked>();
    for (const item of ranked) {
      const key = metadataIdentity(item.candidate);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    const validated = (
      await Promise.all(
        [...grouped.values()].slice(0, 2).map(async (alternatives) => {
          let nonPlayable: ValidatedCandidate | null = null;
          for (const { candidate, score } of alternatives) {
            try {
              const validated = await this.validateResolvedCandidate(
                candidate,
                score,
                usedFallback
                  ? "A popular suggestion."
                  : score >= 98
                    ? "Exact title match."
                    : "Similar title match.",
                context,
                12,
                3,
                false,
                directEpisode?.episode,
                alternatives.map((item) => item.candidate.ref),
              );
              if (
                validated.ranked.title.availability === "available" ||
                validated.ranked.title.availability === "partial"
              )
                return validated;
              nonPlayable = preferNonPlayable(nonPlayable, validated);
            } catch {
              context.signal?.throwIfAborted();
            }
          }
          return nonPlayable;
        }),
      )
    ).filter((item): item is ValidatedCandidate => item !== null);
    context.signal?.throwIfAborted();
    this.rememberValidated(request.profileId, validated, false);
    const available = validated
      .filter((item) =>
        ["available", "partial"].includes(item.ranked.title.availability),
      )
      .sort(
        (a, b) =>
          (b.ranked.title.matchPercent ?? 0) -
          (a.ranked.title.matchPercent ?? 0),
      );
    const best = available.shift() ?? null;
    const highestOther = Math.max(
      0,
      ...validated
        .filter((item) => item !== best)
        .map((item) => item.ranked.title.matchPercent ?? 0),
    );
    if (best && (best.ranked.title.matchPercent ?? 0) < highestOther) {
      best.ranked = {
        ...best.ranked,
        title: { ...best.ranked.title, matchPercent: highestOther },
      };
    }
    return DiscoveryResponseSchema.parse({
      sessionId: request.sessionId,
      mode: "live",
      stage: "completed",
      reply: validated.length
        ? "Quick suggestions are ready. A closer look may refine them."
        : "No confident quick match yet. A closer look may find better options.",
      bestMatch: best?.ranked ?? null,
      available: available.map((item) => item.ranked),
      unavailable: validated
        .filter((item) => item.ranked.title.availability === "unavailable")
        .map((item) => item.ranked),
      unverified: validated
        .filter((item) => item.ranked.title.availability === "unknown")
        .map((item) => item.ranked),
      warnings: [],
      completedAt,
    });
  }

  private rememberValidated(
    profileId: string,
    validated: ValidatedCandidate[],
    startSeriesSearch = true,
  ): void {
    for (const item of validated) {
      if (item.playbackCandidates.length > 0) {
        const previous =
          this.#playbackCandidates.get(item.ranked.title.id) ?? [];
        if (item.playbackCandidates.length >= previous.length) {
          this.#playbackCandidates.set(
            item.ranked.title.id,
            item.playbackCandidates,
          );
        }
      }
      if (item.ranked.title.kind === "series") {
        const previous = this.#seriesJobs.get(item.ranked.title.id);
        if (previous) {
          for (const [key, refs] of item.episodeCandidates ?? []) {
            const known = previous.candidates.get(key) ?? [];
            if (refs.length > known.length) previous.candidates.set(key, refs);
          }
          previous.structure ??= item.seriesStructure;
        } else {
          this.#seriesJobs.set(item.ranked.title.id, {
            structure: item.seriesStructure,
            candidates: item.episodeCandidates ?? new Map(),
            running: false,
            failed: false,
            finished: false,
          });
        }
        if (startSeriesSearch)
          void this.getSeriesDetail(profileId, item.ranked.title);
      }
    }
  }

  async checkPlayback(
    profileId: string,
    title: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): Promise<PlaybackLanguageAvailability | void> {
    let lastError: unknown = new Error(
      "No playback candidate remains available.",
    );
    for await (const { candidate, context } of this.playbackCandidates(
      profileId,
      title,
      episode,
      sourceId,
    )) {
      try {
        const provider = this.mediaProvider(candidate.providerId);
        const scoped = this.scopedContext(candidate.providerId, context);
        const languages = provider.checkPlayback
          ? await provider.checkPlayback(candidate, scoped)
          : (await provider.inspect(candidate, scoped)).format;
        if (sourceId === undefined)
          this.rememberPlaybackCandidate(title, episode, candidate);
        return languages;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async preparePlayback(
    profileId: string,
    title: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ) {
    let lastError: unknown = new Error(
      "No playback candidate remains available.",
    );
    for await (const { candidate, context } of this.playbackCandidates(
      profileId,
      title,
      episode,
      sourceId,
    )) {
      try {
        const provider = this.mediaProvider(candidate.providerId);
        const scoped = this.scopedContext(candidate.providerId, context);
        const variant = await provider.inspect(candidate, scoped);
        const playback = await provider.createPlayback(
          {
            profileId,
            titleId: title.id,
            seasonNumber: episode?.seasonNumber ?? null,
            episodeNumber: episode?.episodeNumber ?? null,
            variant: { ...candidate, variantId: variant.variantId },
            startPositionSeconds: 0,
          },
          scoped,
        );
        if (sourceId === undefined)
          this.rememberPlaybackCandidate(title, episode, candidate);
        return playback;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  async getSeriesDetail(
    profileId: string,
    title: CatalogTitle,
    retry = false,
    allowAutomaticSearch = true,
  ): Promise<SeriesDetail> {
    if (title.metadataProvider === "local-files") {
      const seasons = new Map<number, Map<number, string>>();
      for (const source of title.sources ?? []) {
        if (source.seasonNumber === null || source.episodeNumber === null)
          continue;
        const episodes =
          seasons.get(source.seasonNumber) ?? new Map<number, string>();
        episodes.set(source.episodeNumber, source.releaseName);
        seasons.set(source.seasonNumber, episodes);
      }
      return {
        status: seasons.size > 0 ? "complete" : "unavailable",
        seasons: [...seasons.entries()]
          .sort(([a], [b]) => a - b)
          .map(([seasonNumber, episodes]) => ({
            seasonNumber,
            title: null,
            episodes: [...episodes.entries()]
              .sort(([a], [b]) => a - b)
              .map(([episodeNumber, releaseName]) => ({
                seasonNumber,
                episodeNumber,
                title: releaseName
                  .replace(/\.[^.]+$/, "")
                  .replace(/[._]+/g, " "),
                synopsis: "",
                airDate: null,
                availability: "available" as const,
              })),
          })),
      };
    }
    let job = this.#seriesJobs.get(title.id);
    if (!job) {
      const storedCandidates = new Map<string, MediaCandidateRef[]>();
      for (const source of title.sources ?? []) {
        if (source.seasonNumber === null || source.episodeNumber === null)
          continue;
        const key = episodeKey(title.id, {
          seasonNumber: source.seasonNumber,
          episodeNumber: source.episodeNumber,
        });
        storedCandidates.set(key, [
          ...(storedCandidates.get(key) ?? []),
          { providerId: source.providerId, candidateId: source.candidateId },
        ]);
      }
      for (const { episode, ref } of this.#loadEpisodeCandidates(title.id)) {
        const key = episodeKey(title.id, episode);
        const known = storedCandidates.get(key) ?? [];
        if (
          !known.some(
            (candidate) =>
              candidate.providerId === ref.providerId &&
              candidate.candidateId === ref.candidateId,
          )
        )
          storedCandidates.set(key, [...known, ref]);
      }
      job = {
        candidates: storedCandidates,
        running: false,
        failed: false,
        finished: false,
      };
      this.#seriesJobs.set(title.id, job);
    }
    if (!allowAutomaticSearch && !retry && !job.structure) {
      const ref = titleMetadataRef(title);
      if (ref) {
        try {
          job.structure = await this.metadataProvider(
            ref.providerId,
          ).getSeriesStructure(
            ref,
            this.scopedContext(
              ref.providerId,
              this.playbackContext(profileId, title),
            ),
          );
        } catch {
          job.failed = true;
        }
      }
    }
    const now = this.#now().getTime();
    const allEpisodesFound =
      job.structure?.complete === true &&
      job.structure.seasons.every((season) =>
        season.episodes.every((episode) =>
          job.candidates.has(
            episodeKey(title.id, {
              seasonNumber: season.seasonNumber,
              episodeNumber: episode.episodeNumber,
            }),
          ),
        ),
      );
    // Incomplete and failed checks are temporary: later provider results or new
    // episodes must be discoverable without deleting the series or restarting.
    const refreshAfter = job.failed
      ? 2 * 60_000
      : allEpisodesFound
        ? 24 * 60 * 60_000
        : 15 * 60_000;
    const stale =
      job.lastAttemptAt === undefined ||
      now - job.lastAttemptAt >= refreshAfter;
    if (
      !job.running &&
      (retry ||
        (allowAutomaticSearch && (stale || (!job.finished && !job.failed))))
    ) {
      const refreshStructure =
        job.structure === undefined || retry || job.lastAttemptAt !== undefined;
      job.running = true;
      job.failed = false;
      job.finished = false;
      job.lastAttemptAt = now;
      const controller = new AbortController();
      job.controller = controller;
      void this.searchSeriesEpisodes(
        profileId,
        title,
        job,
        refreshStructure,
        controller.signal,
      )
        .catch(() => {
          if (job.controller !== controller) return;
          job.failed = true;
          job.running = false;
          job.lastAttemptAt = this.#now().getTime();
        })
        .finally(() => {
          if (job.controller === controller) job.controller = undefined;
        });
    }
    const seasons =
      job.structure?.seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        title: season.title,
        episodes: season.episodes.map((episode) => ({
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
          title: episode.title,
          synopsis: episode.synopsis ?? "",
          airDate: episode.airDate,
          availability: job.candidates.has(
            episodeKey(title.id, {
              seasonNumber: season.seasonNumber,
              episodeNumber: episode.episodeNumber,
            }),
          )
            ? ("available" as const)
            : job.running
              ? ("searching" as const)
              : ("unavailable" as const),
        })),
      })) ?? [];
    const available = seasons
      .flatMap((season) => season.episodes)
      .filter((episode) => episode.availability === "available").length;
    return {
      status: job.failed
        ? "failed"
        : job.running
          ? "searching"
          : available === 0
            ? "unavailable"
            : job.structure?.complete &&
                seasons.every((season) =>
                  season.episodes.every(
                    (episode) => episode.availability === "available",
                  ),
                )
              ? "complete"
              : "partial",
      seasons,
    };
  }

  isSeriesSearchActive(titleId: string): boolean {
    return (
      this.#seriesJobs.get(titleId)?.running === true ||
      this.#manualSeriesSearches.has(titleId)
    );
  }

  activeSeriesSearchCount(): number {
    const activeIds = new Set(this.#manualSeriesSearches);
    for (const [titleId, job] of this.#seriesJobs) {
      if (job.running) activeIds.add(titleId);
    }
    return activeIds.size;
  }

  cancelSeriesSearch(titleId: string): void {
    const job = this.#seriesJobs.get(titleId);
    if (!job?.running) return;
    const controller = job.controller;
    job.controller = undefined;
    job.running = false;
    job.failed = false;
    job.finished = true;
    job.lastAttemptAt = this.#now().getTime();
    controller?.abort();
  }

  async forceSearchTitle(
    profileId: string,
    title: CatalogTitle,
  ): Promise<CatalogTitle> {
    const ref = titleMetadataRef(title);
    if (!ref) throw new Error("This title cannot be searched again.");
    if (title.kind === "series") this.#manualSeriesSearches.add(title.id);
    try {
      const checked = await this.validateResolvedCandidate(
        {
          ref,
          kind: title.kind,
          title: title.title,
          originalTitle: title.originalTitle,
          year: title.year,
          confidence: 1,
          provenance: title.metadataProvenance ?? {
            providerId: ref.providerId,
            retrievedAt: title.metadataValidatedAt,
            connectorVersion: "stored-title",
            confidence: 1,
            validationState: "verified",
            expiresAt: null,
          },
        },
        title.matchPercent ?? 100,
        "Manual title search.",
        this.playbackContext(profileId, title),
        24,
        24,
        true,
      );
      // Only add verified finds. A missed manual search must not erase sources
      // already known to the normal discovery and episode-search workflows.
      if ((checked.ranked.title.sources?.length ?? 0) > 0)
        this.rememberValidated(profileId, [checked], false);
      return checked.ranked.title;
    } finally {
      if (title.kind === "series") this.#manualSeriesSearches.delete(title.id);
    }
  }

  async forceSearchEpisode(
    profileId: string,
    title: CatalogTitle,
    episode: EpisodeSelection,
  ): Promise<TitleSource[]> {
    if (title.kind !== "series")
      throw new Error("Episode search requires a series.");
    const context = this.playbackContext(profileId, title);
    let structure = this.#seriesJobs.get(title.id)?.structure;
    if (!structure) {
      const ref = titleMetadataRef(title);
      if (ref) {
        try {
          structure = await this.metadataProvider(
            ref.providerId,
          ).getSeriesStructure(
            ref,
            this.scopedContext(ref.providerId, context),
          );
        } catch {
          // Canonical SxxEyy releases can still be checked without a guide.
        }
      }
    }
    const storedSources = (title.sources ?? []).filter(
      (source) =>
        source.seasonNumber === episode.seasonNumber &&
        source.episodeNumber === episode.episodeNumber,
    );
    const sources: TitleSource[] = [];
    const seen = new Set<string>();
    const seenFiles = new Set<string>();
    let inspected = 0;
    let searchSucceeded = false;
    let lastError: unknown;
    for (const variant of mediaSearchVariants(
      title.title,
      title.originalTitle,
      title.year,
      episode,
      structure,
    )) {
      if (sources.length >= 8 || inspected >= 20) break;
      let candidates: MediaCandidate[];
      try {
        candidates = (
          await this.searchMedia(
            {
              titleId: title.id,
              kind: "series",
              title: title.title,
              originalTitle: variant.originalTitle,
              year: variant.year,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
              episodeSearchTerm: variant.episodeSearchTerm,
              externalRefs: [],
              limit: 50,
            },
            context,
          )
        ).candidates;
        searchSucceeded = true;
      } catch (error) {
        lastError = error;
        continue;
      }
      for (const candidate of candidates) {
        if (sources.length >= 8 || inspected >= 20) break;
        const parsed = episodeNumber(
          candidate.releaseName,
          title.title,
          title.originalTitle,
          structure,
        );
        if (
          parsed?.season !== episode.seasonNumber ||
          parsed.episode !== episode.episodeNumber ||
          !titleMatchesRelease(
            candidate,
            title.title,
            title.originalTitle,
            null,
          )
        )
          continue;
        const refKey = `${candidate.ref.providerId}:${candidate.ref.candidateId}`;
        const fileKey = `${candidate.ref.providerId}:${normalize(candidate.releaseName)}:${candidate.sizeBytes}`;
        if (seen.has(refKey) || seenFiles.has(fileKey)) continue;
        seen.add(refKey);
        inspected += 1;
        try {
          const checked = await this.mediaProvider(
            candidate.ref.providerId,
          ).inspect(
            candidate.ref,
            this.scopedContext(candidate.ref.providerId, context),
          );
          seenFiles.add(fileKey);
          sources.push({
            id: sourceId(title.id, candidate.ref),
            providerId: candidate.ref.providerId,
            candidateId: candidate.ref.candidateId,
            releaseName: candidate.releaseName,
            sizeBytes: candidate.sizeBytes,
            format: checked.format,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            checkedAt: checked.provenance.retrievedAt,
          });
        } catch {
          // Skip files that cannot be inspected as playable media.
        }
      }
    }
    if (!searchSucceeded && lastError && storedSources.length === 0)
      throw lastError;
    for (const source of storedSources) {
      if (sources.length >= 8) break;
      const refKey = `${source.providerId}:${source.candidateId}`;
      const fileKey = `${source.providerId}:${normalize(source.releaseName)}:${source.sizeBytes}`;
      if (seen.has(refKey) || seenFiles.has(fileKey)) continue;
      seen.add(refKey);
      seenFiles.add(fileKey);
      sources.push(source);
    }
    const validated = TitleSourceSchema.array().max(8).parse(sources);
    const key = `${profileId}:${episodeKey(title.id, episode)}`;
    this.#forcedEpisodeSources.set(key, validated);
    if (this.#forcedEpisodeSources.size > 100) {
      const oldest = this.#forcedEpisodeSources.keys().next().value;
      if (oldest !== undefined) this.#forcedEpisodeSources.delete(oldest);
    }
    for (const source of [...validated].reverse())
      this.rememberPlaybackCandidate(title, episode, {
        providerId: source.providerId,
        candidateId: source.candidateId,
      });
    return validated;
  }

  private async searchSeriesEpisodes(
    profileId: string,
    title: CatalogTitle,
    job: SeriesSearchJob,
    refreshStructure = false,
    signal?: AbortSignal,
  ): Promise<void> {
    const context = { ...this.playbackContext(profileId, title), signal };
    let hadErrors = false;
    if (!job.structure || refreshStructure) {
      const ref = titleMetadataRef(title);
      if (!ref) throw new Error("Series metadata reference is unavailable.");
      const structure = await this.metadataProvider(
        ref.providerId,
      ).getSeriesStructure(ref, this.scopedContext(ref.providerId, context));
      signal?.throwIfAborted();
      job.structure = structure;
    }
    for (const season of job.structure.seasons) {
      for (const episode of season.episodes) {
        signal?.throwIfAborted();
        const selection = {
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        };
        const key = episodeKey(title.id, selection);
        if (
          (job.candidates.get(key)?.length ?? 0) > 0 ||
          (episode.airDate &&
            episode.airDate > this.#now().toISOString().slice(0, 10))
        )
          continue;
        const episodeContext = {
          ...context,
          requestId: `${context.requestId}-${selection.seasonNumber}-${selection.episodeNumber}`,
          deadlineAt: new Date(this.#now().getTime() + 55_000).toISOString(),
        };
        let searchFailed = false;
        const found = [...(job.candidates.get(key) ?? [])];
        const seen = new Set(
          found.map(
            (candidate) => `${candidate.providerId}:${candidate.candidateId}`,
          ),
        );
        // Keep the automatic lookup aligned with the successful manual episode
        // search: alternate localized names and the same candidate window.
        for (const variant of mediaSearchVariants(
          title.title,
          title.originalTitle,
          title.year,
          selection,
          job.structure,
        )) {
          signal?.throwIfAborted();
          let results: MediaCandidate[];
          try {
            const searched = await this.searchMedia(
              {
                titleId: title.id,
                kind: "series",
                title: title.title,
                originalTitle: variant.originalTitle,
                year: variant.year,
                seasonNumber: selection.seasonNumber,
                episodeNumber: selection.episodeNumber,
                episodeSearchTerm: variant.episodeSearchTerm,
                externalRefs: [],
                limit: 50,
              },
              episodeContext,
            );
            signal?.throwIfAborted();
            results = searched.candidates;
            if (!searched.allSucceeded) searchFailed = true;
          } catch {
            signal?.throwIfAborted();
            searchFailed = true;
            continue;
          }
          for (const candidate of results) {
            signal?.throwIfAborted();
            if (found.length >= 8) break;
            const parsed = episodeNumber(
              candidate.releaseName,
              title.title,
              title.originalTitle,
              job.structure,
            );
            if (
              parsed?.season !== selection.seasonNumber ||
              parsed.episode !== selection.episodeNumber ||
              !titleMatchesRelease(
                candidate,
                title.title,
                title.originalTitle,
                null,
              )
            )
              continue;
            const refKey = `${candidate.ref.providerId}:${candidate.ref.candidateId}`;
            if (seen.has(refKey)) continue;
            seen.add(refKey);
            try {
              await this.mediaProvider(candidate.ref.providerId).inspect(
                candidate.ref,
                this.scopedContext(candidate.ref.providerId, episodeContext),
              );
              signal?.throwIfAborted();
              found.push(candidate.ref);
              job.candidates.set(key, [...found]);
              try {
                this.#saveEpisodeCandidate(title.id, selection, candidate.ref);
              } catch {
                // Search results remain usable if persistence is temporarily busy.
              }
            } catch {
              signal?.throwIfAborted();
              // Restricted or non-video files are never displayed as playable.
            }
          }
          if (found.length >= 8) break;
        }
        if (found.length > 0) job.candidates.set(key, found);
        // A failed alternate query may have hidden a playable file, so retry
        // this episode soon unless another query already found one.
        if (found.length === 0 && searchFailed) hadErrors = true;
      }
    }
    signal?.throwIfAborted();
    job.running = false;
    job.finished = !hadErrors;
    job.failed = hadErrors;
    job.lastAttemptAt = this.#now().getTime();
  }

  private rememberPlaybackCandidate(
    title: CatalogTitle,
    episode: EpisodeSelection | undefined,
    candidate: MediaCandidateRef,
  ): void {
    const sameRef = (item: MediaCandidateRef) =>
      item.providerId === candidate.providerId &&
      item.candidateId === candidate.candidateId;
    if (episode) {
      let job = this.#seriesJobs.get(title.id);
      if (!job) {
        job = {
          candidates: new Map(),
          running: false,
          failed: false,
          finished: false,
        };
        this.#seriesJobs.set(title.id, job);
      }
      const key = episodeKey(title.id, episode);
      job.candidates.set(key, [
        candidate,
        ...(job.candidates.get(key) ?? []).filter((item) => !sameRef(item)),
      ]);
    } else {
      this.#playbackCandidates.set(title.id, [
        candidate,
        ...(this.#playbackCandidates.get(title.id) ?? []).filter(
          (item) => !sameRef(item),
        ),
      ]);
    }
  }

  private playbackContext(
    profileId: string,
    title: CatalogTitle,
  ): ProviderContext {
    const locale = this.#localeForProfile(profileId);
    const request: DiscoveryRequest = {
      profileId,
      message: title.title,
      idempotencyKey: `playback-${createHash("sha256").update(`${profileId}:${title.id}:${this.#now().toISOString()}`).digest("hex").slice(0, 24)}`,
    };
    return providerContext(request, locale, this.#now());
  }

  private async *playbackCandidates(
    profileId: string,
    title: CatalogTitle,
    episode?: EpisodeSelection,
    sourceId?: string,
  ): AsyncGenerator<{
    candidate: MediaCandidateRef;
    context: ProviderContext;
  }> {
    const context = this.playbackContext(profileId, title);
    const activeMediaIds = new Set(
      (await this.activeProviders(this.#mediaProviders, profileId)).map(
        ([id]) => id,
      ),
    );
    const storedSources = (title.sources ?? []).filter((source) =>
      episode
        ? source.seasonNumber === episode.seasonNumber &&
          source.episodeNumber === episode.episodeNumber
        : source.seasonNumber === null && source.episodeNumber === null,
    );
    if (sourceId !== undefined) {
      const searchedSources = episode
        ? (this.#forcedEpisodeSources.get(
            `${profileId}:${episodeKey(title.id, episode)}`,
          ) ?? [])
        : [];
      const selected = [...storedSources, ...searchedSources].find(
        (source) => source.id === sourceId,
      );
      if (!selected)
        throw new Error("Selected source is not part of this title.");
      if (!activeMediaIds.has(selected.providerId))
        throw new Error("Selected source is not connected.");
      yield {
        candidate: {
          providerId: selected.providerId,
          candidateId: selected.candidateId,
        },
        context,
      };
      return;
    }
    let candidates = episode
      ? (this.#seriesJobs
          .get(title.id)
          ?.candidates.get(episodeKey(title.id, episode)) ?? [])
      : (this.#playbackCandidates.get(title.id) ?? []);
    const seenRefs = new Set(
      candidates.map(
        (candidate) => `${candidate.providerId}:${candidate.candidateId}`,
      ),
    );
    candidates = [
      ...candidates,
      ...storedSources.flatMap((source) => {
        const key = `${source.providerId}:${source.candidateId}`;
        if (seenRefs.has(key)) return [];
        seenRefs.add(key);
        return [
          {
            providerId: source.providerId,
            candidateId: source.candidateId,
          },
        ];
      }),
    ];
    if (candidates.length > 0) {
      let yielded = false;
      for (const candidate of candidates) {
        if (!activeMediaIds.has(candidate.providerId)) continue;
        yielded = true;
        yield { candidate, context };
      }
      if (yielded) return;
    }
    let structure = episode
      ? this.#seriesJobs.get(title.id)?.structure
      : undefined;
    if (episode && !structure) {
      const ref = titleMetadataRef(title);
      if (ref) {
        try {
          structure = await this.metadataProvider(
            ref.providerId,
          ).getSeriesStructure(
            ref,
            this.scopedContext(ref.providerId, context),
          );
        } catch {
          // Explicit release identifiers remain usable without a guide.
        }
      }
    }
    seenRefs.clear();
    for (const search of mediaSearchVariants(
      title.title,
      title.originalTitle,
      title.year,
      episode,
      structure,
    )) {
      const results = (
        await this.searchMedia(
          {
            titleId: title.id,
            kind: title.kind,
            title: title.title,
            originalTitle: search.originalTitle,
            year: search.year,
            seasonNumber: episode?.seasonNumber ?? null,
            episodeNumber: episode?.episodeNumber ?? null,
            episodeSearchTerm: search.episodeSearchTerm,
            externalRefs: [],
            limit: 20,
          },
          context,
        )
      ).candidates;
      let yielded = 0;
      for (const item of results) {
        if (
          !titleMatchesRelease(
            item,
            title.title,
            title.originalTitle,
            title.kind === "series" ? null : title.year,
          )
        )
          continue;
        const parsed =
          title.kind === "series"
            ? episodeNumber(
                item.releaseName,
                title.title,
                title.originalTitle,
                structure,
              )
            : null;
        if (
          title.kind === "series" &&
          (parsed === null ||
            (episode &&
              (parsed.season !== episode.seasonNumber ||
                parsed.episode !== episode.episodeNumber)))
        )
          continue;
        const refKey = `${item.ref.providerId}:${item.ref.candidateId}`;
        if (seenRefs.has(refKey)) continue;
        if (yielded >= 12) break;
        seenRefs.add(refKey);
        yielded += 1;
        yield { candidate: item.ref, context };
      }
    }
  }

  private async missingRequiredIntegrations(
    includeAgent: boolean,
    profileId: string,
  ): Promise<string[]> {
    const missing: string[] = [];
    if (
      (await this.activeProviders(this.#metadataProviders, profileId))
        .length === 0
    )
      missing.push("a metadata source");
    if (
      (await this.activeProviders(this.#mediaProviders, profileId)).length === 0
    )
      missing.push("a streaming source");
    const agentId = this.#agent.descriptor?.().id ?? "ollama";
    if (
      includeAgent &&
      (await this.#integrationStateStore.get(agentId, profileId))
        ?.configured !== true
    )
      missing.push("an agent");
    return missing;
  }

  private async activeProviders<T>(
    providers: ReadonlyMap<string, T>,
    profileId: string,
  ): Promise<[string, T][]> {
    const entries = [...providers.entries()];
    const states = await Promise.all(
      entries.map(([id]) => this.#integrationStateStore.get(id, profileId)),
    );
    return entries.filter((_, index) => states[index]?.configured === true);
  }

  private metadataProvider(id: string): MetadataProvider {
    const provider = this.#metadataProviders.get(id);
    if (!provider)
      throw new Error(`Metadata provider '${id}' is not registered.`);
    return provider;
  }

  private scopedContext(id: string, context: ProviderContext): ProviderContext {
    return {
      ...context,
      secretRef: this.#secretRefForProvider(id, context.profileId ?? "default"),
    };
  }

  private mediaProvider(id: string): MediaProvider {
    const provider = this.#mediaProviders.get(id);
    if (!provider) throw new Error(`Media provider '${id}' is not registered.`);
    return provider;
  }

  private async searchMetadata(
    query: MetadataSearchQuery,
    context: ProviderContext,
  ): Promise<MetadataCandidate[]> {
    const providers = await this.activeProviders(
      this.#metadataProviders,
      context.profileId ?? "default",
    );
    if (providers.length === 0)
      throw new Error("No metadata provider is connected.");
    const settled = await Promise.allSettled(
      providers.map(([id, provider]) =>
        provider.search(query, this.scopedContext(id, context)),
      ),
    );
    context.signal?.throwIfAborted();
    const candidates: MetadataCandidate[] = [];
    let successful = 0;
    for (const [index, result] of settled.entries()) {
      if (result.status !== "fulfilled") continue;
      successful += 1;
      const providerId = providers[index]![0];
      for (const raw of result.value.slice(0, query.limit)) {
        const parsed = MetadataCandidateSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.ref.providerId === providerId &&
          hasValidAttribution(providers[index]![1], parsed.data)
        )
          candidates.push(parsed.data);
      }
    }
    if (successful === 0)
      throw new Error("All metadata providers failed to search.");
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.ref.providerId}:${candidate.ref.entityType}:${candidate.ref.externalId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async metadataFeed(
    request: Parameters<MetadataProvider["getFeed"]>[0],
    context: ProviderContext,
  ): Promise<MetadataCandidate[]> {
    const providers = await this.activeProviders(
      this.#metadataProviders,
      context.profileId ?? "default",
    );
    if (providers.length === 0)
      throw new Error("No metadata provider is connected.");
    const settled = await Promise.allSettled(
      providers.map(([id, provider]) =>
        provider.getFeed(request, this.scopedContext(id, context)),
      ),
    );
    context.signal?.throwIfAborted();
    const candidates: MetadataCandidate[] = [];
    let successful = 0;
    for (const [index, result] of settled.entries()) {
      if (result.status !== "fulfilled") continue;
      successful += 1;
      const providerId = providers[index]![0];
      for (const raw of result.value.slice(0, request.limit)) {
        const parsed = MetadataCandidateSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.ref.providerId === providerId &&
          hasValidAttribution(providers[index]![1], parsed.data)
        )
          candidates.push(parsed.data);
      }
    }
    if (successful === 0)
      throw new Error("All metadata providers failed to load a feed.");
    return candidates;
  }

  private async thematicMetadata(
    intent: ThematicDiscoveryIntent,
    context: ProviderContext,
  ): Promise<MetadataCandidate[] | null> {
    const providers = (
      await this.activeProviders(
        this.#metadataProviders,
        context.profileId ?? "default",
      )
    ).filter(([, provider]) => typeof provider.discover === "function");
    if (providers.length === 0) return null;
    const kinds = intent.kind ? [intent.kind] : (["movie", "series"] as const);
    const jobs = providers.flatMap(([id, provider]) =>
      kinds.map((kind) => ({
        id,
        provider,
        request: {
          kind,
          genres: intent.genres,
          completeOnly: intent.completeOnly,
          locale: context.locale,
          limit: intent.completeOnly ? 6 : 8,
        } satisfies MetadataDiscoveryRequest,
      })),
    );
    const settled = await Promise.allSettled(
      jobs.map(({ id, provider, request }) =>
        provider.discover!(request, this.scopedContext(id, context)),
      ),
    );
    context.signal?.throwIfAborted();
    if (settled.every((result) => result.status === "rejected")) {
      throw new Error("All metadata providers failed thematic discovery.");
    }
    const candidates: MetadataCandidate[] = [];
    const seen = new Set<string>();
    for (const kind of kinds) {
      const batches = jobs.flatMap((job, index) => {
        const result = settled[index]!;
        if (job.request.kind !== kind || result.status !== "fulfilled")
          return [];
        return [
          result.value.slice(0, job.request.limit).flatMap((raw) => {
            const parsed = MetadataCandidateSchema.safeParse(raw);
            return parsed.success &&
              parsed.data.ref.providerId === job.id &&
              parsed.data.kind === kind &&
              hasValidAttribution(job.provider, parsed.data)
              ? [parsed.data]
              : [];
          }),
        ];
      });
      const depth = Math.max(0, ...batches.map((batch) => batch.length));
      for (let position = 0; position < depth; position++) {
        for (const batch of batches) {
          const candidate = batch[position];
          if (!candidate) continue;
          const id = canonicalTitleId(candidate.ref);
          if (seen.has(id)) continue;
          seen.add(id);
          candidates.push(candidate);
        }
      }
    }
    return candidates;
  }

  private async searchMedia(
    request: MediaSearchRequest,
    context: ProviderContext,
  ): Promise<{ candidates: MediaCandidate[]; allSucceeded: boolean }> {
    const providers = await this.activeProviders(
      this.#mediaProviders,
      context.profileId ?? "default",
    );
    if (providers.length === 0)
      throw new Error("No media provider is connected.");
    const settled = await Promise.allSettled(
      providers.map(async ([id, provider]) => {
        for (let attempt = 0; ; attempt += 1) {
          context.signal?.throwIfAborted();
          try {
            return await provider.search(
              request,
              this.scopedContext(id, context),
            );
          } catch (error) {
            if (attempt >= 3) throw error;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, 300 * 2 ** attempt),
            );
          }
        }
      }),
    );
    context.signal?.throwIfAborted();
    const batches: MediaCandidate[][] = [];
    let successful = 0;
    let allSucceeded = true;
    for (const [index, result] of settled.entries()) {
      if (result.status !== "fulfilled") {
        allSucceeded = false;
        batches.push([]);
        continue;
      }
      successful += 1;
      const providerId = providers[index]![0];
      const batch = result.value.slice(0, request.limit).flatMap((raw) => {
        const parsed = MediaCandidateSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.ref.providerId !== providerId ||
          !hasValidAttribution(providers[index]![1], parsed.data)
        ) {
          allSucceeded = false;
          return [];
        }
        return [parsed.data];
      });
      batches.push(batch.sort((a, b) => b.confidence - a.confidence));
    }
    if (successful === 0)
      throw new Error("All media providers failed to search.");
    // Interleave sources so one service with many releases cannot starve others
    // under the coordinator's bounded inspect budget.
    const candidates: MediaCandidate[] = [];
    const seen = new Set<string>();
    for (
      let position = 0;
      batches.some((batch) => position < batch.length);
      position++
    ) {
      for (const batch of batches) {
        const candidate = batch[position];
        if (!candidate) continue;
        const key = `${candidate.ref.providerId}:${candidate.ref.candidateId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
    return { candidates, allSucceeded };
  }

  private async validateCandidate(
    agent: AgentCandidate,
    person: string | null,
    context: ProviderContext,
  ): Promise<ValidatedCandidate | null> {
    const rankMetadata = (candidates: MetadataCandidate[]) =>
      [...candidates]
        .map((candidate) => ({
          candidate,
          score: metadataScore(agent, candidate),
        }))
        .sort((a, b) => b.score - a.score)
        .filter((item) => item.score >= 60);
    const search = (year: number | null) =>
      this.searchMetadata(
        {
          query: agent.title,
          kind: agent.kind,
          year,
          person,
          locale: context.locale,
          limit: 5,
        },
        context,
      );
    let ranked = rankMetadata(await search(agent.year));
    // The model supplies an approximate year; TMDB treats it as an exact filter.
    // Retry without the year before treating a real title as unresolved.
    if (ranked.length === 0 && agent.year !== null)
      ranked = rankMetadata(await search(null));
    let nonPlayable: ValidatedCandidate | null = null;
    for (const { candidate } of ranked) {
      try {
        const validated = await this.validateResolvedCandidate(
          candidate,
          agent.matchPercent,
          agent.reason,
          context,
          12,
          12,
          false,
          undefined,
          ranked
            .filter(
              (item) =>
                metadataIdentity(item.candidate) ===
                metadataIdentity(candidate),
            )
            .slice(0, 20)
            .map((item) => item.candidate.ref),
        );
        if (
          validated.ranked.title.availability === "available" ||
          validated.ranked.title.availability === "partial"
        )
          return validated;
        nonPlayable = preferNonPlayable(nonPlayable, validated);
      } catch {
        context.signal?.throwIfAborted();
      }
    }
    return nonPlayable;
  }

  private async validateResolvedCandidate(
    selected: MetadataCandidate,
    matchPercent: number,
    reason: string,
    context: ProviderContext,
    maxMediaCandidates = 12,
    desiredPlayableSources = maxMediaCandidates,
    searchAllVariants = false,
    requestedEpisode?: EpisodeSelection,
    metadataRefs: MetadataCandidate["ref"][] = [selected.ref],
  ): Promise<ValidatedCandidate> {
    const metadataProvider = this.metadataProvider(selected.ref.providerId);
    const metadata = await metadataProvider.getTitle(
      selected.ref,
      this.scopedContext(selected.ref.providerId, context),
    );
    if (
      metadata.ref.providerId !== selected.ref.providerId ||
      metadata.ref.externalId !== selected.ref.externalId
    )
      throw new Error(
        "Metadata provider returned a different title reference.",
      );
    const ratingResults = await Promise.allSettled(
      metadataRefs
        .slice(0, 20)
        .map((ref) =>
          this.metadataProvider(ref.providerId).getRatings(
            ref,
            this.scopedContext(ref.providerId, context),
          ),
        ),
    );
    const seenRatingSources = new Set<string>();
    const ratings = ratingResults
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .filter((rating) => {
        const key = `${rating.provenance?.providerId ?? rating.source}:${rating.source}`;
        if (seenRatingSources.has(key)) return false;
        seenRatingSources.add(key);
        return true;
      })
      .slice(0, 12);
    const titleId = canonicalTitleId(metadata.ref);
    const checkedAt = this.#now().toISOString();
    let availability: CatalogTitle["availability"] = "unknown";
    let formats: MediaFormat[] = [];
    let sources: TitleSource[] = [];
    const firstMediaId = this.#mediaProviders.keys().next().value as string;
    const aggregateAvailability = this.#mediaProviders.size > 1;
    let availabilityProvenance: FieldProvenance = {
      providerId: aggregateAvailability ? "streamer-ai" : firstMediaId,
      retrievedAt: checkedAt,
      connectorVersion: aggregateAvailability
        ? "1"
        : this.mediaProvider(firstMediaId).descriptor().connectorVersion,
      confidence: 0,
      validationState: "unverified",
      expiresAt: null,
    };
    let seriesCoverage: CatalogTitle["seriesCoverage"] = null;
    let playbackCandidates: MediaCandidateRef[] = [];
    let seriesStructure: SeriesStructure | undefined;
    const episodeCandidates = new Map<string, MediaCandidateRef[]>();
    if (metadata.kind === "series") {
      try {
        seriesStructure = await metadataProvider.getSeriesStructure(
          metadata.ref,
          this.scopedContext(metadata.ref.providerId, context),
        );
      } catch {
        // An unavailable guide still permits explicitly numbered releases.
      }
    }
    try {
      // Search APIs often treat the year as a required term, while uploaded
      // releases (especially episodes) omit it. Try progressively broader,
      // still title-validated queries before declaring the title unavailable.
      const searches = mediaSearchVariants(
        metadata.title,
        metadata.originalTitle,
        metadata.year,
        metadata.kind === "series" ? requestedEpisode : undefined,
        seriesStructure,
      );
      const inspected: {
        candidate: MediaCandidate;
        variant: Awaited<ReturnType<MediaProvider["inspect"]>>;
      }[] = [];
      const seenCandidates = new Set<string>();
      let searchExhausted = true;
      for (const search of searches) {
        context.signal?.throwIfAborted();
        const searchLimit = metadata.kind === "series" ? 50 : 20;
        const searched = await this.searchMedia(
          {
            titleId,
            kind: metadata.kind,
            title: metadata.title,
            originalTitle: search.originalTitle,
            year: search.year,
            seasonNumber: requestedEpisode?.seasonNumber ?? null,
            episodeNumber: requestedEpisode?.episodeNumber ?? null,
            episodeSearchTerm: search.episodeSearchTerm,
            externalRefs: metadataRefs.slice(0, 20),
            limit: searchLimit,
          },
          context,
        );
        const mediaCandidates = searched.candidates;
        if (!searched.allSucceeded) searchExhausted = false;
        if (mediaCandidates.length >= searchLimit) searchExhausted = false;
        const matching = mediaCandidates.filter((candidate) => {
          if (
            !titleMatchesRelease(
              candidate,
              metadata.title,
              metadata.originalTitle,
              metadata.kind === "series" ? null : metadata.year,
            )
          )
            return false;
          if (metadata.kind !== "series") return true;
          const matched = episodeNumber(
            candidate.releaseName,
            metadata.title,
            metadata.originalTitle,
            seriesStructure,
          );
          return (
            matched !== null &&
            (!requestedEpisode ||
              (matched.season === requestedEpisode.seasonNumber &&
                matched.episode === requestedEpisode.episodeNumber))
          );
        });
        let attempted = 0;
        for (const candidate of matching) {
          context.signal?.throwIfAborted();
          const key = `${candidate.ref.providerId}:${candidate.ref.candidateId}`;
          if (seenCandidates.has(key)) continue;
          if (attempted >= maxMediaCandidates) {
            searchExhausted = false;
            break;
          }
          seenCandidates.add(key);
          attempted += 1;
          try {
            inspected.push({
              candidate,
              variant: await this.mediaProvider(
                candidate.ref.providerId,
              ).inspect(
                candidate.ref,
                this.scopedContext(candidate.ref.providerId, context),
              ),
            });
          } catch {
            context.signal?.throwIfAborted();
            // A rejected/restricted file is not playable and is skipped.
          }
          if (inspected.length >= desiredPlayableSources) break;
        }
        if (inspected.length >= desiredPlayableSources) break;
        if (inspected.length > 0 && !searchAllVariants) break;
      }
      if (inspected.length > 0) {
        inspected.sort(
          (a, b) =>
            sourceQuality(b.candidate, b.variant) -
            sourceQuality(a.candidate, a.variant),
        );
        const seenRefs = new Set<string>();
        const seenFiles = new Set<string>();
        sources = inspected.flatMap((item) => {
          const ref = item.candidate.ref;
          const refKey = `${ref.providerId}:${ref.candidateId}`;
          const duplicateKey =
            item.candidate.sizeBytes === null
              ? refKey
              : `${ref.providerId}:${normalize(item.candidate.releaseName)}:${item.candidate.sizeBytes}`;
          if (seenRefs.has(refKey) || seenFiles.has(duplicateKey)) return [];
          seenRefs.add(refKey);
          seenFiles.add(duplicateKey);
          const episode =
            metadata.kind === "series"
              ? episodeNumber(
                  item.candidate.releaseName,
                  metadata.title,
                  metadata.originalTitle,
                  seriesStructure,
                )
              : null;
          return [
            {
              id: sourceId(titleId, ref),
              providerId: ref.providerId,
              candidateId: ref.candidateId,
              releaseName: item.candidate.releaseName,
              sizeBytes: item.candidate.sizeBytes,
              format: item.variant.format,
              seasonNumber: episode?.season ?? null,
              episodeNumber: episode?.episode ?? null,
              checkedAt: item.variant.provenance.retrievedAt,
            },
          ];
        });
        formats = uniqueFormats(sources.map((source) => source.format));
        playbackCandidates = sources.map((source) => ({
          providerId: source.providerId,
          candidateId: source.candidateId,
        }));
        availabilityProvenance =
          inspected.find(
            (item) =>
              item.candidate.ref.providerId === sources[0]?.providerId &&
              item.candidate.ref.candidateId === sources[0]?.candidateId,
          )?.variant.provenance ?? availabilityProvenance;
        if (metadata.kind === "movie") {
          availability = "available";
        } else {
          const structure =
            seriesStructure ??
            (await metadataProvider.getSeriesStructure(
              metadata.ref,
              this.scopedContext(metadata.ref.providerId, context),
            ));
          seriesStructure = structure;
          const numberedSeasons = structure.seasons.filter(
            (season) => season.seasonNumber > 0 && season.episodes.length > 0,
          );
          const requiredSeasons =
            numberedSeasons.length > 0
              ? numberedSeasons
              : structure.seasons.filter(
                  (season) => season.episodes.length > 0,
                );
          const expectedEpisodes = requiredSeasons.reduce(
            (count, season) => count + season.episodes.length,
            0,
          );
          const requiredEpisodes = new Set(
            requiredSeasons.flatMap((season) =>
              season.episodes.map(
                (episode) => `${season.seasonNumber}:${episode.episodeNumber}`,
              ),
            ),
          );
          const found = new Map<string, { season: number; episode: number }>();
          for (const source of sources) {
            if (source.seasonNumber !== null && source.episodeNumber !== null) {
              const episode = {
                season: source.seasonNumber,
                episode: source.episodeNumber,
              };
              const identity = `${episode.season}:${episode.episode}`;
              if (requiredEpisodes.has(identity)) found.set(identity, episode);
              const key = episodeKey(titleId, {
                seasonNumber: episode.season,
                episodeNumber: episode.episode,
              });
              episodeCandidates.set(key, [
                ...(episodeCandidates.get(key) ?? []),
                {
                  providerId: source.providerId,
                  candidateId: source.candidateId,
                },
              ]);
            }
          }
          const seasonsAvailable = new Set(
            [...found.values()].map((episode) => episode.season),
          ).size;
          const seasonsTotal = requiredSeasons.length;
          const complete =
            expectedEpisodes > 0 &&
            found.size === expectedEpisodes &&
            structure.complete;
          seriesCoverage = {
            seasonsAvailable,
            seasonsTotal,
            episodesAvailable: found.size,
            episodesTotal: expectedEpisodes,
            complete,
            nextEpisodeLabel: null,
          };
          availability = complete ? "available" : "partial";
        }
      } else {
        availability =
          requestedEpisode || !searchExhausted ? "unknown" : "unavailable";
        if (searchExhausted && !requestedEpisode) {
          availabilityProvenance = {
            ...availabilityProvenance,
            confidence: 1,
            validationState: "verified",
          };
        }
      }
    } catch {
      context.signal?.throwIfAborted();
      availability = "unknown";
    }

    const title = CatalogTitleSchema.parse({
      id: titleId,
      kind: metadata.kind,
      title: metadata.title,
      originalTitle: metadata.originalTitle,
      year: metadata.year,
      synopsis: metadata.synopsis,
      posterUrl: metadata.posterUrl,
      backdropUrl: metadata.backdropUrl,
      accentColor: accentColor(titleId),
      genres: metadata.genres,
      ratings,
      matchPercent,
      availability,
      availabilityProvider: availabilityProvenance.providerId,
      availabilityCheckedAt: checkedAt,
      formats,
      sources,
      seriesCoverage,
      metadataProvider: metadata.ref.providerId,
      metadataRef: metadata.ref,
      metadataValidatedAt:
        metadata.fieldProvenance.title?.retrievedAt ?? checkedAt,
      metadataProvenance: metadata.fieldProvenance.title ?? selected.provenance,
      availabilityProvenance,
      inLibrary: false,
      progressPercent: null,
    });
    const groundedReason =
      reason === "Exact title match." &&
      ![metadata.title, metadata.originalTitle].some(
        (name) =>
          name !== null && normalize(name) === normalize(selected.title),
      )
        ? "Similar title match."
        : reason;
    const requestedEpisodeMetadata = requestedEpisode
      ? seriesStructure?.seasons
          .find(
            (season) => season.seasonNumber === requestedEpisode.seasonNumber,
          )
          ?.episodes.find(
            (episode) =>
              episode.episodeNumber === requestedEpisode.episodeNumber,
          )
      : undefined;
    return {
      ranked: {
        title,
        reason: groundedReason,
        ...(requestedEpisode
          ? {
              episode: requestedEpisode,
              episodeTitle: requestedEpisodeMetadata?.title,
              episodeSynopsis: requestedEpisodeMetadata?.synopsis || undefined,
            }
          : {}),
      },
      playbackCandidates,
      seriesStructure,
      episodeCandidates,
    };
  }
}
