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
  secretRefForProvider?: (providerId: string) => string | null;
  inference: RuntimeConfig["inference"];
  localeForProfile: (profileId: string) => "cs" | "en" | "de";
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
): string {
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
  readonly #secretRefForProvider: (providerId: string) => string | null;
  readonly #inference: RuntimeConfig["inference"];
  readonly #localeForProfile: LiveContentCoordinatorOptions["localeForProfile"];
  readonly #now: () => Date;
  readonly #playbackCandidates = new Map<string, MediaCandidateRef[]>();
  readonly #seriesJobs = new Map<string, SeriesSearchJob>();
  readonly #forcedEpisodeSources = new Map<string, TitleSource[]>();

  constructor(options: LiveContentCoordinatorOptions) {
    this.#agent = options.agent;
    this.#metadataProviders = providerMap(options.metadata, "tmdb");
    this.#mediaProviders = providerMap(options.media, "webshare");
    this.#integrationStateStore = options.integrationStateStore;
    this.#secretRefForProvider = options.secretRefForProvider ?? (() => null);
    this.#inference = options.inference;
    this.#localeForProfile = options.localeForProfile;
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
    const missing = await this.missingRequiredIntegrations(true);
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
    const history = (conversation?.messages ?? []).map((message) => {
      const data = record(message.content);
      const previousTitles = Array.isArray(data?.titles)
        ? data.titles
            .filter((title): title is string => typeof title === "string")
            .slice(0, 6)
        : [];
      return {
        role: message.role,
        content:
          data?.stage === "quick" && previousTitles.length > 0
            ? `Deterministic metadata search found these title candidates: ${previousTitles.join(", ")}. They are metadata matches, not proof of playback or preference fit. For a direct title query, include an exact matching title unless the user has ruled it out.`
            : typeof data?.message === "string"
              ? data.message
              : typeof data?.reply === "string"
                ? `${data.reply}${previousTitles.length ? ` Previously suggested: ${previousTitles.join(", ")}.` : ""}`
                : typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
      };
    });
    const instruction = `You propose films and series for a ${locale} user. Keep earlier preferences unless revised. Apply objections and avoid rejected or already watched titles. A quick-search note contains metadata candidates, not user preferences. For a direct title request, consider an exact quick-search match. Include only currently required people; every candidate must feature them. Return up to 6 real, correctly spelled titles with kind, approximate year, short reason and score. Give a brief acknowledgement in the user's language without naming unvalidated titles or claiming availability. Do not invent facts. Output only JSON.`;
    const displayInstruction =
      "Acknowledgement and reasons are shown to the user. Use natural language without naming metadata or media providers, websites, APIs, tools, or validation steps.";
    const seenNote = conversation?.unseen
      ? `The user asked for something unseen. Never propose these already watched titles: ${conversation.unseen.titles.join(", ")}. The application also filters them by canonical ID.`
      : "";
    // Keep durable conversation in SQLite, but send a compact view to small models.
    // Roughly three characters per token leaves room for schema and output.
    const inputBudget = Math.max(
      400,
      (this.#inference.contextTokens - this.#inference.maxOutputTokens - 400) *
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
    const generation = await this.#agent.generateStructured<unknown>(
      {
        model: this.#inference.model,
        messages: [
          {
            role: "system",
            content: instruction,
          },
          {
            role: "system",
            content: displayInstruction,
          },
          ...(note ? [{ role: "system" as const, content: note }] : []),
          ...compactHistory,
          ...(history.some(
            (message) =>
              message.role === "user" &&
              message.content.includes(request.message),
          )
            ? []
            : [{ role: "user" as const, content: request.message }]),
        ],
        outputSchemaName: "streamer_ai_discovery_candidates",
        outputJsonSchema: AGENT_SCHEMA,
        allowedToolNames: [],
        temperature: 0.35,
        maxOutputTokens: this.#inference.maxOutputTokens,
      },
      context,
    );
    context.signal?.throwIfAborted();
    const plan = parseAgentPlan(generation.output);
    const validated: ValidatedCandidate[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const candidate of plan.candidates) {
      context.signal?.throwIfAborted();
      try {
        const result = await this.validateCandidate(
          candidate,
          plan.people[0] ?? null,
          context,
        );
        if (result === null || seen.has(result.ranked.title.id)) continue;
        seen.add(result.ranked.title.id);
        validated.push(result);
      } catch {
        context.signal?.throwIfAborted();
        warnings.push(
          `Could not validate '${candidate.title}' against live providers.`,
        );
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

  async discoverFast(
    request: DiscoveryRequest,
    completedAt: string,
    conversation?: DiscoveryConversationContext,
  ): Promise<DiscoveryResponse> {
    conversation?.signal?.throwIfAborted();
    const directEpisode = directEpisodeRequest(request.message);
    const missing = await this.missingRequiredIntegrations(false);
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
      job = {
        candidates: storedCandidates,
        running: false,
        failed: false,
        finished: false,
      };
      this.#seriesJobs.set(title.id, job);
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
    if (!job.running && (retry || stale || (!job.finished && !job.failed))) {
      const refreshStructure =
        job.structure === undefined || retry || job.lastAttemptAt !== undefined;
      job.running = true;
      job.failed = false;
      job.finished = false;
      job.lastAttemptAt = now;
      void this.searchSeriesEpisodes(
        profileId,
        title,
        job,
        refreshStructure,
      ).catch(() => {
        job.failed = true;
        job.running = false;
        job.lastAttemptAt = this.#now().getTime();
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

  async forceSearchTitle(
    profileId: string,
    title: CatalogTitle,
  ): Promise<CatalogTitle> {
    const ref = titleMetadataRef(title);
    if (!ref) throw new Error("This title cannot be searched again.");
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
  ): Promise<void> {
    const context = this.playbackContext(profileId, title);
    let hadErrors = false;
    if (!job.structure || refreshStructure) {
      const ref = titleMetadataRef(title);
      if (!ref) throw new Error("Series metadata reference is unavailable.");
      job.structure = await this.metadataProvider(
        ref.providerId,
      ).getSeriesStructure(ref, this.scopedContext(ref.providerId, context));
    }
    for (const season of job.structure.seasons) {
      for (const episode of season.episodes) {
        const selection = {
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        };
        const key = episodeKey(title.id, selection);
        if (
          (job.candidates.get(key)?.length ?? 0) >= 8 ||
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
            results = searched.candidates;
            if (!searched.allSucceeded) searchFailed = true;
          } catch {
            searchFailed = true;
            continue;
          }
          for (const candidate of results) {
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
              found.push(candidate.ref);
              job.candidates.set(key, [...found]);
            } catch {
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
      (await this.activeProviders(this.#mediaProviders)).map(([id]) => id),
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
  ): Promise<string[]> {
    const missing: string[] = [];
    if ((await this.activeProviders(this.#metadataProviders)).length === 0)
      missing.push("a metadata source");
    if ((await this.activeProviders(this.#mediaProviders)).length === 0)
      missing.push("a streaming source");
    const agentId = this.#agent.descriptor?.().id ?? "ollama";
    if (
      includeAgent &&
      (await this.#integrationStateStore.get(agentId))?.configured !== true
    )
      missing.push("an agent");
    return missing;
  }

  private async activeProviders<T>(
    providers: ReadonlyMap<string, T>,
  ): Promise<[string, T][]> {
    const entries = [...providers.entries()];
    const states = await Promise.all(
      entries.map(([id]) => this.#integrationStateStore.get(id)),
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
    return { ...context, secretRef: this.#secretRefForProvider(id) };
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
    const providers = await this.activeProviders(this.#metadataProviders);
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
    const providers = await this.activeProviders(this.#metadataProviders);
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

  private async searchMedia(
    request: MediaSearchRequest,
    context: ProviderContext,
  ): Promise<{ candidates: MediaCandidate[]; allSucceeded: boolean }> {
    const providers = await this.activeProviders(this.#mediaProviders);
    if (providers.length === 0)
      throw new Error("No media provider is connected.");
    const settled = await Promise.allSettled(
      providers.map(([id, provider]) =>
        provider.search(request, this.scopedContext(id, context)),
      ),
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
    const metadataCandidates = await this.searchMetadata(
      {
        query: agent.title,
        kind: agent.kind,
        year: agent.year,
        person,
        locale: context.locale,
        limit: 5,
      },
      context,
    );
    const ranked = [...metadataCandidates]
      .map((candidate) => ({
        candidate,
        score: metadataScore(agent, candidate),
      }))
      .sort((a, b) => b.score - a.score)
      .filter((item) => item.score >= 60);
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
          const expectedEpisodes = structure.seasons.reduce(
            (count, season) => count + season.episodes.length,
            0,
          );
          const found = new Map<string, { season: number; episode: number }>();
          for (const source of sources) {
            if (source.seasonNumber !== null && source.episodeNumber !== null) {
              const episode = {
                season: source.seasonNumber,
                episode: source.episodeNumber,
              };
              found.set(`${episode.season}:${episode.episode}`, episode);
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
          const seasonsTotal = structure.seasons.filter(
            (season) => season.episodes.length > 0,
          ).length;
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
