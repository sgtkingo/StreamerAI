import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CatalogTitleSchema,
  DiscoveryResponseSchema,
  HomeFeedSchema,
  type CatalogTitle,
  type DiscoveryResponse,
  type EpisodeSelection,
} from "@streamer-ai/contracts";
import {
  createApp,
  PreviewContentProvider,
  type FetchLike,
  type StreamerContentProvider,
} from "../src/index.js";
import { openStreamerDatabase } from "@streamer-ai/database";

const unusedFetch: FetchLike = async () => {
  throw new Error("External providers must not run in content route tests");
};

describe("provider-neutral content API", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function app() {
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    return instance;
  }

  it("returns all populated Home sections and labels the development fallback", async () => {
    const result = await app().inject({
      method: "GET",
      url: "/api/v1/home?profileId=default",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      profileId: "default",
      mode: "preview",
      sections: [
        { id: "continue-watching" },
        { id: "new-releases" },
        { id: "trending" },
        { id: "top-rated" },
        { id: "for-you" },
      ],
    });
  });

  it("keeps discovery groups canonical, distinct and explicit about preview facts", async () => {
    const instance = app();
    const payload = {
      profileId: "default",
      message: "An autumn movie with Sandra Bullock",
      idempotencyKey: "request-0001",
    };
    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload,
    });
    const body = result.json();

    expect(result.statusCode).toBe(200);
    expect(body.bestMatch.title).toMatchObject({
      title: "The Lake House",
      availability: "available",
    });
    expect(body.warnings[0]).toMatch(/Preview fixture/);
    const ids = [
      body.bestMatch.title.id,
      ...body.available.map((item: { title: { id: string } }) => item.title.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);

    const replay = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(body);

    const conflict = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: { ...payload, message: "A completely different request" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("asks for watched titles, then excludes the reply and playback history", async () => {
    const fixture = new PreviewContentProvider();
    const titles = fixture.bootstrapTitles();
    const provenance = {
      providerId: "test-metadata",
      retrievedAt: "2026-09-27T12:00:00.000Z",
      connectorVersion: "test",
      confidence: 1,
      validationState: "verified" as const,
      expiresAt: null,
    };
    const liveTitle = (title: CatalogTitle) =>
      CatalogTitleSchema.parse({
        ...title,
        metadataProvider: "test-metadata",
        availabilityProvider: "test-media",
        metadataProvenance: provenance,
        availabilityProvenance: { ...provenance, providerId: "test-media" },
        ratings: title.ratings.map((rating) => ({ ...rating, provenance })),
      });
    const watched = liveTitle(
      titles.find((item) => item.title === "Knives Out")!,
    );
    const listed = liveTitle(titles.find((item) => item.title === "Arrival")!);
    const fresh = liveTitle(
      titles.find((item) => item.title === "The Lake House")!,
    );
    const discover = vi.fn(
      async (request: { sessionId?: string }, completedAt: string) =>
        DiscoveryResponseSchema.parse({
          sessionId: request.sessionId,
          mode: "live",
          stage: "completed",
          reply: "Here are some options.",
          bestMatch: {
            title: { ...watched, matchPercent: 95 },
            reason: "First",
          },
          available: [
            { title: { ...listed, matchPercent: 90 }, reason: "Second" },
            { title: { ...fresh, matchPercent: 85 }, reason: "Third" },
          ],
          unavailable: [],
          unverified: [],
          warnings: [],
          completedAt,
        }),
    );
    const provider: StreamerContentProvider = {
      id: "unseen-test",
      mode: "live",
      bootstrapTitles: () => [watched, listed, fresh],
      buildHome: ({ profileId, generatedAt }) =>
        HomeFeedSchema.parse({
          profileId,
          mode: "live",
          generatedAt,
          sections: [],
        }),
      discover,
      discoverFast: discover,
    };
    const database = openStreamerDatabase({ filename: ":memory:" });
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      contentProvider: provider,
      database,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    database.history.append({
      id: "watched-event",
      profileId: "default",
      titleId: watched.id,
      eventType: "start",
      episodeLabel: null,
      progressPercent: 5,
    });
    const first = {
      profileId: "default",
      sessionId: "unseen-session",
      message: "Něco, co jsem neviděl",
      idempotencyKey: "unseen-first",
    };
    const fast = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/fast",
      payload: first,
    });
    const deep = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: { ...first, createSession: true },
    });
    expect(fast.statusCode, fast.body).toBe(200);
    expect(fast.json().stage).toBe("needs-input");
    expect(deep.json().stage).toBe("needs-input");
    expect(deep.json().reply).toMatch(/seznam filmů/i);
    expect(discover).not.toHaveBeenCalled();

    const reply = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: {
        ...first,
        message: "Viděl jsem Arrival (2016)",
        idempotencyKey: "unseen-reply",
      },
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json().bestMatch.title.title).toBe("The Lake House");
    expect(reply.json().available).toEqual([]);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(discover.mock.calls[0]?.[2]).toMatchObject({
      unseen: {
        titleIds: [watched.id],
        titles: expect.arrayContaining(["Arrival (2016)", "Knives Out"]),
      },
    });
  });

  it("cancels an in-flight discovery on the server and aborts its provider signal", async () => {
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let providerAborted = false;
    const contentProvider: StreamerContentProvider = {
      id: "cancellable-test-provider",
      mode: "live",
      bootstrapTitles: () => [],
      buildHome: ({ profileId, generatedAt }) =>
        HomeFeedSchema.parse({
          profileId,
          generatedAt,
          mode: "live",
          sections: [],
        }),
      discover: async (_request, _completedAt, conversation) => {
        started();
        return new Promise<DiscoveryResponse>((_resolve, reject) => {
          conversation?.signal?.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new Error("provider aborted"));
            },
            { once: true },
          );
        });
      },
    };
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      contentProvider,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    const discovery = instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: {
        profileId: "default",
        message: "A film to cancel",
        idempotencyKey: "cancel-request-0001",
      },
    });
    await providerStarted;
    const cancel = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/cancel",
      payload: { profileId: "default", idempotencyKey: "cancel-request-0001" },
    });
    const response = await discovery;
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: true });
    expect(providerAborted).toBe(true);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "DISCOVERY_CANCELLED" },
    });
  });

  it("honours cancellation that arrives before discovery starts", async () => {
    const instance = app();
    const cancelled = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/cancel",
      payload: { profileId: "default", idempotencyKey: "early-cancel-0001" },
    });
    const discovery = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: {
        profileId: "default",
        message: "A film never to start",
        idempotencyKey: "early-cancel-0001",
      },
    });
    expect(cancelled.json()).toEqual({ cancelled: false });
    expect(discovery.statusCode).toBe(409);
    expect(discovery.json()).toMatchObject({
      error: { code: "DISCOVERY_CANCELLED" },
    });
  });

  it("does not invalidate an already completed discovery when cancellation arrives late", async () => {
    const instance = app();
    const payload = {
      profileId: "default",
      message: "A completed film search",
      idempotencyKey: "late-cancel-0001",
    };
    const first = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload,
    });
    const cancel = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/cancel",
      payload: {
        profileId: payload.profileId,
        idempotencyKey: payload.idempotencyKey,
      },
    });
    const replay = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ cancelled: false });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
  });

  it("keeps explicit saves but never records preview playback as History", async () => {
    const instance = app();
    const titleId = encodeURIComponent("sai:preview:lake-house");
    const saved = await instance.inject({
      method: "PUT",
      url: `/api/v1/profiles/default/library/${titleId}`,
    });
    const started = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/start",
      payload: { titleId: "sai:preview:lake-house" },
    });
    const history = await instance.inject({
      method: "GET",
      url: "/api/v1/profiles/default/history",
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json().items[0]).toMatchObject({
      membershipReason: "explicit",
      state: "saved",
    });
    expect(started.statusCode).toBe(409);
    expect(started.json()).toMatchObject({
      error: { code: "PLAYBACK_NOT_CONFIGURED" },
    });
    expect(history.json().items).toHaveLength(0);
  });

  it("opens one detail contract for movies and series without inventing preview episodes", async () => {
    const instance = app();
    const movie = await instance.inject({
      method: "GET",
      url: "/api/v1/profiles/default/titles/sai%3Apreview%3Alake-house",
    });
    const series = await instance.inject({
      method: "GET",
      url: "/api/v1/profiles/default/titles/sai%3Apreview%3Aonly-murders",
    });
    expect(movie.statusCode).toBe(200);
    expect(movie.json()).toMatchObject({
      title: { kind: "movie" },
      series: null,
    });
    expect(Array.isArray(movie.json().related)).toBe(true);
    expect(series.statusCode).toBe(200);
    expect(series.json()).toMatchObject({
      title: { kind: "series" },
      series: null,
    });
    const retry = await instance.inject({
      method: "GET",
      url: "/api/v1/profiles/default/titles/sai%3Apreview%3Aonly-murders?retry=true",
    });
    expect(retry.statusCode).toBe(200);
  });

  it("rejects an incomplete episode selection before playback", async () => {
    const instance = app();
    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/prepare",
      payload: { titleId: "sai:preview:only-murders", seasonNumber: 1 },
    });
    expect(result.statusCode).toBe(400);
  });

  it("never offers playback for a preview-only title", async () => {
    const result = await app().inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/start",
      payload: { titleId: "sai:preview:before-sunrise" },
    });

    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({
      error: { code: "PLAYBACK_NOT_CONFIGURED" },
    });
  });

  it("does not create profiles as a side effect of read requests", async () => {
    const instance = app();
    for (let index = 1; index <= 7; index += 1) {
      const result = await instance.inject({
        method: "GET",
        url: `/api/v1/home?profileId=unknown-${index}`,
      });
      expect(result.statusCode).toBe(404);
      expect(result.json()).toMatchObject({
        error: { code: "PROFILE_NOT_FOUND" },
      });
    }

    const defaultProfile = await instance.inject({
      method: "GET",
      url: "/api/v1/home?profileId=default",
    });
    expect(defaultProfile.statusCode).toBe(200);
  });

  it("persists dynamically discovered provider titles in the canonical cache", async () => {
    const metadataProvenance = {
      providerId: "test-db",
      retrievedAt: "2026-09-27T12:00:00.000Z",
      connectorVersion: "1.0.0",
      confidence: 1,
      validationState: "verified" as const,
      expiresAt: null,
    };
    const availabilityProvenance = {
      ...metadataProvenance,
      providerId: "test-media",
    };
    const discoveredTitle = CatalogTitleSchema.parse({
      id: "sai:test:dynamic-title",
      kind: "movie",
      title: "Dynamic title",
      originalTitle: null,
      year: 2026,
      synopsis: "A title returned by an injected discovery coordinator.",
      posterUrl: null,
      backdropUrl: null,
      accentColor: "#345678",
      genres: ["Drama"],
      ratings: [
        {
          source: "Test DB",
          value: 80,
          scale: 100,
          votes: 42,
          provenance: metadataProvenance,
        },
      ],
      matchPercent: 91,
      availability: "available",
      availabilityProvider: "test-media",
      availabilityCheckedAt: "2026-09-27T12:00:00.000Z",
      formats: [
        {
          label: "1080p",
          container: "mkv",
          resolution: "1080p",
          videoCodec: "H.264",
          audioLanguages: ["en"],
          subtitleLanguages: ["cs"],
        },
      ],
      sources: [
        {
          id: "a".repeat(32),
          providerId: "test-media",
          candidateId: "candidate-1",
          releaseName: "Dynamic.title.1080p.mkv",
          sizeBytes: 100,
          format: {
            label: "1080p",
            container: "mkv",
            resolution: "1080p",
            videoCodec: "H.264",
            audioLanguages: ["en"],
            subtitleLanguages: ["cs"],
          },
          seasonNumber: null,
          episodeNumber: null,
          checkedAt: "2026-09-27T12:00:00.000Z",
        },
      ],
      seriesCoverage: null,
      metadataProvider: "test-db",
      metadataValidatedAt: "2026-09-27T12:00:00.000Z",
      metadataProvenance,
      availabilityProvenance,
      inLibrary: false,
      progressPercent: null,
    });
    const preparePlayback = vi.fn(
      async (
        _profileId: string,
        title: CatalogTitle,
        _episode?: EpisodeSelection,
        _sourceId?: string,
      ) => ({
        grantId: "grant-dynamic",
        titleId: title.id,
        providerId: "test-media",
        variantId: "variant-1",
        url: "/api/v1/playback/grants/grant-dynamic",
        supportsHttpRange: true,
        expiresAt: "2026-09-27T12:05:00.000Z",
        embeddedSubtitles: [],
      }),
    );
    const checkPlayback = vi.fn(
      async (
        _profileId: string,
        _title: CatalogTitle,
        _episode?: EpisodeSelection,
        _sourceId?: string,
      ) => ({
        audioLanguages: ["en"],
        subtitleLanguages: ["cs"],
      }),
    );
    let deepUserMessages = 0;
    let deepQuickMessages = 0;
    const contentProvider: StreamerContentProvider = {
      id: "test-coordinator",
      mode: "live",
      bootstrapTitles: () => [],
      buildHome: ({ profileId, generatedAt }) =>
        HomeFeedSchema.parse({
          profileId,
          mode: "live",
          generatedAt,
          sections: [],
        }),
      discoverFast: async (request, completedAt) =>
        DiscoveryResponseSchema.parse({
          sessionId: request.sessionId ?? "dynamic-session",
          mode: "live",
          stage: "completed",
          reply: "Quick validated matches.",
          bestMatch: { title: discoveredTitle, reason: "Fast API match." },
          available: [],
          unavailable: [],
          unverified: [],
          warnings: [],
          completedAt,
        }),
      discover: async (request, completedAt, context) => {
        deepUserMessages =
          context?.messages.filter((item) => item.role === "user").length ?? 0;
        deepQuickMessages =
          context?.messages.filter(
            (item) =>
              item.role === "assistant" &&
              typeof item.content === "object" &&
              item.content !== null &&
              "stage" in item.content &&
              item.content.stage === "quick",
          ).length ?? 0;
        return DiscoveryResponseSchema.parse({
          sessionId: request.sessionId ?? "dynamic-session",
          mode: "live",
          stage: "completed",
          reply: "Validated by injected test providers.",
          bestMatch: { title: discoveredTitle, reason: "Best test match." },
          available: [],
          unavailable: [],
          unverified: [],
          warnings: [],
          completedAt,
        });
      },
      preparePlayback,
      checkPlayback,
    };
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      contentProvider,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);

    const fastDiscovery = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/fast",
      payload: {
        profileId: "default",
        message: "Find the dynamic test title",
        sessionId: "shared-dynamic-session",
        idempotencyKey: "dynamic-request-1",
      },
    });
    const discovery = await instance.inject({
      method: "POST",
      url: "/api/v1/discovery/sessions",
      payload: {
        profileId: "default",
        message: "Find the dynamic test title",
        sessionId: "shared-dynamic-session",
        createSession: true,
        idempotencyKey: "dynamic-request-1",
      },
    });
    const saved = await instance.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/library/sai%3Atest%3Adynamic-title",
    });
    const prepared = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/prepare",
      payload: { titleId: "sai:test:dynamic-title" },
    });
    const selected = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/prepare",
      payload: { titleId: discoveredTitle.id, sourceId: "a".repeat(32) },
    });
    const checked = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/check",
      payload: { titleId: discoveredTitle.id, sourceId: "a".repeat(32) },
    });
    const malformed = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/prepare",
      payload: { titleId: discoveredTitle.id, sourceId: "not-a-source-id" },
    });
    const historyBeforePlay = await instance.inject({
      method: "GET",
      url: "/api/v1/profiles/default/history",
    });
    const started = await instance.inject({
      method: "POST",
      url: "/api/v1/profiles/default/playback/start",
      payload: { titleId: "sai:test:dynamic-title" },
    });

    expect(discovery.statusCode).toBe(200);
    expect(fastDiscovery.statusCode).toBe(200);
    expect(fastDiscovery.json().sessionId).toBe("shared-dynamic-session");
    expect(deepUserMessages).toBe(1);
    expect(deepQuickMessages).toBe(1);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().items[0].title.id).toBe("sai:test:dynamic-title");
    expect(saved.json().items[0].title.sources).toMatchObject([
      { id: "a".repeat(32), candidateId: "candidate-1" },
    ]);
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().playback.titleId).toBe("sai:test:dynamic-title");
    expect(selected.statusCode).toBe(200);
    expect(checked.statusCode).toBe(200);
    expect(malformed.statusCode).toBe(400);
    expect(preparePlayback.mock.calls[1]?.[3]).toBe("a".repeat(32));
    expect(checkPlayback.mock.calls[0]?.[3]).toBe("a".repeat(32));
    expect(historyBeforePlay.json().items).toHaveLength(0);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({
      playback: {
        titleId: "sai:test:dynamic-title",
        url: "/api/v1/playback/grants/grant-dynamic",
      },
      library: { items: [{ state: "in-progress" }] },
    });
  });
});
