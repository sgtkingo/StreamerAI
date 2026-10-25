import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogTitleSchema, type CatalogTitle } from "@streamer-ai/contracts";
import {
  createApp,
  NonPersistentMemoryIntegrationStateStore,
  PreviewContentProvider,
  type StreamerContentProvider,
} from "../src/index.js";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";

const now = "2026-10-25T12:00:00.000Z";
describe("profile media source preferences", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  const databases: StreamerDatabase[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });
  async function setup() {
    const database = openStreamerDatabase({ filename: ":memory:" });
    databases.push(database);
    const preview = new PreviewContentProvider();
    const base = preview
      .bootstrapTitles()
      .find((title) => title.kind === "movie")!;
    const movie = CatalogTitleSchema.parse({
      ...base,
      sources: ["hellspy", "webshare", "local-files"].map(
        (providerId, index) => ({
          id: "abc"[index]!.repeat(32),
          providerId,
          candidateId: `file-${index}`,
          releaseName: "Movie.mkv",
          sizeBytes: 100,
          format: base.formats[0],
          seasonNumber: null,
          episodeNumber: null,
          checkedAt: now,
        }),
      ),
    });
    const contentProvider: StreamerContentProvider = {
      id: "test",
      mode: "live",
      bootstrapTitles: () => [movie],
      buildHome: (input) => preview.buildHome(input),
      discover: vi.fn(),
    };
    const states = new NonPersistentMemoryIntegrationStateStore();
    for (const integrationId of ["hellspy", "webshare", "local-files"])
      await states.set({
        integrationId,
        configured: true,
        status: "connected",
        updatedAt: now,
      });
    const options = {
      database,
      environment: "test",
      logger: false as const,
      contentProvider,
      integrationStateStore: states,
      now: () => new Date(now),
    };
    const app = createApp(options);
    apps.push(app);
    await app.ready();
    // Local source is configured by the normal local-folder setup lifecycle.
    await states.set({
      integrationId: "local-files",
      configured: true,
      status: "connected",
      updatedAt: now,
    });
    return { app, movie, options };
  }
  async function providerIds(
    app: ReturnType<typeof createApp>,
    title: CatalogTitle,
  ) {
    const response = await app.inject(
      `/api/v1/profiles/default/titles/${encodeURIComponent(title.id)}`,
    );
    expect(response.statusCode).toBe(200);
    return response
      .json()
      .title.sources.map((source: { providerId: string }) => source.providerId);
  }
  it("defaults to local storage and applies saved priority to Recommended ordering", async () => {
    const { app, movie } = await setup();
    const initial = await app.inject(
      "/api/v1/profiles/default/media-source-preferences",
    );
    expect(initial.json().providerOrder).toEqual([
      "local-files",
      "webshare",
      "hellspy",
    ]);
    expect((await providerIds(app, movie))[0]).toBe("local-files");
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/media-source-preferences",
      payload: { providerOrder: ["hellspy", "local-files", "webshare"] },
    });
    expect(saved.statusCode).toBe(200);
    expect(await providerIds(app, movie)).toEqual([
      "hellspy",
      "local-files",
      "webshare",
    ]);
  });
  it("persists across app recreation and keeps other profiles at their own defaults", async () => {
    const { app, options } = await setup();
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/media-source-preferences",
      payload: { providerOrder: ["webshare", "hellspy", "local-files"] },
    });
    const profile = await app.inject({
      method: "POST",
      url: "/api/v1/profiles",
      payload: { name: "Other", locale: "en" },
    });
    expect(profile.statusCode).toBe(201);
    const other = await app.inject(
      `/api/v1/profiles/${profile.json().id}/media-source-preferences`,
    );
    expect(other.json().providerOrder[0]).toBe("local-files");
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const restored = createApp(options);
    apps.push(restored);
    expect(
      (
        await restored.inject(
          "/api/v1/profiles/default/media-source-preferences",
        )
      ).json().providerOrder,
    ).toEqual(["webshare", "hellspy", "local-files"]);
  });
  it.each([["hellspy", "hellspy"], ["tmdb"], ["unknown-source"]])(
    "rejects invalid provider order %j",
    async (...providerOrder) => {
      const { app } = await setup();
      const response = await app.inject({
        method: "PUT",
        url: "/api/v1/profiles/default/media-source-preferences",
        payload: { providerOrder },
      });
      expect(response.statusCode).toBe(400);
      expect(
        (
          await app.inject("/api/v1/profiles/default/media-source-preferences")
        ).json().providerOrder[0],
      ).toBe("local-files");
    },
  );
  it("rejects unknown profiles and removes preferences when a profile is deleted", async () => {
    const { app, options } = await setup();
    expect(
      (await app.inject("/api/v1/profiles/missing/media-source-preferences"))
        .statusCode,
    ).toBe(404);
    const id = "temporary";
    options.database.profiles.create({
      id,
      name: "Temporary",
      locale: "en",
      preferences: {},
    });
    await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/${id}/media-source-preferences`,
      payload: { providerOrder: ["webshare", "local-files", "hellspy"] },
    });
    expect(
      options.database.settings.get(
        `media.source-order.${Buffer.from(id).toString("base64url")}`,
      ),
    ).not.toBeNull();
    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/profiles/${id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      options.database.settings.get(
        `media.source-order.${Buffer.from(id).toString("base64url")}`,
      ),
    ).toBeNull();
  });
});
