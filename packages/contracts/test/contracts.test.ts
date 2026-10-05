import { describe, expect, it } from "vitest";

import {
  CompleteSetupRequestSchema,
  DEFAULT_PLAYBACK_PREFERENCES,
  CatalogTitleSchema,
  DiscoveryResponseSchema,
  HealthResponseSchema,
  INTEGRATION_DESCRIPTORS,
  IntegrationConnectionResultSchema,
  IntegrationPublicStatusSchema,
  PlaybackPreferencesSchema,
  subtitleWindowStart,
  SUPPORTED_LOCALES,
  TmdbConnectRequestSchema,
} from "../src/index.js";

describe("public contracts", () => {
  it("ships complete localized integration descriptors", () => {
    for (const descriptor of Object.values(INTEGRATION_DESCRIPTORS)) {
      for (const locale of SUPPORTED_LOCALES) {
        expect(descriptor.name[locale]).not.toHaveLength(0);
        expect(descriptor.description[locale]).not.toHaveLength(0);
      }
    }
  });

  it("rejects secret-bearing public status objects", () => {
    expect(() =>
      IntegrationPublicStatusSchema.parse({
        id: "tmdb",
        enabled: true,
        setupStatus: "ready",
        healthStatus: "healthy",
        credentialStatus: "stored",
        healthCode: null,
        lastCheckedAt: "2026-09-27T10:00:00.000Z",
        updatedAt: "2026-09-27T10:00:00.000Z",
        secretRef: "vault://tmdb/token",
      }),
    ).toThrow();
  });

  it("keeps health responses versioned and strict", () => {
    expect(() =>
      HealthResponseSchema.parse({
        schemaVersion: 1,
        status: "healthy",
        timestamp: "2026-09-27T10:00:00.000Z",
        uptimeSeconds: 2,
        checks: {
          database: {
            status: "healthy",
            code: null,
            checkedAt: "2026-09-27T10:00:00.000Z",
            latencyMs: 1,
          },
          integrations: [],
        },
        token: "must not be accepted",
      }),
    ).toThrow();
  });

  it("keeps TMDB credentials inbound-only", () => {
    expect(
      TmdbConnectRequestSchema.parse({ token: `  ${"t".repeat(24)}  ` }),
    ).toEqual({
      token: "t".repeat(24),
    });
    expect(() =>
      IntegrationConnectionResultSchema.parse({
        ok: true,
        integrationId: "tmdb",
        status: "connected",
        messageCode: "CONNECTED",
        persistence: "secure-local",
        token: "must-never-be-returned",
      }),
    ).toThrow();
    expect(() =>
      IntegrationConnectionResultSchema.parse({
        ok: false,
        integrationId: "tmdb",
        status: "unavailable",
        messageCode: "PROVIDER_UNAVAILABLE",
        secretRef: "must-never-be-returned",
      }),
    ).toThrow();
  });

  it("validates the complete guided-setup payload", () => {
    expect(
      CompleteSetupRequestSchema.parse({
        profile: { name: "  Family  ", locale: "cs", preferences: ["Comedy"] },
        localAiEnabled: true,
      }),
    ).toEqual({
      profile: {
        name: "Family",
        locale: "cs",
        preferences: ["Comedy"],
        playback: DEFAULT_PLAYBACK_PREFERENCES,
      },
      localAiEnabled: true,
    });
  });

  it("upgrades stored playback preferences with output and subtitle styling defaults", () => {
    expect(
      PlaybackPreferencesSchema.parse({
        primaryAudioLanguage: "cs",
        secondaryAudioLanguage: "en",
        autoFindSubtitles: false,
        primaryAudioSubtitleLanguage: "off",
        secondaryAudioSubtitleLanguage: "cs",
      }),
    ).toEqual(DEFAULT_PLAYBACK_PREFERENCES);
    expect(() =>
      PlaybackPreferencesSchema.parse({
        ...DEFAULT_PLAYBACK_PREFERENCES,
        subtitleSizePercent: 500,
      }),
    ).toThrow();
  });

  it("selects a bounded subtitle window for the current playback position", () => {
    expect(subtitleWindowStart(0)).toBe(0);
    expect(subtitleWindowStart(62.5)).toBe(60);
    expect(subtitleWindowStart(155)).toBe(150);
    expect(subtitleWindowStart(Number.NaN)).toBe(0);
  });

  it("requires a verified format before a title can be called available", () => {
    expect(() =>
      CatalogTitleSchema.parse({
        id: "title-1",
        kind: "movie",
        title: "Example",
        originalTitle: null,
        year: 2026,
        synopsis: "Example synopsis",
        posterUrl: null,
        backdropUrl: null,
        accentColor: "#112233",
        genres: [],
        ratings: [],
        matchPercent: null,
        availability: "available",
        availabilityProvider: "media-test",
        availabilityCheckedAt: "2026-09-27T10:00:00.000Z",
        formats: [],
        seriesCoverage: null,
        metadataProvider: "metadata-test",
        metadataValidatedAt: "2026-09-27T10:00:00.000Z",
        inLibrary: false,
        progressPercent: null,
      }),
    ).toThrow(/verified format/);
  });

  it("keeps selectable files title-scoped and rejects duplicate or mismatched sources", () => {
    const format = {
      label: "1080p",
      container: "mkv",
      resolution: "1080p",
      videoCodec: "H.264",
      audioLanguages: ["en"],
      subtitleLanguages: [],
    };
    const source = {
      id: "a".repeat(32),
      providerId: "webshare",
      candidateId: "file-1",
      releaseName: "Example.1080p.mkv",
      sizeBytes: 100,
      format,
      seasonNumber: null,
      episodeNumber: null,
      checkedAt: "2026-09-27T10:00:00.000Z",
    };
    const title = {
      id: "title-1",
      kind: "movie",
      title: "Example",
      originalTitle: null,
      year: 2026,
      synopsis: "Example synopsis",
      posterUrl: null,
      backdropUrl: null,
      accentColor: "#112233",
      genres: [],
      ratings: [],
      matchPercent: null,
      availability: "available",
      availabilityProvider: "webshare",
      availabilityCheckedAt: "2026-09-27T10:00:00.000Z",
      formats: [format],
      sources: [source],
      seriesCoverage: null,
      metadataProvider: "tmdb",
      metadataValidatedAt: "2026-09-27T10:00:00.000Z",
      inLibrary: false,
      progressPercent: null,
    };
    expect(CatalogTitleSchema.parse(title).sources).toEqual([source]);
    expect(
      CatalogTitleSchema.safeParse({ ...title, sources: undefined }).success,
    ).toBe(true);
    expect(
      CatalogTitleSchema.safeParse({ ...title, sources: [source, source] })
        .success,
    ).toBe(false);
    expect(
      CatalogTitleSchema.safeParse({
        ...title,
        sources: [{ ...source, seasonNumber: 1, episodeNumber: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CatalogTitleSchema.safeParse({
        ...title,
        sources: [{ ...source, url: "https://example.invalid/video" }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate discovery titles and an unavailable best match", () => {
    const unavailable = {
      id: "title-1",
      kind: "movie" as const,
      title: "Example",
      originalTitle: null,
      year: 2026,
      synopsis: "Example synopsis",
      posterUrl: null,
      backdropUrl: null,
      accentColor: "#112233",
      genres: [],
      ratings: [],
      matchPercent: 90,
      availability: "unavailable" as const,
      availabilityProvider: "media-test",
      availabilityCheckedAt: "2026-09-27T10:00:00.000Z",
      formats: [],
      seriesCoverage: null,
      metadataProvider: "metadata-test",
      metadataValidatedAt: "2026-09-27T10:00:00.000Z",
      inLibrary: false,
      progressPercent: null,
    };
    expect(() =>
      DiscoveryResponseSchema.parse({
        sessionId: "session-1",
        stage: "completed",
        reply: "Result",
        bestMatch: { title: unavailable, reason: "Reason" },
        available: [],
        unavailable: [{ title: unavailable, reason: "Reason" }],
        warnings: [],
        completedAt: "2026-09-27T10:00:00.000Z",
      }),
    ).toThrow();
  });
});
