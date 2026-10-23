import type {
  AgentGenerationRequest,
  CanonicalTitlePayload,
  MediaProvider,
  MetadataProvider,
  ProviderContext,
} from "@streamer-ai/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  OllamaAgentProvider,
  type OllamaFetch,
} from "../src/integrations/ollama-agent-provider.js";
import { LiveContentCoordinator } from "../src/services/live-content-coordinator.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

// Opt-in quality evaluation against an installed model. Catalog and playback
// fixtures stay in memory; no app credentials or external providers are used.
const enabled = process.env.STREAMERAI_RUN_OLLAMA_EVAL === "1";
const reasoningEffort =
  process.env.STREAMERAI_OLLAMA_EVAL_REASONING === "high" ? "high" : "none";
const NOW = "2026-10-23T12:00:00.000Z";
const provenance = {
  providerId: "tmdb",
  retrievedAt: NOW,
  connectorVersion: "evaluation",
  confidence: 1,
  validationState: "verified" as const,
  expiresAt: null,
};

interface QualityFixture {
  id: string;
  title: string;
  year: number;
  genres: string[];
  synopsis: string;
  kind?: "movie" | "series";
}

const FIXTURES: QualityFixture[] = [
  {
    id: "1",
    title: "Spider-Man: Brand New Day",
    year: 2026,
    genres: ["Science fiction", "Action"],
    synopsis:
      "A superhero fights street-level crime and villains in New York City. His story is set on Earth in an urban neighborhood.",
  },
  {
    id: "2",
    title: "Interstellar",
    year: 2014,
    genres: ["Science fiction", "Drama"],
    synopsis:
      "Astronauts pilot a spaceship through a wormhole to explore distant planets and find a future home for humanity.",
  },
  {
    id: "3",
    title: "Gravity",
    year: 2013,
    genres: ["Science fiction", "Thriller"],
    synopsis:
      "Astronauts stranded in Earth orbit travel between damaged space stations and spacecraft, trying to survive and return home.",
  },
];

const HAIL_MARY = {
  id: "4",
  title: "Project Hail Mary",
  year: 2026,
  genres: ["Science fiction"],
  synopsis:
    "A scientist wakes on a spaceship light years from Earth and must solve a problem threatening humanity.",
};

const EXPANSION_FIXTURES: QualityFixture[] = [
  {
    id: "5",
    title: "2001: A Space Odyssey",
    year: 1968,
    genres: ["Science fiction"],
    synopsis: "A spacecraft crew travels to Jupiter with an onboard computer.",
  },
  {
    id: "6",
    title: "The Expanse",
    kind: "series",
    year: 2015,
    genres: ["Science fiction"],
    synopsis:
      "Spacecraft crews navigate conflict between Earth, Mars and settlements in the asteroid belt.",
  },
  {
    id: "7",
    title: "Star Wars Rebels",
    kind: "series",
    year: 2014,
    genres: ["Science fiction"],
    synopsis:
      "A rebel spaceship crew travels between planets and fights an empire.",
  },
];

function normalizedTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const CASES = [
  {
    name: "reported English request with spaceships",
    locale: "en" as const,
    message: "some scify from space with spaceships",
  },
  {
    name: "reported English request about space",
    locale: "en" as const,
    message: "some scify from space",
  },
  {
    name: "Czech request about space and spaceships",
    locale: "cs" as const,
    message: "Nějaké sci-fi z vesmíru s vesmírnými loděmi",
  },
  {
    name: "German request about space and spaceships",
    locale: "de" as const,
    message: "Etwas Science-Fiction im Weltraum mit Raumschiffen",
  },
  {
    name: "expands beyond Hail Mary when playback cannot be confirmed",
    locale: "en" as const,
    message: "some scify from space with spaceships",
    expansion: true,
  },
];

function canonicalTitle(
  fixture: (typeof FIXTURES)[number],
): CanonicalTitlePayload {
  return {
    ref: {
      providerId: "tmdb",
      externalId: fixture.id,
      entityType: fixture.kind ?? "movie",
    },
    kind: fixture.kind ?? "movie",
    title: fixture.title,
    originalTitle: fixture.title,
    localizedTitles: [],
    year: fixture.year,
    synopsis: fixture.synopsis,
    genres: fixture.genres,
    posterUrl: null,
    backdropUrl: null,
    fieldProvenance: Object.fromEntries(
      [
        "title",
        "originalTitle",
        "year",
        "synopsis",
        "genres",
        "posterUrl",
        "backdropUrl",
      ].map((field) => [field, provenance]),
    ),
  };
}

