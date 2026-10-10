import type {
  AgentProvider,
  CanonicalTitlePayload,
  MediaProvider,
  MetadataProvider,
  ProviderRegistry,
} from "@streamer-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import { LiveContentCoordinator } from "../src/services/live-content-coordinator.js";
import { PreviewContentProvider } from "../src/services/content-provider.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

const NOW = "2026-09-29T20:00:00.000Z";
const provenance = {
  providerId: "tmdb",
  retrievedAt: NOW,
  connectorVersion: "test",
  confidence: 1,
  validationState: "verified" as const,
  expiresAt: null,
};

function metadataPayload(id: string, title: string): CanonicalTitlePayload {
  return {
    ref: { providerId: "tmdb", externalId: id, entityType: "movie" },
    kind: "movie",
    title,
    originalTitle: title,
    localizedTitles: [{ locale: "en", value: title, provenance }],
    year: id === "1" ? 2001 : 2002,
    synopsis: `Validated synopsis for ${title}.`,
    genres: ["Drama"],
    posterUrl: `https://image.tmdb.org/${id}.jpg`,
    backdropUrl: null,
    fieldProvenance: {
      title: provenance,
      originalTitle: provenance,
      year: provenance,
      synopsis: provenance,
      genres: provenance,
      posterUrl: provenance,
      backdropUrl: provenance,
    },
  };
}

async function connectedStateStore(
  ids: readonly string[] = ["tmdb", "webshare", "ollama"],
) {
  const store = new NonPersistentMemoryIntegrationStateStore();
  for (const integrationId of ids) {
    await store.set({
      integrationId,
      status: "connected",
      configured: true,
      checkedAt: NOW,
      updatedAt: NOW,
    });
  }
  return store;
}

function registry<T extends { descriptor(): { id: string } }>(
  providers: readonly T[],
): ProviderRegistry<T> {
  const byId = new Map(
    providers.map((provider) => [provider.descriptor().id, provider]),
  );
  return {
    list: () => providers,
    get: (id) => byId.get(id) ?? null,
    require: (id) => {
      const provider = byId.get(id);
      if (!provider) throw new Error(`Provider '${id}' is not registered.`);
      return provider;
    },
  };
}

function coordinatorDependencies() {
  const generateStructured = vi.fn().mockResolvedValue({
    output: {
      acknowledgement: "I tuned the mood to your request.",
      people: [],
      candidates: [
        {
          title: "Agent title one",
          kind: "movie",
          year: 2001,
          reason: "The agent's first reason.",
          matchPercent: 82,
        },
        {
          title: "Agent title two",
          kind: "movie",
          year: 2002,
          reason: "The agent's second reason.",
          matchPercent: 95,
        },
      ],
    },
    model: "qwen3.5:4b",
    finishReason: "completed",
    inputTokens: 10,
    outputTokens: 20,
    provenance,
  });
  const agent = { generateStructured } as unknown as AgentProvider;
  const searchMetadata = vi.fn().mockImplementation(async (query) => {
    const first = query.query.includes("one");
    return [
      {
        ref: {
          providerId: "tmdb",
          externalId: first ? "1" : "2",
          entityType: "movie",
        },
        kind: "movie",
        title: query.query,
        originalTitle: query.query,
        year: first ? 2001 : 2002,
        confidence: 1,
        provenance,
      },
    ];
  });
  const metadata = {
    search: searchMetadata,
    getTitle: vi
      .fn()
      .mockImplementation(async (ref) =>
        metadataPayload(
          ref.externalId,
          ref.externalId === "1" ? "Canonical One" : "Canonical Two",
        ),
      ),
    getRatings: vi
      .fn()
      .mockResolvedValue([
        { source: "TMDB", value: 8, scale: 10, votes: 100, provenance },
      ]),
  } as unknown as MetadataProvider;
  const searchMedia = vi.fn().mockImplementation(async (request) =>
    request.title.includes("One")
      ? [
          {
            ref: { providerId: "webshare", candidateId: "file-1" },
            releaseName: "Canonical.One.2001.1080p.mkv",
            sizeBytes: 10,
            seasonNumber: null,
            episodeNumber: null,
            confidence: 0.8,
            provenance: { ...provenance, providerId: "webshare" },
          },
        ]
      : [],
  );
  const media = {
    descriptor: () => ({ connectorVersion: "test" }),
    search: searchMedia,
    inspect: vi.fn().mockResolvedValue({
      ref: { providerId: "webshare", candidateId: "file-1" },
      variantId: "file-1",
      format: {
        label: "1080p · H.264",
        container: "mkv",
        resolution: "1080p",
        videoCodec: "H.264",
        audioLanguages: ["en"],
        subtitleLanguages: [],
      },
      directPlay: true,
      supportsHttpRange: true,
      embeddedSubtitles: [],
      provenance: { ...provenance, providerId: "webshare" },
      expiresAt: null,
    }),
  } as unknown as MediaProvider;
  return { agent, generateStructured, metadata, media };
}

