import type { SecretStore } from "../stores/secret-store.js";
import { profileSecretKey } from "../stores/secret-store.js";
import { TMDB_READ_TOKEN_SECRET_KEY } from "./tmdb-client.js";
import {
  isAbortFailure,
  ProviderRequestError,
  providerFailureForStatus,
} from "./provider-http.js";

const DEFAULT_TMDB_BASE_URL = "https://api.themoviedb.org/3";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ProviderFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers?: { get(name: string): string | null };
  readonly body?: { cancel(): Promise<void> } | null;
  text(): Promise<string>;
}

export type ProviderFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect?: "manual";
  },
) => Promise<ProviderFetchResponse>;

export interface TmdbApiClientOptions {
  secretStore: SecretStore;
  fetch?: ProviderFetch;
  baseUrl?: string;
  timeoutMs?: number;
  profileId?: string;
}

function defaultProviderFetch(
  input: string,
  init: Parameters<ProviderFetch>[1],
): Promise<ProviderFetchResponse> {
  return fetch(input, init);
}

function safeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("TMDB base URL must use HTTPS (except loopback tests).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "TMDB base URL cannot contain credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function parseBoundedJson(providerId: string, text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new ProviderRequestError(providerId, "invalid-response", true);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderRequestError(providerId, "invalid-response", true);
  }
}

/**
 * Credential-safe TMDB transport. Domain normalization belongs in a
 * MetadataProvider adapter; this client only owns authenticated, bounded HTTP.
 */
export class TmdbApiClient {
  readonly #secretStore: SecretStore;
  readonly #fetch: ProviderFetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #profileId: string;

  constructor(options: TmdbApiClientOptions) {
    this.#secretStore = options.secretStore;
    this.#fetch = options.fetch ?? defaultProviderFetch;
    this.#baseUrl = safeBaseUrl(
      options.baseUrl ?? process.env.TMDB_BASE_URL ?? DEFAULT_TMDB_BASE_URL,
    );
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    this.#profileId = options.profileId ?? "default";
  }

  forProfile(profileId: string): TmdbApiClient {
    return new TmdbApiClient({
      secretStore: this.#secretStore,
      fetch: this.#fetch,
      baseUrl: this.#baseUrl,
      timeoutMs: this.#timeoutMs,
      profileId,
    });
  }

  searchMovie(
    input: {
      query: string;
      year?: number;
      language?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(
      "/search/movie",
      {
        query: input.query,
        ...(input.year === undefined ? {} : { year: String(input.year) }),
        language: input.language ?? "en-US",
        include_adult: "false",
        page: "1",
      },
      signal,
    );
  }

  searchSeries(
    input: {
      query: string;
      year?: number;
      language?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(
      "/search/tv",
      {
        query: input.query,
        ...(input.year === undefined
          ? {}
          : { first_air_date_year: String(input.year) }),
        language: input.language ?? "en-US",
        include_adult: "false",
        page: "1",
      },
      signal,
    );
  }

  searchPerson(
    query: string,
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(
      "/search/person",
      {
        query,
        language,
        include_adult: "false",
        page: "1",
      },
      signal,
    );
  }

  getPersonCombinedCredits(
    id: number,
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(
      `/person/${this.safeId(id)}/combined_credits`,
      {
        language,
      },
      signal,
    );
  }

  getMovie(
    id: number,
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(`/movie/${this.safeId(id)}`, { language }, signal);
  }

  getSeries(
    id: number,
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.get(`/tv/${this.safeId(id)}`, { language }, signal);
  }

  getSeason(
    seriesId: number,
    seasonNumber: number,
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Number.isInteger(seasonNumber) || seasonNumber < 0) {
      throw new TypeError("TMDB season number must be a non-negative integer.");
    }
    return this.get(
      `/tv/${this.safeId(seriesId)}/season/${seasonNumber}`,
      {
        language,
      },
      signal,
    );
  }

  getFeed(
    kind: "movie" | "series",
    feed: "trending" | "popular" | "top_rated" | "now_playing",
    language = "en-US",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (feed === "trending") {
      return this.get(
        `/trending/${kind === "movie" ? "movie" : "tv"}/week`,
        {
          language,
        },
        signal,
      );
    }
    const namespace = kind === "movie" ? "movie" : "tv";
    const supportedFeed =
      namespace === "tv" && feed === "now_playing" ? "on_the_air" : feed;
    return this.get(
      `/${namespace}/${supportedFeed}`,
      { language, page: "1" },
      signal,
    );
  }

  getGenres(kind: "movie" | "series", signal?: AbortSignal): Promise<unknown> {
    return this.get(
      `/genre/${kind === "movie" ? "movie" : "tv"}/list`,
      { language: "en-US" },
      signal,
    );
  }

  discover(
    kind: "movie" | "series",
    input: {
      genreIds: number[];
      completeOnly: boolean;
      language?: string;
      page?: number;
      releasedBefore?: string;
    },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      input.genreIds.length === 0 ||
      input.genreIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      throw new TypeError("TMDB genre ids must be positive integers.");
    }
    if (input.completeOnly && kind !== "series") {
      throw new TypeError("Complete-only discovery requires a series kind.");
    }
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 500) {
      throw new TypeError("TMDB discovery page must be between 1 and 500.");
    }
    if (
      input.releasedBefore !== undefined &&
      !/^\d{4}-\d{2}-\d{2}$/.test(input.releasedBefore)
    ) {
      throw new TypeError("TMDB release cutoff must be an ISO date.");
    }
    return this.get(
      `/discover/${kind === "movie" ? "movie" : "tv"}`,
      {
        language: input.language ?? "en-US",
        include_adult: "false",
        ...(kind === "movie" ? { include_video: "false" } : {}),
        page: String(page),
        sort_by: "popularity.desc",
        with_genres: input.genreIds.join(","),
        ...(input.releasedBefore
          ? kind === "movie"
            ? { "primary_release_date.lte": input.releasedBefore }
            : { "first_air_date.lte": input.releasedBefore }
          : {}),
        ...(kind === "series" ? { include_null_first_air_dates: "false" } : {}),
        ...(input.completeOnly ? { with_status: "3" } : {}),
      },
      signal,
    );
  }

  async get(
    path: string,
    query: Readonly<Record<string, string>> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await this.#secretStore.get(
      profileSecretKey(this.#profileId, TMDB_READ_TOKEN_SECRET_KEY),
    );
    if (token === undefined) {
      throw new ProviderRequestError("tmdb", "not-configured", false);
    }
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      requestSignal.throwIfAborted();
      const response = await this.#fetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
        },
        signal: requestSignal,
      });
      if (!response.ok) throw providerFailureForStatus("tmdb", response.status);
      return parseBoundedJson("tmdb", await response.text());
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (controller.signal.aborted || isAbortFailure(error)) {
        throw new ProviderRequestError("tmdb", "timeout", true);
      }
      throw new ProviderRequestError("tmdb", "network", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private safeId(id: number): number {
    if (!Number.isInteger(id) || id <= 0) {
      throw new TypeError("TMDB id must be a positive integer.");
    }
    return id;
  }
}
