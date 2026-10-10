import {
  CanonicalTitlePayloadSchema,
  DiscoveryFeedRequestSchema,
  ExternalEntityRefSchema,
  MetadataSearchQuerySchema,
  ProviderHealthSchema,
  SeriesStructureSchema,
  SourceRatingSchema,
  type CanonicalTitlePayload,
  type DiscoveryFeedRequest,
  type ExternalEntityRef,
  type FieldProvenance,
  type MetadataCandidate,
  type MetadataProvider,
  type MetadataSearchQuery,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth,
  type SeriesStructure,
  type SourceRating,
} from "@streamer-ai/contracts";
import { ProviderRequestError } from "./provider-http.js";
import { TmdbApiClient } from "./tmdb-api-client.js";

const CONNECTOR_VERSION = "0.1.0";
const IMAGE_BASE_URL = "https://image.tmdb.org/t/p/w500";

export interface TmdbMetadataProviderOptions {
  client: TmdbApiClient;
  now?: () => Date;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderRequestError("tmdb", "invalid-response", true);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown): string {
  const parsed = optionalString(value);
  if (parsed === null) {
    throw new ProviderRequestError("tmdb", "invalid-response", true);
  }
  return parsed;
}

function positiveInteger(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new ProviderRequestError("tmdb", "invalid-response", true);
  }
  return Number(value);
}