async function seriesCoordinator(
  dependencies: ReturnType<typeof coordinatorDependencies>,
) {
  return new LiveContentCoordinator({
    ...dependencies,
    integrationStateStore: await connectedStateStore(),
    inference: {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3.5:4b",
      minimumVersion: "0.5.0",
      contextTokens: 4096,
      maxOutputTokens: 512,
      timeoutMs: 60_000,
    },
    localeForProfile: () => "en",
    now: () => new Date(NOW),
  });
}

function numberedSeriesStructure() {
  return {
    seriesRef: { providerId: "tmdb", externalId: "42", entityType: "series" },
    seasons: [
      {
        ref: { providerId: "tmdb", externalId: "43", entityType: "season" },
        seasonNumber: 0,
        title: "Specials",
        provenance,
        episodes: Array.from({ length: 10 }, (_, index) => ({
          ref: {
            providerId: "tmdb",
            externalId: String(100 + index),
            entityType: "episode",
          },
          episodeNumber: index + 1,
          title: `Special ${index + 1}`,
          airDate: null,
          runtimeMinutes: 30,
          provenance,
        })),
      },
      {
        ref: { providerId: "tmdb", externalId: "44", entityType: "season" },
        seasonNumber: 1,
        title: "Season 1",
        provenance,
        episodes: Array.from({ length: 5 }, (_, index) => ({
          ref: {
            providerId: "tmdb",
            externalId: String(200 + index),
            entityType: "episode",
          },
          episodeNumber: index + 1,
          title:
            index === 4 ? "The Heirs of the Dragon" : `Episode ${index + 1}`,
          synopsis: index === 4 ? "The heir faces a difficult choice." : "",
          airDate: null,
          runtimeMinutes: 30,
          provenance,
        })),
      },
    ],
    complete: true,
    provenance,
  };
}