describe.runIf(enabled)("Ollama grounded discovery quality", () => {
  it.each(CASES)(
    "$name",
    async (scenario) => {
      const { locale, message } = scenario;
      const expansion = "expansion" in scenario && scenario.expansion;
      const catalog = expansion
        ? [...FIXTURES, HAIL_MARY, ...EXPANSION_FIXTURES]
        : FIXTURES;
      const hints = (fixtures: typeof FIXTURES) =>
        fixtures.map((fixture) => ({
          ref: {
            providerId: "tmdb",
            externalId: fixture.id,
            entityType: fixture.kind ?? "movie",
          },
          kind: fixture.kind ?? "movie",
          title: fixture.title,
          originalTitle: fixture.title,
          year: fixture.year,
          confidence: 1,
          provenance,
        }));
      const inference = {
        provider: "ollama" as const,
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen3.5:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 512,
        timeoutMs: 60_000,
      };
      let chatCalls = 0;
      const events: Array<Record<string, unknown>> = [];
      const boundedFetch: OllamaFetch = async (input, init) => {
        if (input.endsWith("/api/chat")) {
          if (
            ++chatCalls >
            (expansion ? 2 : 1) * (reasoningEffort === "high" ? 2 : 1)
          )
            throw new Error(
              "Exceeded the scenario's bounded model-call budget.",
            );
        }
        return fetch(input, init);
      };
      const agent = new OllamaAgentProvider({
        config: inference,
        fetch: boundedFetch,
        now: () => new Date(NOW),
        diagnostic: (event) => events.push(event),
      });
      const generateStructured = agent.generateStructured.bind(agent);
      const generation = vi
        .spyOn(agent, "generateStructured")
        .mockImplementation(
          <TOutput>(
            request: AgentGenerationRequest,
            context: ProviderContext,
          ) => generateStructured<TOutput>(request, context, reasoningEffort),
        );
      const metadata = {
        descriptor: () => ({ id: "tmdb", connectorVersion: "evaluation" }),
        discover: vi
          .fn()
          .mockImplementation(async (request) =>
            request.kind === "movie"
              ? hints(expansion ? [HAIL_MARY] : FIXTURES)
              : [],
          ),
        search: vi.fn(async (query) => {
          if (!expansion) throw new Error("Unexpected title fallback.");
          return hints(
            catalog.filter(
              (fixture) =>
                normalizedTitle(fixture.title) ===
                  normalizedTitle(query.query) &&
                query.kind === (fixture.kind ?? "movie"),
            ),
          );
        }),
        getTitle: vi.fn().mockImplementation(async (ref) => {
          const fixture = catalog.find((item) => item.id === ref.externalId);
          if (!fixture) throw new Error("Unknown fixture title.");
          return canonicalTitle(fixture);
        }),
        getRatings: vi.fn().mockResolvedValue([]),
        getSeriesStructure: vi.fn(async (ref) => ({
          seriesRef: ref,
          complete: false,
          seasons: [
            {
              ref: {
                ...ref,
                entityType: "season",
                externalId: `${ref.externalId}-s1`,
              },
              seasonNumber: 1,
              title: "Season 1",
              provenance,
              episodes: [
                {
                  ref: {
                    ...ref,
                    entityType: "episode",
                    externalId: `${ref.externalId}-e1`,
                  },
                  episodeNumber: 1,
                  title: "Pilot",
                  airDate: null,
                  runtimeMinutes: 45,
                  provenance,
                },
              ],
            },
          ],
        })),
      } as unknown as MetadataProvider;
      const media = {
        descriptor: () => ({ id: "webshare", connectorVersion: "evaluation" }),
        search: vi.fn().mockImplementation(async (request) =>
          request.titleId === "sai:tmdb:movie:4"
            ? Array.from({ length: 20 }, (_, index) => ({
                ref: { providerId: "webshare", candidateId: `wrong-${index}` },
                releaseName: `Unrelated.Title.${index}.mkv`,
                sizeBytes: 10,
                seasonNumber: null,
                episodeNumber: null,
                confidence: 1,
                provenance: { ...provenance, providerId: "webshare" },
              }))
            : [
                {
                  ref: { providerId: "webshare", candidateId: request.titleId },
                  releaseName:
                    request.kind === "series"
                      ? `${request.title}.S01E01.1080p.mkv`
                      : `${request.title}.${request.year}.1080p.mkv`,
                  sizeBytes: 10,
                  seasonNumber: request.kind === "series" ? 1 : null,
                  episodeNumber: request.kind === "series" ? 1 : null,
                  confidence: 1,
                  provenance: { ...provenance, providerId: "webshare" },
                },
              ],
        ),
        inspect: vi.fn().mockImplementation(async (ref) => ({
          ref,
          variantId: ref.candidateId,
          format: {
            label: "1080p H.264",
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
      const integrationStateStore =
        new NonPersistentMemoryIntegrationStateStore();
      for (const integrationId of ["tmdb", "webshare", "ollama"])
        await integrationStateStore.set({
          integrationId,
          status: "connected",
          configured: true,
          checkedAt: NOW,
          updatedAt: NOW,
        });
      const coordinator = new LiveContentCoordinator({
        agent,
        metadata,
        media,
        integrationStateStore,
        inference,
        localeForProfile: () => locale,
        now: () => new Date(NOW),
        diagnostic: (event) => events.push(event),
        discoveryBudgetMsForProfile: () =>
          reasoningEffort === "high" ? 110_000 : 55_000,
      });

      const response = await coordinator.discover(
        {
          profileId: "default",
          sessionId: `ollama-eval-${locale}`,
          idempotencyKey: `ollama-eval-${locale}`,
          message,
        },
        NOW,
      );

      expect(generation).toHaveBeenCalledTimes(expansion ? 2 : 1);
      const repairs = events.filter(
        (event) => event.code === "DISCOVERY_AGENT_REPAIR_STARTED",
      ).length;
      expect(chatCalls).toBe((expansion ? 2 : 1) + repairs);
      expect(
        events
          .filter(
            (event) =>
              event.code === "DISCOVERY_AGENT_OPTIONS" &&
              event.phase === "initial",
          )
          .every((event) => event.think === (reasoningEffort === "high")),
      ).toBe(true);
      expect(response.stage).toBe("completed");
      if (expansion) {
        const diagnostics = JSON.stringify(
          events.filter((event) =>
            [
              "DISCOVERY_PROPOSALS",
              "DISCOVERY_AGENT_RESPONSE",
              "DISCOVERY_AGENT_REPAIR_STARTED",
              "DISCOVERY_EXPANSION_FAILED",
              "DISCOVERY_COMPLETED",
            ].includes(String(event.code)),
          ),
        );
        expect(
          [
            "Interstellar",
            "Gravity",
            ...EXPANSION_FIXTURES.map((fixture) => fixture.title),
          ],
          diagnostics,
        ).toContain(response.bestMatch?.title.originalTitle);
        expect(
          response.unverified.map((item) => item.title.originalTitle),
        ).toContain("Project Hail Mary");
      } else
        expect(response.bestMatch?.title.originalTitle).toBe("Interstellar");
      const presented = [
        response.bestMatch,
        ...response.available,
        ...response.unavailable,
        ...response.unverified,
      ].filter((item) => item !== null);
      expect(presented.length).toBeGreaterThan(0);
      expect(
        presented.every((item) =>
          [
            "Interstellar",
            "Gravity",
            ...(expansion
              ? [
                  "Project Hail Mary",
                  ...EXPANSION_FIXTURES.map((fixture) => fixture.title),
                ]
              : []),
          ].includes(item.title.originalTitle ?? ""),
        ),
      ).toBe(true);
      expect(
        vi
          .mocked(media.search)
          .mock.calls.every(
            ([request]) => request.title !== FIXTURES[0]!.title,
          ),
      ).toBe(true);
      if (expansion) expect(metadata.search).toHaveBeenCalled();
      else expect(metadata.search).not.toHaveBeenCalled();
    },
    125_000,
  );
});