function year(value: unknown): number | null {
  const text = optionalString(value);
  const match = text === null ? null : /^(\d{4})-\d{2}-\d{2}$/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function date(value: unknown): string | null {
  const text = optionalString(value);
  return text !== null && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function image(value: unknown): string | null {
  const path = optionalString(value);
  return path === null || !/^\/[A-Za-z0-9._/-]+$/.test(path)
    ? null
    : `${IMAGE_BASE_URL}${path}`;
}

function provenance(retrievedAt: string): FieldProvenance {
  return {
    providerId: "tmdb",
    retrievedAt,
    connectorVersion: CONNECTOR_VERSION,
    confidence: 1,
    validationState: "verified",
    expiresAt: null,
  };
}

function tmdbLanguage(locale: string): string {
  if (locale === "cs") return "cs-CZ";
  if (locale === "de") return "de-DE";
  if (locale === "en") return "en-US";
  return locale;
}

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function results(value: unknown): Record<string, unknown>[] {
  const body = object(value);
  if (!Array.isArray(body.results)) {
    throw new ProviderRequestError("tmdb", "invalid-response", true);
  }
  return body.results.map(object);
}

/** Converts TMDB responses into provider-neutral records with field provenance. */
export class TmdbMetadataProvider implements MetadataProvider {
  readonly #client: TmdbApiClient;
  readonly #now: () => Date;

  constructor(options: TmdbMetadataProviderOptions) {
    this.#client = options.client;
    this.#now = options.now ?? (() => new Date());
  }

  descriptor(): ProviderDescriptor & { family: "metadata" } {
    return {
      id: "tmdb",
      family: "metadata",
      displayName: "TMDB",
      connectorVersion: CONNECTOR_VERSION,
      capabilities: [
        "movies",
        "series",
        "series-structure",
        "ratings",
        "artwork",
        "discovery-feeds",
      ],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "api-key",
      credentialFields: [
        {
          id: "readAccessToken",
          label: "Read access token",
          input: "password",
          required: true,
          secret: true,
        },
      ],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: "https://developer.themoviedb.org/",
      privacySummary:
        "Search terms, titles and locale are sent to TMDB; the read token stays on the home server.",
    };
  }

  async health(context: ProviderContext): Promise<ProviderHealth> {
    const started = this.#now().getTime();
    try {
      await this.#client.getFeed(
        "movie",
        "trending",
        tmdbLanguage(context.locale),
        context.signal,
      );
      return ProviderHealthSchema.parse({
        status: "healthy",
        checkedAt: this.#now().toISOString(),
        latencyMs: Math.max(0, this.#now().getTime() - started),
        code: null,
        connectorVersion: CONNECTOR_VERSION,
      });
    } catch (error) {
      const unauthorized =
        error instanceof ProviderRequestError &&
        ["not-configured", "unauthorized", "forbidden"].includes(error.kind);
      return ProviderHealthSchema.parse({
        status: "unavailable",
        checkedAt: this.#now().toISOString(),
        latencyMs: Math.max(0, this.#now().getTime() - started),
        code: unauthorized ? "INVALID_CREDENTIALS" : "PROVIDER_UNAVAILABLE",
        connectorVersion: CONNECTOR_VERSION,
      });
    }
  }

  async search(
    rawQuery: MetadataSearchQuery,
    context: ProviderContext,
  ): Promise<MetadataCandidate[]> {
    const query = MetadataSearchQuerySchema.parse(rawQuery);
    let creditedTitles: Set<string> | null = null;
    if (query.person !== null) {
      const people = results(
        await this.#client.searchPerson(
          query.person,
          tmdbLanguage(query.locale),
          context.signal,
        ),
      );
      const requestedPerson = normalizedIdentity(query.person);
      const person = people.find(
        (item) =>
          Number.isInteger(item.id) &&
          typeof item.name === "string" &&
          normalizedIdentity(item.name) === requestedPerson,
      );
      if (person === undefined) return [];
      const credits = object(
        await this.#client.getPersonCombinedCredits(
          positiveInteger(person.id),
          tmdbLanguage(query.locale),
          context.signal,
        ),
      );
      creditedTitles = new Set<string>();
      for (const rawCredit of [
        ...(Array.isArray(credits.cast) ? credits.cast : []),
        ...(Array.isArray(credits.crew) ? credits.crew : []),
      ]) {
        const credit = object(rawCredit);
        if (!Number.isInteger(credit.id)) continue;
        if (credit.media_type === "movie") {
          creditedTitles.add(`movie:${String(credit.id)}`);
        } else if (credit.media_type === "tv") {
          creditedTitles.add(`series:${String(credit.id)}`);
        }
      }
    }
    const kinds =
      query.kind === null ? (["movie", "series"] as const) : [query.kind];
    const retrievedAt = this.#now().toISOString();
    const candidates = await Promise.all(
      kinds.map(async (kind) => {
        const response =
          kind === "movie"
            ? await this.#client.searchMovie(
                {
                  query: query.query,
                  ...(query.year === null ? {} : { year: query.year }),
                  language: tmdbLanguage(query.locale),
                },
                context.signal,
              )
            : await this.#client.searchSeries(
                {
                  query: query.query,
                  ...(query.year === null ? {} : { year: query.year }),
                  language: tmdbLanguage(query.locale),
                },
                context.signal,
              );
        return results(response).flatMap((item): MetadataCandidate[] => {
          if (!Number.isInteger(item.id)) return [];
          if (
            creditedTitles !== null &&
            !creditedTitles.has(`${kind}:${String(item.id)}`)
          ) {
            return [];
          }
          const title = optionalString(item.title ?? item.name);
          if (title === null) return [];
          return [
            {
              ref: {
                providerId: "tmdb",
                externalId: String(item.id),
                entityType: kind,
              },
              kind,
              title,
              originalTitle: optionalString(
                item.original_title ?? item.original_name,
              ),
              year: year(item.release_date ?? item.first_air_date),
              confidence: 0.8,
              provenance: {
                ...provenance(retrievedAt),
                confidence: 0.8,
                validationState: "derived",
              },
            },
          ];
        });
      }),
    );
    return candidates.flat().slice(0, query.limit);
  }

  async getTitle(
    rawRef: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<CanonicalTitlePayload> {
    const ref = ExternalEntityRefSchema.parse(rawRef);
    this.assertTitleRef(ref);
    const id = positiveInteger(Number(ref.externalId));
    const body = object(
      ref.entityType === "movie"
        ? await this.#client.getMovie(
            id,
            tmdbLanguage(context.locale),
            context.signal,
          )
        : await this.#client.getSeries(
            id,
            tmdbLanguage(context.locale),
            context.signal,
          ),
    );
    const retrievedAt = this.#now().toISOString();
    const source = provenance(retrievedAt);
    const title = requiredString(body.title ?? body.name);
    const originalTitle = optionalString(
      body.original_title ?? body.original_name,
    );
    const localizedTitles = [
      { locale: context.locale, value: title, provenance: source },
      ...(originalTitle !== null && originalTitle !== title
        ? [{ locale: "en", value: originalTitle, provenance: source }]
        : []),
    ];
    const genres = Array.isArray(body.genres)
      ? body.genres.flatMap((value) => {
          const item = object(value);
          const name = optionalString(item.name);
          return name === null ? [] : [name];
        })
      : [];
    return CanonicalTitlePayloadSchema.parse({
      ref,
      kind: ref.entityType,
      title,
      originalTitle,
      localizedTitles,
      year: year(body.release_date ?? body.first_air_date),
      synopsis: optionalString(body.overview) ?? "",
      genres,
      posterUrl: image(body.poster_path),
      backdropUrl: image(body.backdrop_path),
      fieldProvenance: {
        title: source,
        originalTitle: source,
        year: source,
        synopsis: source,
        genres: source,
        posterUrl: source,
        backdropUrl: source,
      },
    });
  }

  async getSeriesStructure(
    rawRef: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<SeriesStructure> {
    const ref = ExternalEntityRefSchema.parse(rawRef);
    if (ref.providerId !== "tmdb" || ref.entityType !== "series") {
      throw new ProviderRequestError("tmdb", "invalid-response", false);
    }
    const seriesId = positiveInteger(Number(ref.externalId));
    const details = object(
      await this.#client.getSeries(
        seriesId,
        tmdbLanguage(context.locale),
        context.signal,
      ),
    );
    if (!Array.isArray(details.seasons)) {
      throw new ProviderRequestError("tmdb", "invalid-response", true);
    }
    const source = provenance(this.#now().toISOString());
    const seasons = [];
    for (const rawSeason of details.seasons.slice(0, 200)) {
      const summary = object(rawSeason);
      if (!Number.isInteger(summary.season_number)) continue;
      const seasonNumber = Number(summary.season_number);
      const body = object(
        await this.#client.getSeason(
          seriesId,
          seasonNumber,
          tmdbLanguage(context.locale),
          context.signal,
        ),
      );
      const episodes = Array.isArray(body.episodes)
        ? body.episodes.flatMap((value) => {
            const episode = object(value);
            if (!Number.isInteger(episode.episode_number)) return [];
            const externalId = positiveInteger(episode.id);
            return [
              {
                ref: {
                  providerId: "tmdb",
                  externalId: String(externalId),
                  entityType: "episode" as const,
                },
                episodeNumber: Number(episode.episode_number),
                title: requiredString(episode.name),
                synopsis: (optionalString(episode.overview) ?? "").slice(
                  0,
                  1_500,
                ),
                airDate: date(episode.air_date),
                runtimeMinutes:
                  Number.isInteger(episode.runtime) &&
                  Number(episode.runtime) > 0
                    ? Number(episode.runtime)
                    : null,
                provenance: source,
              },
            ];
          })
        : [];
      seasons.push({
        ref: {
          providerId: "tmdb",
          externalId: String(positiveInteger(body.id)),
          entityType: "season" as const,
        },
        seasonNumber,
        title: optionalString(body.name),
        episodes,
        provenance: source,
      });
    }
    return SeriesStructureSchema.parse({
      seriesRef: ref,
      seasons,
      complete: seasons.length === details.seasons.length,
      provenance: source,
    });
  }

  async getRatings(
    rawRef: ExternalEntityRef,
    context: ProviderContext,
  ): Promise<SourceRating[]> {
    const ref = ExternalEntityRefSchema.parse(rawRef);
    this.assertTitleRef(ref);
    const id = positiveInteger(Number(ref.externalId));
    const body = object(
      ref.entityType === "movie"
        ? await this.#client.getMovie(
            id,
            tmdbLanguage(context.locale),
            context.signal,
          )
        : await this.#client.getSeries(
            id,
            tmdbLanguage(context.locale),
            context.signal,
          ),
    );
    if (typeof body.vote_average !== "number") return [];
    return [
      SourceRatingSchema.parse({
        source: "TMDB",
        value: body.vote_average,
        scale: 10,
        votes: Number.isInteger(body.vote_count) ? body.vote_count : null,
        provenance: provenance(this.#now().toISOString()),
      }),
    ];
  }

  async getFeed(
    rawRequest: DiscoveryFeedRequest,
    context: ProviderContext,
  ): Promise<MetadataCandidate[]> {
    const request = DiscoveryFeedRequestSchema.parse(rawRequest);
    const kinds =
      request.kind === null ? (["movie", "series"] as const) : [request.kind];
    const feed =
      request.feed === "new-releases"
        ? "now_playing"
        : request.feed === "top-rated"
          ? "top_rated"
          : "trending";
    const retrievedAt = this.#now().toISOString();
    const candidates = await Promise.all(
      kinds.map(async (kind) =>
        results(
          await this.#client.getFeed(
            kind,
            feed,
            tmdbLanguage(request.locale),
            context.signal,
          ),
        ).flatMap((item): MetadataCandidate[] => {
          if (!Number.isInteger(item.id)) return [];
          const title = optionalString(item.title ?? item.name);
          if (title === null) return [];
          return [
            {
              ref: {
                providerId: "tmdb",
                externalId: String(item.id),
                entityType: kind,
              },
              kind,
              title,
              originalTitle: optionalString(
                item.original_title ?? item.original_name,
              ),
              year: year(item.release_date ?? item.first_air_date),
              confidence: 1,
              provenance: provenance(retrievedAt),
            },
          ];
        }),
      ),
    );
    return candidates.flat().slice(0, request.limit);
  }

  private assertTitleRef(ref: ExternalEntityRef): void {
    if (
      ref.providerId !== "tmdb" ||
      (ref.entityType !== "movie" && ref.entityType !== "series")
    ) {
      throw new ProviderRequestError("tmdb", "invalid-response", false);
    }
  }
}
