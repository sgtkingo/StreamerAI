import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogTitleSchema, type CatalogTitle } from "@streamer-ai/contracts";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { connectedTitleSources } from "../src/services/connected-title-sources.js";
import { StreamerCore } from "../src/services/streamer-core.js";
import {
  PreviewContentProvider,
  type StreamerContentProvider,
} from "../src/services/content-provider.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

const now = "2026-10-25T12:00:00.000Z";
function titleFixture(): CatalogTitle {
  const preview = new PreviewContentProvider()
    .bootstrapTitles()
    .find((title) => title.kind === "series")!;
  return CatalogTitleSchema.parse({
    ...preview,
    id: "sai:tmdb:series:31910",
    title: "Naruto Shippūden",
    availability: "available",
    availabilityProvider: "hellspy",
    availabilityCheckedAt: now,
    seriesCoverage: {
      seasonsAvailable: 1,
      seasonsTotal: 1,
      episodesAvailable: 2,
      episodesTotal: 2,
      complete: true,
      nextEpisodeLabel: "S01 E01",
    },
    sources: ["hellspy", "webshare"].map((providerId, index) => ({
      id: (index === 0 ? "a" : "b").repeat(32),
      providerId,
      candidateId: `episode-${index}`,
      releaseName: `Naruto.Shippuden.S01E0${index + 1}.mkv`,
      sizeBytes: 100,
      format: preview.formats[0],
      seasonNumber: 1,
      episodeNumber: index + 1,
      checkedAt: now,
    })),
  });
}
describe("connected source projections", () => {
  const databases: StreamerDatabase[] = [];
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("removes disconnected sources and recomputes series coverage without changing the canonical record", () => {
    const title = titleFixture();
    const projected = connectedTitleSources(
      title,
      (id) => id === "webshare",
      now,
    );
    expect(projected.sources?.map((source) => source.providerId)).toEqual([
      "webshare",
    ]);
    expect(projected).toMatchObject({
      availability: "partial",
      seriesCoverage: {
        complete: false,
        episodesAvailable: 1,
        nextEpisodeLabel: "S01 E02",
      },
    });
    expect(title.sources).toHaveLength(2);
    expect(title.seriesCoverage?.complete).toBe(true);
  });
  it("clears playable formats and coverage when all source accounts are disconnected", () => {
    expect(
      connectedTitleSources(titleFixture(), () => false, now),
    ).toMatchObject({
      sources: [],
      availability: "unknown",
      formats: [],
      seriesCoverage: null,
    });
  });
  it("filters detail, Home, Library and History for the current profile and restores sources on reconnect", async () => {
    const title = titleFixture();
    const preview = new PreviewContentProvider();
    const provider: StreamerContentProvider = {
      id: "test-live",
      mode: "live",
      bootstrapTitles: () => [title],
      buildHome: (input) => preview.buildHome(input),
      discover: vi.fn(),
    };
    const database = openStreamerDatabase({ filename: ":memory:" });
    databases.push(database);
    const states = new NonPersistentMemoryIntegrationStateStore();
    await states.set({
      integrationId: "webshare",
      configured: true,
      status: "connected",
      updatedAt: now,
    });
    const core = new StreamerCore(
      database,
      () => new Date(now),
      provider,
      (profileId, id) => states.isConfigured(id, profileId),
    );
    core.addToLibrary("default", title.id);
    const detail = await core.titleDetail("default", title.id);
    const otherProfile = core.createViewerProfile({
      name: "Other account",
      locale: "en",
    });
    expect(
      (await core.titleDetail(otherProfile.id, title.id)).title.sources,
    ).toEqual([]);
    expect(detail.title.sources?.map((source) => source.providerId)).toEqual([
      "webshare",
    ]);
    expect(core.library("default").items[0]?.title.sources).toHaveLength(1);
    database.history.append({
      id: "history-source-test",
      profileId: "default",
      titleId: title.id,
      eventType: "start",
      episodeLabel: "S01 E01",
      progressPercent: 5,
    });
    expect(
      core
        .history("default")
        .items[0]?.title.sources?.map((source) => source.providerId),
    ).toEqual(["webshare"]);
    const homeSources = core
      .home("default")
      .sections.flatMap((section) => section.items)
      .flatMap((item) => item.sources ?? []);
    expect(homeSources.length).toBeGreaterThan(0);
    expect(
      homeSources.every((source) => source.providerId === "webshare"),
    ).toBe(true);
    // Canonical sources survive projection, making reconnection reversible.
    expect(database.titles.get(title.id)?.sources).toHaveLength(2);
    await states.set({
      integrationId: "hellspy",
      configured: true,
      status: "connected",
      updatedAt: now,
    });
    expect(
      (await core.titleDetail("default", title.id)).title.sources,
    ).toHaveLength(2);
  });
});