describe("LiveContentCoordinator", () => {
  it("keeps mirrors from different media connectors and falls back across them", async () => {
    const dependencies = coordinatorDependencies();
    dependencies.media.descriptor = () =>
      ({
        id: "webshare",
        connectorVersion: "test",
      }) as ReturnType<MediaProvider["descriptor"]>;
    const websharePlayback = vi
      .fn()
      .mockRejectedValue(new Error("Webshare is unavailable"));
    dependencies.media.createPlayback = websharePlayback;
    const nasPlayback = vi.fn().mockResolvedValue({
      grantId: "nas-grant",
      titleId: "sai:tmdb:movie:1",
      providerId: "nas",
      variantId: "nas-file",
      url: "/api/v1/playback/grants/nas-grant",
      supportsHttpRange: true,
      expiresAt: "2026-09-29T21:00:00.000Z",
      embeddedSubtitles: [],
    });
    const nas = {
      descriptor: () => ({ id: "nas", connectorVersion: "test" }),
      search: vi.fn().mockImplementation(async (request) =>
        request.title.includes("One")
          ? [
              {
                ref: { providerId: "nas", candidateId: "nas-file" },
                releaseName: "Canonical.One.2001.720p.mkv",
                sizeBytes: 15,
                seasonNumber: null,
                episodeNumber: null,
                confidence: 0.8,
                provenance: { ...provenance, providerId: "nas" },
              },
            ]
          : [],
      ),
      inspect: vi.fn().mockImplementation(async (ref) => ({
        ref,
        variantId: ref.candidateId,
        format: {
          label: "720p · H.264",
          container: "mkv",
          resolution: "720p",
          videoCodec: "H.264",
          audioLanguages: ["en"],
          subtitleLanguages: [],
        },
        directPlay: true,
        supportsHttpRange: true,
        embeddedSubtitles: [],
        provenance: { ...provenance, providerId: "nas" },
        expiresAt: null,
      })),
      createPlayback: nasPlayback,
    } as unknown as MediaProvider;
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      media: registry([dependencies.media, nas]),
      integrationStateStore: await connectedStateStore([
        "tmdb",
        "webshare",
        "nas",
        "ollama",
      ]),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });

    const response = await coordinator.discover(
      {
        profileId: "default",
        sessionId: "multi-source",
        message: "Find two films",
        idempotencyKey: "multi-source-request",
      },
      NOW,
    );
    const title = response.bestMatch!.title;
    expect(title.sources?.map((source) => source.providerId)).toEqual([
      "webshare",
      "nas",
    ]);
    expect(new Set(title.sources?.map((source) => source.id)).size).toBe(2);
    const grant = await coordinator.preparePlayback("default", title);
    expect(websharePlayback).toHaveBeenCalledOnce();
    expect(nasPlayback).toHaveBeenCalledOnce();
    expect(grant.providerId).toBe("nas");
    await expect(
      coordinator.preparePlayback(
        "default",
        title,
        undefined,
        title.sources![0]!.id,
      ),
    ).rejects.toThrow("Webshare is unavailable");
    expect(nasPlayback).toHaveBeenCalledOnce();
  });

  it("continues metadata lookup when another registered connector fails", async () => {
    const dependencies = coordinatorDependencies();
    const broken = {
      descriptor: () => ({ id: "tmdb" }),
      search: vi.fn().mockRejectedValue(new Error("TMDB offline")),
    } as unknown as MetadataProvider;
    const csfdProvenance = { ...provenance, providerId: "csfd" };
    const csfd = {
      descriptor: () => ({ id: "csfd" }),
      search: vi.fn().mockResolvedValue([
        {
          ref: { providerId: "csfd", externalId: "1", entityType: "movie" },
          kind: "movie",
          title: "Agent title one",
          originalTitle: "Agent title one",
          year: 2001,
          confidence: 1,
          provenance: csfdProvenance,
        },
      ]),
      getTitle: vi.fn().mockImplementation(async () => {
        const payload = metadataPayload("1", "Canonical One");
        return {
          ...payload,
          ref: { providerId: "csfd", externalId: "1", entityType: "movie" },
          localizedTitles: [
            {
              locale: "en",
              value: "Canonical One",
              provenance: csfdProvenance,
            },
          ],
          fieldProvenance: Object.fromEntries(
            Object.keys(payload.fieldProvenance).map((field) => [
              field,
              csfdProvenance,
            ]),
          ),
        };
      }),
      getRatings: vi.fn().mockResolvedValue([]),
    } as unknown as MetadataProvider;
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      metadata: registry([broken, csfd]),
      integrationStateStore: await connectedStateStore([
        "tmdb",
        "csfd",
        "webshare",
      ]),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const response = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "metadata-fallback",
        message: "Agent title one",
        idempotencyKey: "metadata-fallback-request",
      },
      NOW,
    );
    expect(response.stage).toBe("completed");
    expect(response.bestMatch?.title.id).toBe("sai:csfd:movie:1");
    expect(response.bestMatch?.title.metadataProvider).toBe("csfd");
    expect(response.bestMatch?.title.sources?.[0]?.providerId).toBe("webshare");
  });

  it("tries another metadata source when the first resolves without playable media", async () => {
    const dependencies = coordinatorDependencies();
    dependencies.metadata.descriptor = () =>
      ({ id: "tmdb", connectorVersion: "test" }) as ReturnType<
        MetadataProvider["descriptor"]
      >;
    const tmdbCandidate = {
      ref: { providerId: "tmdb", externalId: "1", entityType: "movie" },
      kind: "movie",
      title: "Agent title one",
      originalTitle: "Agent title one",
      year: 2001,
      confidence: 1,
      provenance,
    };
    vi.mocked(dependencies.metadata.search).mockImplementation(async (query) =>
      query.query.includes("one") ? [tmdbCandidate] : [],
    );
    vi.mocked(dependencies.metadata.getTitle).mockResolvedValue(
      metadataPayload("1", "Unplayable One"),
    );
    const csfdProvenance = { ...provenance, providerId: "csfd" };
    const csfdPayload = metadataPayload("1", "Canonical One");
    const csfd = {
      descriptor: () => ({ id: "csfd", connectorVersion: "test" }),
      search: vi.fn().mockImplementation(async (query) =>
        query.query.includes("one")
          ? [
              {
                ...tmdbCandidate,
                ref: { ...tmdbCandidate.ref, providerId: "csfd" },
                confidence: 0.9,
                provenance: csfdProvenance,
              },
            ]
          : [],
      ),
      getTitle: vi.fn().mockResolvedValue({
        ...csfdPayload,
        ref: { ...csfdPayload.ref, providerId: "csfd" },
        localizedTitles: [
          { locale: "en", value: "Canonical One", provenance: csfdProvenance },
        ],
        fieldProvenance: Object.fromEntries(
          Object.keys(csfdPayload.fieldProvenance).map((field) => [
            field,
            csfdProvenance,
          ]),
        ),
      }),
      getRatings: vi.fn().mockResolvedValue([]),
    } as unknown as MetadataProvider;
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      metadata: registry([dependencies.metadata, csfd]),
      integrationStateStore: await connectedStateStore([
        "tmdb",
        "csfd",
        "webshare",
        "ollama",
      ]),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });

    const request = {
      profileId: "default",
      sessionId: "metadata-playability-fallback",
      message: "Agent title one",
      idempotencyKey: "metadata-playability-request",
    };
    const quick = await coordinator.discoverFast(request, NOW);
    expect(quick.bestMatch?.title.metadataProvider).toBe("csfd");
    expect(quick.bestMatch?.title.sources?.[0]?.providerId).toBe("webshare");

    const agent = await coordinator.discover(request, NOW);
    expect(agent.bestMatch?.title.metadataProvider).toBe("csfd");
    expect(agent.bestMatch?.title.sources?.[0]?.providerId).toBe("webshare");
    expect(dependencies.metadata.getTitle).toHaveBeenCalledTimes(2);
    expect(csfd.getTitle).toHaveBeenCalledTimes(2);
  });

  it("finds a single requested episode by its cumulative part number", async () => {
    const dependencies = coordinatorDependencies();
    const panTau = {
      ref: {
        providerId: "tmdb",
        externalId: "42",
        entityType: "series" as const,
      },
      kind: "series" as const,
      title: "Pan Tau",
      originalTitle: "Pan Tau",
      year: 1970,
      confidence: 1,
      provenance,
    };
    vi.mocked(dependencies.metadata.search).mockResolvedValue([panTau]);
    vi.mocked(dependencies.metadata.getTitle).mockResolvedValue({
      ...metadataPayload("42", "Pan Tau"),
      ref: panTau.ref,
      kind: "series",
      year: 1970,
    });
    dependencies.metadata.getSeriesStructure = vi
      .fn()
      .mockResolvedValue(numberedSeriesStructure());
    vi.mocked(dependencies.media.search).mockImplementation(async (request) =>
      request.episodeSearchTerm === "15"
        ? [
            {
              ref: { providerId: "webshare", candidateId: "wrong-episode" },
              releaseName: "Pan.Tau.S02E05.mkv",
              sizeBytes: 100,
              seasonNumber: null,
              episodeNumber: null,
              confidence: 0.8,
              provenance: { ...provenance, providerId: "webshare" },
            },
            {
              ref: { providerId: "webshare", candidateId: "part-15" },
              releaseName: "Pan.Tau.Part.15.mkv",
              sizeBytes: 100,
              seasonNumber: null,
              episodeNumber: null,
              confidence: 0.8,
              provenance: { ...provenance, providerId: "webshare" },
            },
          ]
        : [],
    );
    const coordinator = await seriesCoordinator(dependencies);
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "Pan Tau S01E05",
        idempotencyKey: "direct-episode",
      },
      NOW,
    );
    expect(dependencies.metadata.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "Pan Tau", kind: "series" }),
      expect.anything(),
    );
    expect(result.bestMatch?.title.sources?.[0]).toMatchObject({
      candidateId: "part-15",
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(result.bestMatch?.episode).toEqual({
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(result.bestMatch?.episodeTitle).toBe("The Heirs of the Dragon");
    expect(result.bestMatch?.episodeSynopsis).toBe(
      "The heir faces a difficult choice.",
    );
    expect(dependencies.media.inspect).not.toHaveBeenCalledWith(
      { providerId: "webshare", candidateId: "wrong-episode" },
      expect.anything(),
    );
    expect(dependencies.media.search).toHaveBeenCalledWith(
      expect.objectContaining({ episodeSearchTerm: "15" }),
      expect.anything(),
    );
    const deepResult = await coordinator.discover(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "Pan Tau S01E05",
        idempotencyKey: "deep-direct-episode",
      },
      NOW,
    );
    expect(deepResult.bestMatch?.title.sources?.[0]?.candidateId).toBe(
      "part-15",
    );
    expect(dependencies.generateStructured).not.toHaveBeenCalled();

    const title = {
      ...new PreviewContentProvider()
        .bootstrapTitles()
        .find((item) => item.kind === "series")!,
      id: "sai:tmdb:series:42",
      title: "Pan Tau",
      originalTitle: "Pan Tau",
    };
    const sources = await coordinator.forceSearchEpisode("default", title, {
      seasonNumber: 1,
      episodeNumber: 5,
    });
    expect(sources[0]).toMatchObject({
      candidateId: "part-15",
      seasonNumber: 1,
      episodeNumber: 5,
    });
  });

  it("returns validated quick matches without starting the local agent", async () => {
    const dependencies = coordinatorDependencies();
    vi.mocked(dependencies.media.search).mockImplementation(async () =>
      [1, 2, 3].map((number) => ({
        ref: { providerId: "webshare", candidateId: `quick-${number}` },
        releaseName: `Canonical.One.2001.${number}080p.mkv`,
        sizeBytes: number * 100,
        seasonNumber: null,
        episodeNumber: null,
        confidence: 0.8,
        provenance: { ...provenance, providerId: "webshare" },
      })),
    );
    const states = new NonPersistentMemoryIntegrationStateStore();
    for (const integrationId of ["tmdb", "webshare"]) {
      await states.set({
        integrationId,
        status: "connected",
        configured: true,
        checkedAt: NOW,
        updatedAt: NOW,
      });
    }
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: states,
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "Agent title one",
        idempotencyKey: "parallel-0001",
      },
      NOW,
    );
    expect(result.bestMatch?.title.title).toBe("Canonical One");
    expect(result.bestMatch?.title.sources).toHaveLength(3);
    expect(result.bestMatch?.reason).toBe("Similar title match.");
    expect(dependencies.generateStructured).not.toHaveBeenCalled();
    expect(dependencies.metadata.search).toHaveBeenCalledTimes(1);
    expect(dependencies.media.inspect).toHaveBeenCalledTimes(3);
  });

  it("checks beyond two restricted files before declaring a quick title unavailable", async () => {
    const dependencies = coordinatorDependencies();
    vi.mocked(dependencies.media.search).mockResolvedValue(
      [1, 2, 3].map((number) => ({
        ref: { providerId: "webshare", candidateId: `quick-${number}` },
        releaseName: `Canonical.One.2001.${number}080p.mkv`,
        sizeBytes: number * 100,
        seasonNumber: null,
        episodeNumber: null,
        confidence: 0.8,
        provenance: { ...provenance, providerId: "webshare" },
      })),
    );
    vi.mocked(dependencies.media.inspect).mockImplementation(async (ref) => {
      if (ref.candidateId !== "quick-3") throw new Error("restricted file");
      return {
        ref,
        variantId: ref.candidateId,
        format: {
          label: "1080p · H.264",
          container: "mkv",
          resolution: "1080p",
          videoCodec: "H.264",
          audioLanguages: ["en"],
          subtitleLanguages: [],
        },
        directPlay: true,
        supportsHttpRange: true,
        embeddedSubtitles: [],
        provenance: { ...provenance, providerId: "webshare" },
        expiresAt: null,
      };
    });
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "canonical one",
        idempotencyKey: "quick-restricted",
      },
      NOW,
    );
    expect(result.bestMatch?.title.availability).toBe("available");
    expect(result.bestMatch?.title.sources?.[0]?.candidateId).toBe("quick-3");
    expect(dependencies.media.inspect).toHaveBeenCalledTimes(3);
  });

  it("retries a yearless media query for a quick series title such as Pan Tau", async () => {
    const dependencies = coordinatorDependencies();
    const panTau = {
      ref: {
        providerId: "tmdb",
        externalId: "42",
        entityType: "series" as const,
      },
      kind: "series" as const,
      title: "Pan Tau",
      originalTitle: "Pan Tau",
      year: 1970,
      confidence: 1,
      provenance,
    };
    vi.mocked(dependencies.metadata.search).mockResolvedValue([panTau]);
    vi.mocked(dependencies.metadata.getTitle).mockResolvedValue({
      ...metadataPayload("42", "Pan Tau"),
      ref: panTau.ref,
      kind: "series",
      year: 1970,
    });
    dependencies.metadata.getSeriesStructure = vi.fn().mockResolvedValue({
      seriesRef: panTau.ref,
      seasons: [
        {
          ref: { providerId: "tmdb", externalId: "43", entityType: "season" },
          seasonNumber: 1,
          title: "Season 1",
          provenance,
          episodes: [
            {
              ref: {
                providerId: "tmdb",
                externalId: "44",
                entityType: "episode",
              },
              episodeNumber: 1,
              title: "Episode 1",
              airDate: "1970-01-01",
              runtimeMinutes: 30,
              provenance,
            },
          ],
        },
      ],
      complete: true,
      provenance,
    });
    vi.mocked(dependencies.media.search).mockImplementation(async (request) =>
      request.year === null
        ? [
            {
              ref: { providerId: "webshare", candidateId: "pan-tau-s01e01" },
              releaseName: "Pan.Tau.S01E01.mkv",
              sizeBytes: 100,
              seasonNumber: null,
              episodeNumber: null,
              confidence: 0.8,
              provenance: { ...provenance, providerId: "webshare" },
            },
          ]
        : [],
    );
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "Pan Tau",
        idempotencyKey: "quick-pan-tau",
      },
      NOW,
    );
    expect(result.bestMatch?.title.title).toBe("Pan Tau");
    expect(result.bestMatch?.title.availability).toBe("available");
    expect(result.bestMatch?.title.sources?.[0]?.candidateId).toBe(
      "pan-tau-s01e01",
    );
    expect(dependencies.media.search).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(dependencies.media.search).mock.calls[1]?.[0].year,
    ).toBeNull();
    expect(dependencies.generateStructured).not.toHaveBeenCalled();
  });

  it("keeps a truncated media search unverified instead of claiming the title is unavailable", async () => {
    const dependencies = coordinatorDependencies();
    vi.mocked(dependencies.media.search).mockImplementation(async (request) =>
      request.year === null
        ? []
        : Array.from({ length: 20 }, (_, index) => ({
            ref: {
              providerId: "webshare",
              candidateId: `restricted-${index}`,
            },
            releaseName: `Canonical.One.2001.${index}.mkv`,
            sizeBytes: index + 1,
            seasonNumber: null,
            episodeNumber: null,
            confidence: 0.8,
            provenance: { ...provenance, providerId: "webshare" },
          })),
    );
    vi.mocked(dependencies.media.inspect).mockRejectedValue(
      new Error("restricted file"),
    );
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "canonical one",
        idempotencyKey: "quick-truncated",
      },
      NOW,
    );
    expect(result.unavailable).toHaveLength(0);
    expect(result.unverified[0]?.title.availability).toBe("unknown");
    expect(dependencies.media.inspect).toHaveBeenCalledTimes(12);
  });

  it("does not present unrelated trending titles as quick matches for a mood query", async () => {
    const dependencies = coordinatorDependencies();
    vi.mocked(dependencies.metadata.search).mockResolvedValue([]);
    dependencies.metadata.getFeed = vi.fn().mockResolvedValue([
      {
        ref: { providerId: "tmdb", externalId: "1", entityType: "movie" },
        kind: "movie",
        title: "Canonical One",
        originalTitle: "Canonical One",
        year: 2001,
        confidence: 1,
        provenance,
      },
    ]);
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const result = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "An autumn mystery with Sandra Bullock",
        idempotencyKey: "quick-mood",
      },
      NOW,
    );
    expect(result.bestMatch).toBeNull();
    expect(result.available).toHaveLength(0);
    expect(result.unavailable).toHaveLength(0);
    expect(result.unverified).toHaveLength(0);
    expect(dependencies.media.search).not.toHaveBeenCalled();
    expect(dependencies.generateStructured).not.toHaveBeenCalled();

    vi.mocked(dependencies.metadata.search).mockResolvedValue([
      {
        ref: { providerId: "tmdb", externalId: "1", entityType: "movie" },
        kind: "movie",
        title: "Canonical One",
        originalTitle: "Canonical One",
        year: 2001,
        confidence: 1,
        provenance,
      },
    ]);
    const unrelatedApiHit = await coordinator.discoverFast(
      {
        profileId: "default",
        sessionId: "shared-session",
        message: "An autumn mystery with Sandra Bullock",
        idempotencyKey: "quick-unrelated-api-hit",
      },
      NOW,
    );
    expect(unrelatedApiHit.bestMatch).toBeNull();
    expect(unrelatedApiHit.available).toHaveLength(0);
    expect(dependencies.media.search).not.toHaveBeenCalled();
  });

  it("rechecks a provisional title through safe title and year variants without repeating files", async () => {
    const title = {
      ...new PreviewContentProvider()
        .bootstrapTitles()
        .find((item) => item.kind === "movie")!,
      id: "sai:tmdb:movie:42",
      title: "Pán času",
      originalTitle: "Time Traveller",
      year: 1970,
      availability: "unknown" as const,
      sources: [],
    };
    const candidate = (candidateId: string, releaseName: string) => ({
      ref: { providerId: "webshare", candidateId },
      releaseName,
      sizeBytes: 100,
      seasonNumber: null,
      episodeNumber: null,
      confidence: 0.8,
      provenance: { ...provenance, providerId: "webshare" },
    });
    const unrelated = candidate("wrong-film", "Another.Movie.1970.mkv");
    const restricted = candidate("restricted", "Time.Traveller.1970.1080p.mkv");
    const playable = candidate("playable", "Pan.Casu.1080p.mkv");
    const search = vi.fn().mockImplementation(async (request) => {
      if (request.originalTitle !== null && request.year === 1970)
        return [unrelated, restricted];
      if (request.originalTitle !== null && request.year === null)
        return [restricted];
      if (request.originalTitle === null && request.year === null)
        return [unrelated, playable];
      return [];
    });
    const checkPlayback = vi.fn().mockImplementation(async (ref) => {
      if (ref.candidateId === "restricted") throw new Error("restricted");
      return undefined;
    });
    const coordinator = new LiveContentCoordinator({
      agent: {} as AgentProvider,
      metadata: {} as MetadataProvider,
      media: { search, checkPlayback } as unknown as MediaProvider,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "cs",
      now: () => new Date(NOW),
    });

    await coordinator.checkPlayback("default", title);
    expect(search).toHaveBeenCalledTimes(4);
    expect(
      search.mock.calls.map(([request]) => [
        request.originalTitle,
        request.year,
      ]),
    ).toEqual([
      ["Time Traveller", 1970],
      [null, 1970],
      ["Time Traveller", null],
      [null, null],
    ]);
    expect(checkPlayback.mock.calls.map(([ref]) => ref.candidateId)).toEqual([
      "restricted",
      "playable",
    ]);

    await coordinator.checkPlayback("default", title);
    expect(search).toHaveBeenCalledTimes(4);
    expect(checkPlayback.mock.calls[2]?.[0].candidateId).toBe("playable");
  });

  it("does not accept a release whose longer word only contains the movie title", async () => {
    const title = {
      ...new PreviewContentProvider()
        .bootstrapTitles()
        .find((item) => item.kind === "movie")!,
      id: "sai:tmdb:movie:up",
      title: "Up",
      originalTitle: "Up",
      year: 2009,
      availability: "unknown" as const,
      sources: [],
    };
    const search = vi.fn().mockResolvedValue([
      {
        ref: { providerId: "webshare", candidateId: "upgrade" },
        releaseName: "Upgrade.2009.mkv",
        sizeBytes: 100,
        seasonNumber: null,
        episodeNumber: null,
        confidence: 0.8,
        provenance: { ...provenance, providerId: "webshare" },
      },
    ]);
    const checkPlayback = vi.fn().mockResolvedValue(undefined);
    const coordinator = new LiveContentCoordinator({
      agent: {} as AgentProvider,
      metadata: {} as MetadataProvider,
      media: { search, checkPlayback } as unknown as MediaProvider,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    await expect(coordinator.checkPlayback("default", title)).rejects.toThrow(
      "No playback candidate remains available",
    );
    expect(checkPlayback).not.toHaveBeenCalled();
  });

  it("fills an episode guide in the background while an already verified episode stays playable", async () => {
    const preview = new PreviewContentProvider()
      .bootstrapTitles()
      .find((item) => item.kind === "series")!;
    const title = {
      ...preview,
      id: "sai:tmdb:series:42",
      title: "Sample Show",
      originalTitle: "Original Sample Show",
      year: 2021,
    };
    const first = {
      ref: { providerId: "webshare", candidateId: "episode-1" },
      releaseName: "Sample.Show.2021.S01E01.mkv",
      sizeBytes: 100,
      seasonNumber: 1,
      episodeNumber: 1,
      confidence: 0.9,
      provenance: { ...provenance, providerId: "webshare" },
    };
    const second = {
      ...first,
      ref: { providerId: "webshare", candidateId: "episode-2" },
      releaseName: "Sample.Show.2021.S01E02.mkv",
      episodeNumber: 2,
    };
    let releaseSecond!: (value: (typeof second)[]) => void;
    const secondSearch = new Promise<(typeof second)[]>((resolve) => {
      releaseSecond = resolve;
    });
    const media = {
      search: vi
        .fn()
        .mockImplementation(async (request) =>
          request.episodeNumber === 1
            ? request.originalTitle === null
              ? [first]
              : []
            : request.episodeNumber === 2
              ? secondSearch
              : [],
        ),
      inspect: vi.fn().mockImplementation(async (ref) => ({
        ref,
        variantId: ref.candidateId,
      })),
      createPlayback: vi.fn().mockResolvedValue({ titleId: title.id }),
    } as unknown as MediaProvider;
    const metadata = {
      getSeriesStructure: vi.fn().mockResolvedValue({
        seriesRef: {
          providerId: "tmdb",
          entityType: "series",
          externalId: "42",
        },
        seasons: [
          {
            ref: { providerId: "tmdb", entityType: "season", externalId: "43" },
            seasonNumber: 1,
            title: "Season One",
            provenance,
            episodes: [1, 2].map((episodeNumber) => ({
              ref: {
                providerId: "tmdb",
                entityType: "episode",
                externalId: String(43 + episodeNumber),
              },
              episodeNumber,
              title: `Episode ${episodeNumber}`,
              synopsis: `Episode ${episodeNumber} description.`,
              airDate: "2021-01-01",
              runtimeMinutes: 42,
              provenance,
            })),
          },
        ],
        complete: true,
        provenance,
      }),
    } as unknown as MetadataProvider;
    const coordinator = new LiveContentCoordinator({
      agent: {} as AgentProvider,
      metadata,
      media,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    await coordinator.getSeriesDetail("default", title);
    await vi.waitFor(async () => {
      const detail = await coordinator.getSeriesDetail("default", title);
      expect(detail.seasons[0]?.episodes[0]?.availability).toBe("available");
      expect(detail.seasons[0]?.episodes[0]?.synopsis).toBe(
        "Episode 1 description.",
      );
      expect(detail.seasons[0]?.episodes[1]?.availability).toBe("searching");
    });
    expect(media.search).toHaveBeenCalledWith(
      expect.objectContaining({
        episodeNumber: 1,
        originalTitle: null,
        limit: 50,
      }),
      expect.anything(),
    );
    await coordinator.preparePlayback("default", title, {
      seasonNumber: 1,
      episodeNumber: 1,
    });
    expect(media.createPlayback).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: expect.objectContaining({ candidateId: "episode-1" }),
      }),
      expect.anything(),
    );
    releaseSecond([second]);
    await vi.waitFor(async () => {
      expect((await coordinator.getSeriesDetail("default", title)).status).toBe(
        "complete",
      );
    });
  });
  it("uses the agent only for proposals and groups deterministically validated titles", async () => {
    const dependencies = coordinatorDependencies();
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });

    const response = await coordinator.discover(
      {
        profileId: "default",
        sessionId: "session-1",
        message: "Find two films",
        idempotencyKey: "request-1",
      },
      NOW,
    );

    expect(response.mode).toBe("live");
    expect(response.bestMatch?.title.title).toBe("Canonical One");
    expect(response.bestMatch?.title.availability).toBe("available");
    expect(response.bestMatch?.title.matchPercent).toBe(95);
    expect(response.unavailable).toHaveLength(1);
    expect(response.unavailable[0]?.title.title).toBe("Canonical Two");
    expect(response.unavailable[0]?.title.metadataProvider).toBe("tmdb");
    expect(response.available).toHaveLength(0);
    expect(response.reply).toContain("I tuned the mood to your request.");
    expect(response.reply).toContain("Is this what you had in mind?");
  });

  it("passes prior validated suggestions and user objections back to the agent", async () => {
    const dependencies = coordinatorDependencies();
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });

    await coordinator.discover(
      {
        profileId: "default",
        sessionId: "conversation-one",
        message: "Less spooky, please",
        idempotencyKey: "request-feedback",
      },
      NOW,
      {
        sessionId: "conversation-one",
        messages: [
          {
            role: "user",
            content: { message: "An autumn mystery" },
            createdAt: NOW,
          },
          {
            role: "assistant",
            content: { reply: "Try Canonical One.", titles: ["Canonical One"] },
            createdAt: NOW,
          },
          {
            role: "assistant",
            content: {
              reply: "Quick API suggestions are ready.",
              titles: ["Pan Tau"],
              stage: "quick",
            },
            createdAt: NOW,
          },
          {
            role: "user",
            content: { message: "Less spooky, please" },
            createdAt: NOW,
          },
        ],
      },
    );
    const input = dependencies.generateStructured.mock.calls[0]?.[0];
    expect(input.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Less spooky, please",
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining(
            "Previously suggested: Canonical One",
          ),
        }),
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining(
            "Deterministic metadata search found these title candidates: Pan Tau",
          ),
        }),
      ]),
    );
    expect(input.messages[0]?.content).toContain(
      "A quick-search note, if present, lists deterministic metadata title candidates",
    );
  });

  it("returns needs-setup without invoking the model when a provider is disconnected", async () => {
    const dependencies = coordinatorDependencies();
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: new NonPersistentMemoryIntegrationStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });

    const response = await coordinator.discover(
      {
        profileId: "default",
        sessionId: "session-2",
        message: "Find a film",
        idempotencyKey: "request-2",
      },
      NOW,
    );

    expect(response.stage).toBe("needs-setup");
    expect(response.bestMatch).toBeNull();
    expect(dependencies.generateStructured).not.toHaveBeenCalled();
  });

  it("tries the next verified media mirror when playback creation fails", async () => {
    const dependencies = coordinatorDependencies();
    const first = {
      ref: { providerId: "webshare", candidateId: "file-broken" },
      releaseName: "Canonical.One.2001.1080p.mkv",
      sizeBytes: 10,
      seasonNumber: null,
      episodeNumber: null,
      confidence: 0.8,
      provenance: { ...provenance, providerId: "webshare" },
    };
    const second = {
      ...first,
      ref: { providerId: "webshare", candidateId: "file-working" },
      releaseName: "Canonical.One.2001.720p.mkv",
    };
    const duplicate = {
      ...second,
      ref: { providerId: "webshare", candidateId: "file-duplicate" },
    };
    vi.mocked(dependencies.media.search).mockImplementation(async (request) =>
      request.title.includes("One") ? [first, second, duplicate] : [],
    );
    vi.mocked(dependencies.media.inspect).mockImplementation(async (ref) => ({
      ref,
      variantId: ref.candidateId,
      format: {
        label: "1080p · H.264",
        container: "mkv",
        resolution: "1080p",
        videoCodec: "H.264",
        audioLanguages: ["en"],
        subtitleLanguages: [],
      },
      directPlay: true,
      supportsHttpRange: true,
      embeddedSubtitles: [],
      provenance: { ...provenance, providerId: "webshare" },
      expiresAt: null,
    }));
    const createPlayback = vi
      .fn()
      .mockRejectedValueOnce(new Error("mirror unavailable"))
      .mockResolvedValue({
        grantId: "grant-working",
        titleId: "sai:tmdb:movie:1",
        providerId: "webshare",
        variantId: "file-working",
        url: "/api/v1/playback/grants/grant-working",
        supportsHttpRange: true,
        expiresAt: "2026-09-29T20:01:00.000Z",
        embeddedSubtitles: [],
      });
    dependencies.media.createPlayback = createPlayback;
    const coordinator = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const response = await coordinator.discover(
      {
        profileId: "default",
        sessionId: "session-mirrors",
        message: "Find two films",
        idempotencyKey: "request-mirrors",
      },
      NOW,
    );

    const grant = await coordinator.preparePlayback(
      "default",
      response.bestMatch!.title,
    );

    const title = response.bestMatch!.title;
    expect(title.sources).toHaveLength(2);
    expect(title.sources?.map((source) => source.candidateId)).toEqual([
      "file-broken",
      "file-working",
    ]);
    expect(createPlayback).toHaveBeenCalledTimes(2);
    expect(grant.variantId).toBe("file-working");

    const selected = await coordinator.preparePlayback(
      "default",
      title,
      undefined,
      title.sources![1]!.id,
    );
    expect(selected.variantId).toBe("file-working");
    expect(createPlayback).toHaveBeenCalledTimes(3);
    expect(createPlayback.mock.calls[2]?.[0].variant.candidateId).toBe(
      "file-working",
    );
    await expect(
      coordinator.preparePlayback("default", title, undefined, "f".repeat(32)),
    ).rejects.toThrow("not part of this title");
    createPlayback.mockRejectedValueOnce(new Error("selected file went away"));
    await expect(
      coordinator.preparePlayback(
        "default",
        title,
        undefined,
        title.sources![0]!.id,
      ),
    ).rejects.toThrow("selected file went away");
    expect(createPlayback).toHaveBeenCalledTimes(4);
    expect(createPlayback.mock.calls[3]?.[0].variant.candidateId).toBe(
      "file-broken",
    );

    const restarted = new LiveContentCoordinator({
      ...dependencies,
      integrationStateStore: await connectedStateStore(),
      inference: {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      },
      localeForProfile: () => "en",
      now: () => new Date(NOW),
    });
    const searchCount = vi.mocked(dependencies.media.search).mock.calls.length;
    await restarted.preparePlayback(
      "default",
      title,
      undefined,
      title.sources![1]!.id,
    );
    expect(vi.mocked(dependencies.media.search).mock.calls).toHaveLength(
      searchCount,
    );
    expect(createPlayback.mock.calls[4]?.[0].variant.candidateId).toBe(
      "file-working",
    );
  });
});
