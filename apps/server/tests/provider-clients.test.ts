import { describe, expect, it, vi } from "vitest";
import {
  TmdbApiClient,
  type ProviderFetch,
} from "../src/integrations/tmdb-api-client.js";
import { TmdbMetadataProvider } from "../src/integrations/tmdb-metadata-provider.js";
import {
  WebshareClient,
  WebshareResponseError,
  WEBSHARE_WST_SECRET_KEY,
} from "../src/integrations/webshare-client.js";
import { WebshareMediaProvider } from "../src/integrations/webshare-media-provider.js";
import {
  NonPersistentMemorySecretStore,
  TMDB_READ_TOKEN_SECRET_KEY,
  md5Crypt,
} from "../src/index.js";

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  const values =
    status === 206
      ? { "content-range": "bytes 0-0/100", "content-length": "1", ...headers }
      : headers;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => values[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

describe("provider HTTP clients", () => {
  it("keeps the TMDB episode overview in the series guide", async () => {
    const provider = new TmdbMetadataProvider({
      client: {
        getSeries: vi
          .fn()
          .mockResolvedValue({ seasons: [{ season_number: 1 }] }),
        getSeason: vi.fn().mockResolvedValue({
          id: 43,
          name: "Season One",
          episodes: [
            {
              id: 44,
              episode_number: 1,
              name: "Enter: Naruto Uzumaki!",
              overview: "Naruto begins his journey.",
              air_date: "2002-10-03",
              runtime: 24,
            },
          ],
        }),
      } as unknown as TmdbApiClient,
    });
    const structure = await provider.getSeriesStructure(
      { providerId: "tmdb", externalId: "42", entityType: "series" },
      {
        requestId: "episode-overview",
        profileId: "default",
        locale: "en",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        secretRef: null,
      },
    );
    expect(structure.seasons[0]?.episodes[0]).toMatchObject({
      title: "Enter: Naruto Uzumaki!",
      synopsis: "Naruto begins his journey.",
    });
  });

  it("uses alternate episode terms while preserving movie title and year queries", async () => {
    const search = vi.fn().mockResolvedValue({ total: 0, items: [] });
    const provider = new WebshareMediaProvider({
      client: { search } as unknown as WebshareClient,
      issuePlaybackTicket: () => "/playback/test",
    });
    const context = {
      requestId: "query-test",
      profileId: "default",
      locale: "en",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      secretRef: null,
    };
    const request = {
      titleId: "sai:tmdb:series:42",
      kind: "series" as const,
      title: "Pan Tau",
      originalTitle: "Pan Tau",
      year: 1970,
      seasonNumber: 1,
      episodeNumber: 5,
      externalRefs: [],
      limit: 20,
    };
    await provider.search({ ...request, episodeSearchTerm: "15" }, context);
    expect(search).toHaveBeenLastCalledWith(
      { query: "Pan Tau 15", limit: 20 },
      undefined,
    );
    await provider.search(
      {
        ...request,
        titleId: "sai:tmdb:movie:43",
        kind: "movie",
        year: 2024,
        seasonNumber: null,
        episodeNumber: null,
        episodeSearchTerm: undefined,
      },
      context,
    );
    expect(search).toHaveBeenLastCalledWith(
      { query: "Pan Tau 2024", limit: 20 },
      undefined,
    );
  });

  it("implements the standard md5-crypt vector used by Webshare login", () => {
    expect(md5Crypt("password", "salt")).toBe("$1$salt$qJH7.N4xYta3aEG/dfqo/0");
  });

  it("exchanges Webshare credentials for WST without sending plaintext password", async () => {
    const calls: Array<{
      url: string;
      body: string;
      headers: Record<string, string>;
    }> = [];
    const fetch: ProviderFetch = async (url, init) => {
      calls.push({ url, body: init.body ?? "", headers: init.headers });
      return url.endsWith("/salt/")
        ? response(
            200,
            "<response><status>OK</status><salt>salt</salt></response>",
          )
        : response(
            200,
            "<response><status>OK</status><token>test-session-token</token></response>",
          );
    };
    const existingSecrets = new NonPersistentMemorySecretStore();
    await existingSecrets.set(WEBSHARE_WST_SECRET_KEY, "expired-old-token");
    const client = new WebshareClient({
      secretStore: existingSecrets,
      fetch,
      baseUrl: "https://webshare.test/api",
    });

    const token = await client.authenticate("viewer", "password");

    expect(token).toBe("test-session-token");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toBe("username_or_email=viewer");
    expect(calls[1]?.body).toContain("username_or_email=viewer");
    expect(calls[1]?.body).toMatch(/password=[a-f\d]{40}/u);
    expect(calls[1]?.body).not.toContain("password=password");
    expect(calls.every((call) => call.headers.wst === undefined)).toBe(true);
  });
  it("resolves the TMDB token at the boundary and never puts it in the URL", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    const token = "sentinel-tmdb-token-never-in-url";
    await secrets.set(TMDB_READ_TOKEN_SECRET_KEY, token);
    let requestedUrl = "";
    let authorization = "";
    const fetch: ProviderFetch = async (url, init) => {
      requestedUrl = url;
      authorization = init.headers.authorization ?? "";
      return response(200, '{"page":1,"results":[]}');
    };
    const client = new TmdbApiClient({
      secretStore: secrets,
      fetch,
      baseUrl: "https://tmdb.test/3",
    });

    await client.searchMovie({
      query: "Arrival",
      year: 2016,
      language: "cs-CZ",
    });

    expect(requestedUrl).toContain("/search/movie");
    expect(requestedUrl).toContain("query=Arrival");
    expect(requestedUrl).not.toContain(token);
    expect(authorization).toBe(`Bearer ${token}`);
  });

  it("normalizes TMDB candidates with stable refs and source provenance", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(TMDB_READ_TOKEN_SECRET_KEY, "test-token");
    const client = new TmdbApiClient({
      secretStore: secrets,
      fetch: async () =>
        response(
          200,
          JSON.stringify({
            results: [
              {
                id: 329865,
                title: "Arrival",
                original_title: "Arrival",
                release_date: "2016-11-10",
              },
            ],
          }),
        ),
      baseUrl: "https://tmdb.test/3",
    });
    const provider = new TmdbMetadataProvider({
      client,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });

    const result = await provider.search(
      {
        query: "Arrival",
        kind: "movie",
        year: 2016,
        person: null,
        locale: "cs",
        limit: 5,
      },
      {
        requestId: "request-0001",
        profileId: "default",
        locale: "cs",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        secretRef: null,
      },
    );

    expect(result).toMatchObject([
      {
        ref: { providerId: "tmdb", externalId: "329865", entityType: "movie" },
        title: "Arrival",
        year: 2016,
        provenance: { providerId: "tmdb", validationState: "derived" },
      },
    ]);
  });

  it("deterministically filters title candidates by an explicitly named person", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(TMDB_READ_TOKEN_SECRET_KEY, "test-token");
    const client = new TmdbApiClient({
      secretStore: secrets,
      fetch: async (url) => {
        if (url.includes("/search/person")) {
          return response(
            200,
            JSON.stringify({
              results: [{ id: 18277, name: "Sandra Bullock" }],
            }),
          );
        }
        if (url.includes("/person/18277/combined_credits")) {
          return response(
            200,
            JSON.stringify({
              cast: [{ id: 2044, media_type: "movie" }],
              crew: [],
            }),
          );
        }
        return response(
          200,
          JSON.stringify({
            results: [
              {
                id: 2044,
                title: "The Lake House",
                original_title: "The Lake House",
                release_date: "2006-06-16",
              },
              {
                id: 999,
                title: "Unrelated Film",
                original_title: "Unrelated Film",
                release_date: "2006-01-01",
              },
            ],
          }),
        );
      },
      baseUrl: "https://tmdb.test/3",
    });
    const provider = new TmdbMetadataProvider({ client });

    const result = await provider.search(
      {
        query: "The Lake House",
        kind: "movie",
        year: 2006,
        person: "Sandra Bullock",
        locale: "en",
        limit: 5,
      },
      {
        requestId: "request-person",
        profileId: "default",
        locale: "en",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        secretRef: null,
      },
    );

    expect(result.map((item) => item.ref.externalId)).toEqual(["2044"]);
  });

  it("rechecks Webshare restrictions and returns only a same-origin playback ticket", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const fetch: ProviderFetch = async (url) => {
      if (url.includes("/file_info/")) {
        return response(
          200,
          "<response><status>OK</status><name>Arrival.2016.1080p.x264.mkv</name><type>mkv</type><size>123</size><available>1</available><password>0</password><copyrighted>0</copyrighted></response>",
        );
      }
      if (url.includes("secret-direct-link")) {
        return response(206, "x");
      }
      return response(
        200,
        "<response><status>OK</status><link>https://cdn.webshare.cz/secret-direct-link</link></response>",
      );
    };
    const client = new WebshareClient({
      secretStore: secrets,
      fetch,
      baseUrl: "https://webshare.test/api",
    });
    let capturedDirectUrl = "";
    let probedDirectUrl = "";
    let probeCount = 0;
    const provider = new WebshareMediaProvider({
      client,
      probeMedia: async (directUrl) => {
        probedDirectUrl = directUrl;
        probeCount += 1;
        return {
          durationSeconds: 120,
          videoCodec: "h264",
          videoPixelFormat: "yuv420p",
          audioTracks: [
            {
              streamIndex: 1,
              codec: "aac",
              channels: 2,
              channelLayout: "stereo",
              language: "jpn",
              title: null,
            },
          ],
          subtitleTracks: [
            { streamIndex: 2, codec: "subrip", language: "cs", title: null },
          ],
        };
      },
      issuePlaybackTicket: (input) => {
        capturedDirectUrl = input.directUrl;
        return `/api/v1/playback/grants/${input.grantId}`;
      },
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    const grant = await provider.createPlayback(
      {
        profileId: "default",
        titleId: "sai:title:arrival",
        variant: {
          providerId: "webshare",
          candidateId: "file-1",
          variantId: "file-1",
        },
        startPositionSeconds: 0,
      },
      {
        requestId: "request-0001",
        profileId: "default",
        locale: "cs",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        secretRef: null,
      },
    );

    expect(capturedDirectUrl).toBe(
      "https://cdn.webshare.cz/secret-direct-link",
    );
    expect(grant.url).toMatch(/^\/api\/v1\/playback\/grants\//);
    expect(grant.url).not.toContain("secret-direct-link");
    expect(
      await provider.checkPlayback(
        { providerId: "webshare", candidateId: "file-1" },
        {
          requestId: "request-0002",
          profileId: "default",
          locale: "cs",
          deadlineAt: "2099-01-01T00:00:00.000Z",
          secretRef: null,
        },
      ),
    ).toEqual({ audioLanguages: ["jpn"], subtitleLanguages: ["cs"] });
    expect(probedDirectUrl).toBe("https://cdn.webshare.cz/secret-direct-link");
    await provider.checkPlayback(
      { providerId: "webshare", candidateId: "file-1" },
      {
        requestId: "request-0003",
        profileId: "default",
        locale: "cs",
        deadlineAt: "2099-01-01T00:00:00.000Z",
        secretRef: null,
      },
    );
    expect(probeCount).toBe(1);
  });

  it("rejects TMDB calls when the integration is not configured", async () => {
    const client = new TmdbApiClient({
      secretStore: new NonPersistentMemorySecretStore(),
      fetch: async () => response(200, "{}"),
      baseUrl: "https://tmdb.test/3",
    });

    await expect(client.getMovie(1)).rejects.toMatchObject({
      providerId: "tmdb",
      kind: "not-configured",
    });
  });

  it("parses bounded Webshare video results and sends WST in the form body", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    const token = "sentinel-webshare-wst";
    await secrets.set(WEBSHARE_WST_SECRET_KEY, token);
    const calls: Array<{
      url: string;
      headers: Record<string, string>;
      body?: string;
    }> = [];
    const fetch: ProviderFetch = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return response(
        200,
        "<response><status>OK</status><total>1</total><file><ident>abc</ident><name>Arrival.2016.1080p.mkv</name><type>video</type><size>123</size><password>0</password><positive_votes>9</positive_votes><negative_votes>1</negative_votes></file></response>",
      );
    };
    const client = new WebshareClient({
      secretStore: secrets,
      fetch,
      baseUrl: "https://webshare.test/api",
    });

    const result = await client.search({ query: "Arrival 2016" });

    expect(result).toMatchObject({
      total: 1,
      items: [{ ident: "abc", name: "Arrival.2016.1080p.mkv", size: 123 }],
    });
    expect(calls[0]?.url).not.toContain(token);
    expect(calls[0]?.headers.wst).toBeUndefined();
    expect(new URLSearchParams(calls[0]?.body).get("wst")).toBe(token);
  });

  it("treats a Webshare FATAL payload inside HTTP 200 as a provider error", async () => {
    const client = new WebshareClient({
      secretStore: new NonPersistentMemorySecretStore(),
      fetch: async () =>
        response(
          200,
          "<response><status>FATAL</status><code>SEARCH_FATAL_1</code><message>Failure</message></response>",
        ),
      baseUrl: "https://webshare.test/api",
    });

    await expect(client.search({ query: "test" })).rejects.toBeInstanceOf(
      WebshareResponseError,
    );
  });

  it("never returns an unallowlisted Webshare playback URL", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async () =>
        response(
          200,
          "<response><status>OK</status><link>https://evil.example/video</link></response>",
        ),
      baseUrl: "https://webshare.test/api",
    });

    await expect(client.createVideoLink("abc")).rejects.toMatchObject({
      providerId: "webshare",
      kind: "invalid-response",
    });
  });

  it("accepts an HTTPS link from Webshare's documented wsfiles CDN", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.includes("/file_link/")
          ? response(
              200,
              "<response><status>OK</status><link>https://free.17.dl.wsfiles.cz/video</link></response>",
            )
          : response(206, "x"),
      baseUrl: "https://webshare.test/api",
    });

    expect(await client.createVideoLink("abc")).toBe(
      "https://free.17.dl.wsfiles.cz/video",
    );
  });

  it("rejects a direct link that redirects to an HTML page instead of serving media", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.includes("/file_link/")
          ? response(
              200,
              "<response><status>OK</status><link>https://free.17.dl.wsfiles.cz/video</link></response>",
            )
          : response(302, ""),
      baseUrl: "https://webshare.test/api",
    });

    await expect(client.createVideoLink("abc")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("rejects a malformed Content-Range from a nominal 206 response", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.includes("/file_link/")
          ? response(
              200,
              "<response><status>OK</status><link>https://free.17.dl.wsfiles.cz/video</link></response>",
            )
          : response(206, "x", { "content-range": "bytes 5-5/100" }),
      baseUrl: "https://webshare.test/api",
    });
    await expect(client.createVideoLink("abc")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("rejects a source that ignores the Range request", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(WEBSHARE_WST_SECRET_KEY, "test-wst");
    const client = new WebshareClient({
      secretStore: secrets,
      fetch: async (url) =>
        url.includes("/file_link/")
          ? response(
              200,
              "<response><status>OK</status><link>https://free.17.dl.wsfiles.cz/video</link></response>",
            )
          : response(200, "full body"),
      baseUrl: "https://webshare.test/api",
    });
    await expect(client.createVideoLink("abc")).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });
});
