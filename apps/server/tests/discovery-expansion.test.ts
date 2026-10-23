import type {
  AgentProvider,
  CanonicalTitlePayload,
  MediaProvider,
  MetadataProvider,
} from "@streamer-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import { LiveContentCoordinator } from "../src/services/live-content-coordinator.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

const NOW = "2026-10-23T21:01:59.000Z";
const provenance = {
  providerId: "tmdb",
  retrievedAt: NOW,
  connectorVersion: "test",
  confidence: 1,
  validationState: "verified" as const,
  expiresAt: null,
};
const request = {
  profileId: "default",
  sessionId: "space-expansion",
  message: "some scify from space with spaceships",
  idempotencyKey: "space-expansion-request",
};

async function harness(
  initialState: "unknown" | "unavailable" | "available" | "partial" = "unknown",
  budgetMs = 55_000,
) {
  let time = Date.parse(NOW);
  const series = initialState === "partial";
  const titleFor = (id: string) =>
    id === "1" ? "Project Hail Mary" : "Interstellar";
  const kind = series ? ("series" as const) : ("movie" as const);
  const refFor = (id: string) => ({
    providerId: "tmdb",
    entityType: kind,
    externalId: id,
  });
  const payload = (id: string): CanonicalTitlePayload => ({
    ref: refFor(id),
    kind,
    title: titleFor(id),
    originalTitle: titleFor(id),
    localizedTitles: [],
    year: 2026,
    synopsis: "Astronauts travel in spaceships to distant planets.",
    genres: ["Science fiction"],
    posterUrl: null,
    backdropUrl: null,
    fieldProvenance: {
      title: provenance,
      synopsis: provenance,
      genres: provenance,
    },
  });
  const hint = (id: string, title = titleFor(id)) => ({
    ref: refFor(id),
    kind,
    title,
    originalTitle: title,
    year: 2026,
    confidence: 1,
    provenance,
  });
  const proposals = [
    {
      title: "Interstellar",
      kind,
      year: 2026,
      reason: "Space travel aboard a spaceship.",
      matchPercent: 90,
    },
  ];
  const generateStructured = vi
    .fn()
    .mockResolvedValueOnce({
      output: { orderedIds: [`sai:tmdb:${kind}:1`] },
      model: "qwen3.5:4b",
      finishReason: "completed",
    })
    .mockResolvedValue({
      output: { people: [], candidates: proposals },
      model: "qwen3.5:4b",
      finishReason: "completed",
    });
  const metadata = {
    discover: vi.fn(async (query) => (query.kind === kind ? [hint("1")] : [])),
    search: vi.fn(async (query) => [
      hint(query.query === "Interstellar" ? "2" : "1", query.query),
    ]),
    getTitle: vi.fn(async (ref) => payload(ref.externalId)),
    getRatings: vi.fn(async () => []),
    getSeriesStructure: vi.fn(async (ref) => ({
      seriesRef: ref,
      complete: true,
      seasons: [
        {
          ref: { ...ref, entityType: "season" },
          seasonNumber: 1,
          title: "Season 1",
          provenance,
          episodes: [1, 2].map((episodeNumber) => ({
            ref: {
              ...ref,
              entityType: "episode",
              externalId: `${ref.externalId}-${episodeNumber}`,
            },
            episodeNumber,
            title: `Episode ${episodeNumber}`,
            airDate: null,
            runtimeMinutes: 45,
            provenance,
          })),
        },
      ],
    })),
  } as unknown as MetadataProvider;
  const file = (id: string, episode = 1) => ({
    ref: { providerId: "webshare", candidateId: `${id}-${episode}` },
    releaseName: series
      ? `${titleFor(id)}.S01E0${episode}.mkv`
      : `${titleFor(id)}.2026.mkv`,
    sizeBytes: 100,
    seasonNumber: series ? 1 : null,
    episodeNumber: series ? episode : null,
    confidence: 1,
    provenance: { ...provenance, providerId: "webshare" },
  });
  const media = {
    descriptor: () => ({ id: "webshare", connectorVersion: "test" }),
    search: vi.fn(async (query) => {
      const id = query.titleId.endsWith(":1") ? "1" : "2";
      if (id === "1" && initialState === "unknown")
        return Array.from({ length: 20 }, (_, i) => ({
          ...file("1"),
          ref: { providerId: "webshare", candidateId: `irrelevant-${i}` },
          releaseName: `Unrelated.Title.${i}.mkv`,
        }));
      if (id === "1" && initialState === "unavailable") return [];
      return series && id === "2" ? [file(id, 1), file(id, 2)] : [file(id)];
    }),
    inspect: vi.fn(async (ref) => ({
      ref,
      variantId: ref.candidateId,
      format: {
        label: "1080p",
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
    })),
  } as unknown as MediaProvider;
  const integrationStateStore = new NonPersistentMemoryIntegrationStateStore();
  for (const integrationId of ["tmdb", "webshare", "ollama"])
    await integrationStateStore.set({
      integrationId,
      status: "connected",
      configured: true,
      checkedAt: NOW,
      updatedAt: NOW,
    });
  const events: Array<Record<string, unknown>> = [];
  const coordinator = new LiveContentCoordinator({
    agent: { generateStructured } as unknown as AgentProvider,
    metadata,
    media,
    integrationStateStore,
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
    now: () => new Date(time),
    diagnostic: (event) => events.push(event),
    discoveryBudgetMsForProfile: () => budgetMs,
  });
  return {
    coordinator,
    metadata,
    media,
    generateStructured,
    events,
    proposals,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("discovery expansion and diagnostics", () => {
  it.each(["unknown", "unavailable"] as const)(
    "finds a playable alternative when the only genre selection is %s",
    async (state) => {
      const h = await harness(state);
      const result = await h.coordinator.discover(request, NOW);
      expect(result.bestMatch?.title.title).toBe("Interstellar");
      expect(result.bestMatch?.title.availability).toBe("available");
      const retained =
        state === "unknown" ? result.unverified : result.unavailable;
      expect(retained.map((item) => item.title.title)).toEqual([
        "Project Hail Mary",
      ]);
      expect(h.generateStructured).toHaveBeenCalledTimes(2);
      expect(h.generateStructured.mock.calls[1]![0].messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining("Playback is not confirmed"),
          }),
          { role: "user", content: request.message },
        ]),
      );
    },
  );

  it("keeps the incomplete series and seeks a complete playable alternative", async () => {
    const h = await harness("partial");
    const result = await h.coordinator.discover(
      { ...request, message: "A complete sci-fi series with spaceships" },
      NOW,
    );
    expect(result.bestMatch?.title.title).toBe("Interstellar");
    expect(result.bestMatch?.title.seriesCoverage?.complete).toBe(true);
    expect(result.available[0]?.title.title).toBe("Project Hail Mary");
    expect(result.available[0]?.title.availability).toBe("partial");
    expect(h.generateStructured).toHaveBeenCalledTimes(2);
    expect(h.generateStructured.mock.calls[1]![0]).toMatchObject({
      outputSchemaName: "streamer_ai_discovery_expansion",
      maxOutputTokens: 256,
      outputJsonSchema: {
        properties: { candidates: { items: { required: ["title", "kind"] } } },
      },
    });
  });

  it("returns an already playable match without an extra model call", async () => {
    const h = await harness("available");
    const result = await h.coordinator.discover(request, NOW);
    expect(result.bestMatch?.title.title).toBe("Project Hail Mary");
    expect(h.generateStructured).toHaveBeenCalledTimes(1);
    expect(
      h.events.some((event) => event.code === "DISCOVERY_EXPANSION_STARTED"),
    ).toBe(false);
  });

  it("does not recheck a matching title or an alias proposed during expansion", async () => {
    const h = await harness();
    h.proposals.unshift(
      {
        title: "Project Hail Mary",
        kind: "movie",
        year: 2026,
        reason: "Already checked.",
        matchPercent: 99,
      },
      {
        title: "Alternate Hail Mary title",
        kind: "movie",
        year: 2026,
        reason: "Alias already checked.",
        matchPercent: 98,
      },
    );
    const result = await h.coordinator.discover(request, NOW);
    expect(result.bestMatch?.title.title).toBe("Interstellar");
    expect(result.unverified).toHaveLength(1);
    expect(
      vi
        .mocked(h.media.search)
        .mock.calls.filter(([query]) => query.titleId === "sai:tmdb:movie:1"),
    ).toHaveLength(2);
    expect(h.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("retains the first result if expansion fails and never logs provider exception text", async () => {
    const h = await harness();
    h.generateStructured
      .mockReset()
      .mockResolvedValueOnce({ output: { orderedIds: ["sai:tmdb:movie:1"] } })
      .mockRejectedValueOnce(new Error("private-provider-token-and-url"));
    const result = await h.coordinator.discover(request, NOW);
    expect(result.bestMatch).toBeNull();
    expect(result.unverified[0]?.title.title).toBe("Project Hail Mary");
    expect(result.warnings).toContain(
      "Additional recommendations could not be checked.",
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_EXPANSION_FAILED",
        failure: { type: "Error" },
      }),
    );
    expect(JSON.stringify(h.events)).not.toContain(
      "private-provider-token-and-url",
    );
  });

  it("stops after one expansion when no new title is playable", async () => {
    const h = await harness();
    vi.mocked(h.media.search).mockResolvedValue([]);
    const result = await h.coordinator.discover(request, NOW);
    expect(result.bestMatch).toBeNull();
    expect(result.unavailable.map((item) => item.title.title)).toEqual([
      "Project Hail Mary",
      "Interstellar",
    ]);
    expect(h.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("preserves the result when the original deadline leaves no expansion budget", async () => {
    const h = await harness();
    h.generateStructured.mockReset().mockImplementationOnce(async () => {
      h.advance(57_000);
      return { output: { orderedIds: ["sai:tmdb:movie:1"] } };
    });
    const result = await h.coordinator.discover(request, NOW);
    expect(result.unverified).toHaveLength(1);
    expect(h.generateStructured).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_EXPANSION_SKIPPED",
        reason: "deadline",
      }),
    );
  });

  it("shares one bounded quality deadline between the slow selection and expansion", async () => {
    const h = await harness("unknown", 110_000);
    h.generateStructured
      .mockReset()
      .mockImplementationOnce(async () => {
        h.advance(45_000);
        return { output: { orderedIds: ["sai:tmdb:movie:1"] } };
      })
      .mockImplementationOnce(async () => {
        h.advance(35_000);
        return { output: { people: [], candidates: h.proposals } };
      });
    const result = await h.coordinator.discover(request, NOW);
    expect(result.bestMatch?.title.title).toBe("Interstellar");
    expect(h.generateStructured).toHaveBeenCalledTimes(2);
    const expectedDeadline = new Date(Date.parse(NOW) + 110_000).toISOString();
    expect(
      h.generateStructured.mock.calls.map(([, context]) => context.deadlineAt),
    ).toEqual([expectedDeadline, expectedDeadline]);
    expect(h.events).toContainEqual(
      expect.objectContaining({ code: "DISCOVERY_STARTED", budgetMs: 110_000 }),
    );
  });

  it("caps the overall discovery budget even when a caller requests an excessive one", async () => {
    const h = await harness("available", 999_999);
    await h.coordinator.discover(request, NOW);
    expect(h.events).toContainEqual(
      expect.objectContaining({ code: "DISCOVERY_STARTED", budgetMs: 110_000 }),
    );
  });

  it("honors cancellation instead of returning retained results from a stopped expansion", async () => {
    const h = await harness();
    const controller = new AbortController();
    h.generateStructured
      .mockReset()
      .mockResolvedValueOnce({ output: { orderedIds: ["sai:tmdb:movie:1"] } })
      .mockImplementationOnce(async () => {
        controller.abort();
        throw new Error("stopped");
      });
    await expect(
      h.coordinator.discover(request, NOW, {
        sessionId: request.sessionId,
        messages: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.events).toContainEqual(
      expect.objectContaining({ code: "DISCOVERY_FAILED", cancelled: true }),
    );
  });

  it("correlates the shortlist, model selection, file filtering, unknown reason and final results", async () => {
    const h = await harness();
    await h.coordinator.discover(request, NOW);
    expect(
      h.events.every(
        (event) =>
          event.discoveryRequestId === request.idempotencyKey &&
          event.sessionId === request.sessionId &&
          event.profileId === request.profileId,
      ),
    ).toBe(true);
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_SELECTION_INPUT",
        candidates: expect.arrayContaining([
          expect.objectContaining({
            title: "Project Hail Mary",
            synopsis: expect.stringContaining("spaceships"),
          }),
        ]),
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_SELECTION_RESULT",
        outcome: "selected",
        orderedIds: ["sai:tmdb:movie:1"],
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_MEDIA_FILTER",
        matchingCount: 0,
        rejected: expect.arrayContaining([
          expect.objectContaining({ reason: "title-or-year-mismatch" }),
        ]),
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AVAILABILITY",
        titleId: "sai:tmdb:movie:1",
        availability: "unknown",
        reasons: expect.arrayContaining([
          "provider-result-limit",
          "no-admissible-files",
        ]),
      }),
    );
    expect(h.events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_COMPLETED",
        bestMatchId: "sai:tmdb:movie:2",
      }),
    );
    expect(JSON.stringify(h.events)).not.toContain("secretRef");
  });
});
