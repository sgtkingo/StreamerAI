import {
  CatalogTitleSchema,
  DiscoveryResponseSchema,
  HomeFeedSchema,
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
  type MetadataCandidate,
  type MetadataProvider,
  type ProviderContext,
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
  metadata: MetadataProvider;
  media: MediaProvider;
  integrationStateStore: IntegrationStateStore;
  inference: RuntimeConfig["inference"];
  localeForProfile: (profileId: string) => "cs" | "en" | "de";
  now?: () => Date;
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
): { season: number; episode: number } | null {
  const match =
    /(?:^|[^a-z0-9])s(\d{1,2})[ ._-]*e(\d{1,3})(?:[^a-z0-9]|$)/i.exec(
      releaseName,
    ) ?? /(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:[^a-z0-9]|$)/i.exec(releaseName);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const episode = Number(match[2]);
  if (episode < 1) return null;
  return { season: Number(match[1]), episode };
}

function mediaSearchVariants(
  title: string,
  originalTitle: string | null,
  year: number | null,
  episode?: EpisodeSelection,
): { originalTitle: string | null; year: number | null }[] {
  const distinctLocalizedTitle =
    originalTitle !== null && normalize(originalTitle) !== normalize(title);
  // Webshare's episode query already omits the premiere year.
  const searchYear = episode ? null : year;
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
  readonly #metadata: MetadataProvider;
  readonly #media: MediaProvider;
  readonly #integrationStateStore: IntegrationStateStore;
  readonly #inference: RuntimeConfig["inference"];
  readonly #localeForProfile: LiveContentCoordinatorOptions["localeForProfile"];
  readonly #now: () => Date;
  readonly #playbackCandidates = new Map<string, MediaCandidateRef[]>();
  readonly #seriesJobs = new Map<string, SeriesSearchJob>();
  readonly #forcedEpisodeSources = new Map<string, TitleSource[]>();

  constructor(options: LiveContentCoordinatorOptions) {
    this.#agent = options.agent;
    this.#metadata = options.metadata;
    this.#media = options.media;
    this.#integrationStateStore = options.integrationStateStore;
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
          subtitle: "Strong TMDB ratings",
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
    const history = (conversation?.messages ?? []).slice(-8).map((message) => {
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
            ? `Deterministic TMDB quick search found these title candidates: ${previousTitles.join(", ")}. They are metadata matches, not proof of playback or preference fit. For a direct title query, include an exact matching title unless the user has ruled it out.`
            : typeof data?.message === "string"
              ? data.message
              : typeof data?.reply === "string"
                ? `${data.reply}${previousTitles.length ? ` Previously suggested: ${previousTitles.join(", ")}.` : ""}`
                : typeof message.content === "string"
                  ? message.content
                  : JSON.stringify(message.content),
      };
    });
    const generation = await this.#agent.generateStructured<unknown>(
      {
        model: this.#inference.model,
        messages: [
          {
            role: "system",
            content: `You propose films and series for a ${locale} user. The latest message may be feedback on an earlier shortlist: keep the user's original preferences unless revised, apply objections, and avoid previously suggested titles the user rejected. A quick-search note, if present, lists deterministic TMDB title candidates; it is not a user rejection or a reason to avoid those titles. Give an exact quick-search title strong consideration for a direct title query, while still respecting every user constraint. Put only currently required people in the people array; omit people the user rejected. Return exactly 6 real, correctly spelled candidate titles that best satisfy the latest request and conversation. Every candidate must actually feature each currently required person. Prefer well-known titles when uncertain. Use your knowledge only to propose title, kind, approximate release year, a short preference-based reason, and match score. Add a brief acknowledgement in the user's language that responds to their latest preference or objection; do not name unvalidated titles or claim availability, ratings, or other unverified facts in it. Do not invent metadata, availability, ratings, people, or URLs. Output only the requested JSON.`,
          },
          {
            role: "system",
            content:
              "The acknowledgement and every candidate reason are shown directly to the user. Describe the recommendation in natural language without naming metadata services, streaming providers, websites, APIs, search tools, or internal validation steps. Never mention TMDB, Webshare, or any other source in these user-facing fields.",
          },
          ...history,
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
      matches = await this.#metadata.search(
        {
          query: request.message.slice(0, 500),
          kind: null,
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
      matches = await this.#metadata.getFeed(
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
        score: fastSimilarity(request.message, candidate, position),
      }))
      // Even a provider hit (and especially a trending fallback) can be
      // unrelated to a conversational request. Let the agent handle those.
      .filter((item) => item.score >= 55)
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
      )
      .slice(0, 2);
    const validated = (
      await Promise.all(
        ranked.map(async ({ candidate, score }) => {
          try {
            return await this.validateResolvedCandidate(
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
            );
          } catch {
            context.signal?.throwIfAborted();
            return null;
          }
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
    if (this.#media.checkPlayback === undefined) {
      throw new Error("The media source does not support playback checks.");
    }
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
        const languages = await this.#media.checkPlayback(candidate, context);
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
        const variant = await this.#media.inspect(candidate, context);
        const playback = await this.#media.createPlayback(
          {
            profileId,
            titleId: title.id,
            seasonNumber: episode?.seasonNumber ?? null,
            episodeNumber: episode?.episodeNumber ?? null,
            variant: { ...candidate, variantId: variant.variantId },
            startPositionSeconds: 0,
          },
          context,
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
    const match = /^sai:tmdb:(movie|series):(\d+)$/.exec(title.id);
    if (!match || match[1] !== title.kind)
      throw new Error("This title cannot be searched again.");
    const checked = await this.validateResolvedCandidate(
      {
        ref: {
          providerId: "tmdb",
          entityType: title.kind,
          externalId: match[2]!,
        },
        kind: title.kind,
        title: title.title,
        originalTitle: title.originalTitle,
        year: title.year,
        confidence: 1,
        provenance: title.metadataProvenance ?? {
          providerId: "tmdb",
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
    )) {
      if (sources.length >= 8 || inspected >= 20) break;
      let candidates: MediaCandidate[];
      try {
        candidates = await this.#media.search(
          {
            titleId: title.id,
            kind: "series",
            title: title.title,
            originalTitle: variant.originalTitle,
            year: variant.year,
            seasonNumber: episode.seasonNumber,
            episodeNumber: episode.episodeNumber,
            externalRefs: [],
            limit: 50,
          },
          context,
        );
        searchSucceeded = true;
      } catch (error) {
        lastError = error;
        continue;
      }
      for (const candidate of candidates) {
        if (sources.length >= 8 || inspected >= 20) break;
        const parsed = episodeNumber(candidate.releaseName);
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
        const fileKey = `${normalize(candidate.releaseName)}:${candidate.sizeBytes}`;
        if (seen.has(refKey) || seenFiles.has(fileKey)) continue;
        seen.add(refKey);
        inspected += 1;
        try {
          const checked = await this.#media.inspect(candidate.ref, context);
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
      const fileKey = `${normalize(source.releaseName)}:${source.sizeBytes}`;
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
      const externalId = /^sai:tmdb:series:(\d+)$/.exec(title.id)?.[1];
      if (!externalId)
        throw new Error("Series metadata reference is unavailable.");
      job.structure = await this.#metadata.getSeriesStructure(
        { providerId: "tmdb", entityType: "series", externalId },
        context,
      );
    }
    for (const season of job.structure.seasons) {
      for (const episode of season.episodes) {
        const selection = {
          seasonNumber: season.seasonNumber,
          episodeNumber: episode.episodeNumber,
        };
        const key = episodeKey(title.id, selection);
        if (
          job.candidates.has(key) ||
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
        let found = false;
        // Keep the automatic lookup aligned with the successful manual episode
        // search: alternate localized names and the same candidate window.
        for (const variant of mediaSearchVariants(
          title.title,
          title.originalTitle,
          title.year,
          selection,
        )) {
          let results: MediaCandidate[];
          try {
            results = await this.#media.search(
              {
                titleId: title.id,
                kind: "series",
                title: title.title,
                originalTitle: variant.originalTitle,
                year: variant.year,
                seasonNumber: selection.seasonNumber,
                episodeNumber: selection.episodeNumber,
                externalRefs: [],
                limit: 50,
              },
              episodeContext,
            );
          } catch {
            searchFailed = true;
            continue;
          }
          for (const candidate of results) {
            const parsed = episodeNumber(candidate.releaseName);
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
            try {
              await this.#media.inspect(candidate.ref, episodeContext);
              if (!job.candidates.has(key))
                job.candidates.set(key, [candidate.ref]);
              found = true;
              break;
            } catch {
              // Restricted or non-video files are never displayed as playable.
            }
          }
          if (found) break;
        }
        // A failed alternate query may have hidden a playable file, so retry
        // this episode soon unless another query already found one.
        if (!found && searchFailed) hadErrors = true;
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
    if (candidates.length === 0 && storedSources.length > 0) {
      candidates = storedSources.map((source) => ({
        providerId: source.providerId,
        candidateId: source.candidateId,
      }));
    }
    if (candidates.length > 0) {
      for (const candidate of candidates) yield { candidate, context };
      return;
    }
    const seenRefs = new Set<string>();
    for (const search of mediaSearchVariants(
      title.title,
      title.originalTitle,
      title.year,
      episode,
    )) {
      const results = await this.#media.search(
        {
          titleId: title.id,
          kind: title.kind,
          title: title.title,
          originalTitle: search.originalTitle,
          year: search.year,
          seasonNumber: episode?.seasonNumber ?? null,
          episodeNumber: episode?.episodeNumber ?? null,
          externalRefs: [],
          limit: 20,
        },
        context,
      );
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
          title.kind === "series" ? episodeNumber(item.releaseName) : null;
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
    const ids = includeAgent
      ? ["tmdb", "webshare", "ollama"]
      : ["tmdb", "webshare"];
    const states = await Promise.all(
      ids.map((id) => this.#integrationStateStore.get(id)),
    );
    return (
      includeAgent ? ["TMDB", "Webshare", "Ollama"] : ["TMDB", "Webshare"]
    ).filter((_name, index) => states[index]?.configured !== true);
  }

  private async validateCandidate(
    agent: AgentCandidate,
    person: string | null,
    context: ProviderContext,
  ): Promise<ValidatedCandidate | null> {
    const metadataCandidates = await this.#metadata.search(
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
    const selected = [...metadataCandidates]
      .map((candidate) => ({
        candidate,
        score: metadataScore(agent, candidate),
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (selected === undefined || selected.score < 60) return null;
    return this.validateResolvedCandidate(
      selected.candidate,
      agent.matchPercent,
      agent.reason,
      context,
    );
  }

  private async validateResolvedCandidate(
    selected: MetadataCandidate,
    matchPercent: number,
    reason: string,
    context: ProviderContext,
    maxMediaCandidates = 12,
    desiredPlayableSources = maxMediaCandidates,
    searchAllVariants = false,
  ): Promise<ValidatedCandidate> {
    const metadata = await this.#metadata.getTitle(selected.ref, context);
    const ratings = await this.#metadata.getRatings(selected.ref, context);
    const titleId = `sai:tmdb:${metadata.kind}:${metadata.ref.externalId}`;
    const checkedAt = this.#now().toISOString();
    let availability: CatalogTitle["availability"] = "unknown";
    let formats: MediaFormat[] = [];
    let sources: TitleSource[] = [];
    let availabilityProvenance: FieldProvenance = {
      providerId: "webshare",
      retrievedAt: checkedAt,
      connectorVersion: this.#media.descriptor().connectorVersion,
      confidence: 0,
      validationState: "unverified",
      expiresAt: null,
    };
    let seriesCoverage: CatalogTitle["seriesCoverage"] = null;
    let playbackCandidates: MediaCandidateRef[] = [];
    let seriesStructure: SeriesStructure | undefined;
    const episodeCandidates = new Map<string, MediaCandidateRef[]>();
    try {
      // Search APIs often treat the year as a required term, while uploaded
      // releases (especially episodes) omit it. Try progressively broader,
      // still title-validated queries before declaring the title unavailable.
      const searches = mediaSearchVariants(
        metadata.title,
        metadata.originalTitle,
        metadata.year,
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
        const mediaCandidates = await this.#media.search(
          {
            titleId,
            kind: metadata.kind,
            title: metadata.title,
            originalTitle: search.originalTitle,
            year: search.year,
            seasonNumber: null,
            episodeNumber: null,
            externalRefs: [metadata.ref],
            limit: searchLimit,
          },
          context,
        );
        if (mediaCandidates.length >= searchLimit) searchExhausted = false;
        const matching = mediaCandidates.filter(
          (candidate) =>
            titleMatchesRelease(
              candidate,
              metadata.title,
              metadata.originalTitle,
              metadata.kind === "series" ? null : metadata.year,
            ) &&
            (metadata.kind !== "series" ||
              episodeNumber(candidate.releaseName) !== null),
        );
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
              variant: await this.#media.inspect(candidate.ref, context),
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
        const seenRefs = new Set<string>();
        const seenFiles = new Set<string>();
        sources = inspected.flatMap((item) => {
          const ref = item.candidate.ref;
          const refKey = `${ref.providerId}:${ref.candidateId}`;
          const duplicateKey =
            item.candidate.sizeBytes === null
              ? refKey
              : `${normalize(item.candidate.releaseName)}:${item.candidate.sizeBytes}`;
          if (seenRefs.has(refKey) || seenFiles.has(duplicateKey)) return [];
          seenRefs.add(refKey);
          seenFiles.add(duplicateKey);
          const episode =
            metadata.kind === "series"
              ? episodeNumber(item.candidate.releaseName)
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
          inspected[0]?.variant.provenance ?? availabilityProvenance;
        if (metadata.kind === "movie") {
          availability = "available";
        } else {
          const structure = await this.#metadata.getSeriesStructure(
            metadata.ref,
            context,
          );
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
        availability = searchExhausted ? "unavailable" : "unknown";
        if (searchExhausted) {
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
      availabilityProvider: "webshare",
      availabilityCheckedAt: checkedAt,
      formats,
      sources,
      seriesCoverage,
      metadataProvider: "tmdb",
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
    return {
      ranked: { title, reason: groundedReason },
      playbackCandidates,
      seriesStructure,
      episodeCandidates,
    };
  }
}
