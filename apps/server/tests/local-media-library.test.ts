import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import { LocalMediaLibrary } from "../src/services/local-media-library.js";
import { LocalMediaProvider } from "../src/integrations/local-media-provider.js";
import {
  InMemoryPlaybackTicketStore,
  validatePlaybackSourceUrl,
} from "../src/services/playback-ticket-store.js";
import { createApp } from "../src/app.js";
import { OfflineDownloadManager } from "../src/services/offline-download-manager.js";
import type { WebshareClient } from "../src/integrations/webshare-client.js";
import type { AgentProvider, MetadataProvider } from "@streamer-ai/contracts";
import { LiveContentCoordinator } from "../src/services/live-content-coordinator.js";
import { StreamerCore } from "../src/services/streamer-core.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";
import { PreferredSourceStore } from "../src/services/preferred-source-store.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("local folder connector", () => {
  it("creates the managed library on first start and respects a later disconnect", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-default-local-"));
    temporary.push(folder);
    const runtimeConfig = readRuntimeConfig({
      NODE_ENV: "development",
      STREAMERAI_DATA_DIR: folder,
    });
    const first = createApp({
      environment: "development",
      runtimeConfig,
      logger: false,
    });
    try {
      const response = await first.inject({
        method: "GET",
        url: "/api/v1/integrations/local-files",
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().roots).toHaveLength(1);
      expect(response.json().roots[0].path).toBe(
        resolve(folder, "StreamerAI", "Local", "Library"),
      );
      const catalog = await first.inject({
        method: "GET",
        url: "/api/v1/integrations",
      });
      expect(
        catalog
          .json()
          .items.find((item: { id: string }) => item.id === "local-files"),
      ).toMatchObject({ configured: true, status: "connected" });
      expect(
        (
          await first.inject({
            method: "DELETE",
            url: "/api/v1/integrations/local-files",
          })
        ).statusCode,
      ).toBe(204);
    } finally {
      await first.close();
    }
    const second = createApp({
      environment: "development",
      runtimeConfig,
      logger: false,
    });
    try {
      const response = await second.inject({
        method: "GET",
        url: "/api/v1/integrations/local-files",
      });
      expect(response.json().roots).toEqual([]);
    } finally {
      await second.close();
    }
  });

  it("opens the server folder picker and connects the selected folder", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-picked-local-"));
    temporary.push(folder);
    const picker = vi.fn().mockResolvedValue(folder);
    const app = createApp({
      environment: "test",
      logger: false,
      localFolderPicker: picker,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/local-files/select-folder",
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().roots[0].path).toBe(resolve(folder));
      expect(picker).toHaveBeenCalledOnce();
      const remote = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/local-files/select-folder",
        remoteAddress: "192.0.2.8",
      });
      expect(remote.statusCode).toBe(403);
      expect(picker).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it("indexes episodes beyond the former 24-source title limit", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-series-"));
    temporary.push(folder);
    for (let episode = 1; episode <= 30; episode += 1)
      await writeFile(
        join(
          folder,
          `Example.Show.S01E${String(episode).padStart(2, "0")}.mkv`,
        ),
        "episode",
      );
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const library = new LocalMediaLibrary(db);
    try {
      await library.addRoot(folder);
      await library.waitForScan();
      const title = db.titles
        .list()
        .find((item) => item.title === "Example Show");
      expect(title?.sources).toHaveLength(30);
      expect(
        title?.sources?.find((source) => source.episodeNumber === 30),
      ).toBeDefined();
      expect(title?.seriesCoverage?.episodesAvailable).toBe(30);
      const opaque = join(folder, "opaque-episode.mkv");
      await writeFile(opaque, "episode");
      await library.linkManagedFile(opaque, title!.id, {
        seasonNumber: 1,
        episodeNumber: 31,
      });
      library.startScan();
      await library.waitForScan();
      expect(
        db.titles
          .get(title!.id)
          ?.sources?.find(
            (source) => source.releaseName === "opaque-episode.mkv",
          ),
      ).toMatchObject({
        providerId: "local-files",
        seasonNumber: 1,
        episodeNumber: 31,
      });
    } finally {
      await library.close();
      db.close();
    }
  });

  it("scans multiple roots, filters formats, enriches Library, and removes stale files", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-"));
    temporary.push(folder);
    const first = join(folder, "first");
    const second = join(folder, "second");
    await mkdir(join(first, "nested"), { recursive: true });
    await mkdir(second);
    await writeFile(join(first, "nested", "Arrival.2016.mkv"), "movie");
    await writeFile(join(first, "nested", "Arrival.2016.avi"), "movie");
    await writeFile(join(second, "Planet.Earth.S01E02.mp4"), "episode");
    const outside = join(folder, "outside.mp4");
    await writeFile(outside, "outside");
    if (process.platform !== "win32")
      await symlink(outside, join(first, "linked.mp4"));
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const library = new LocalMediaLibrary(db);
    try {
      const rootA = await library.addRoot(first);
      await library.addRoot(second);
      await library.waitForScan();
      expect(
        library
          .allFiles()
          .map((file) => file.name)
          .sort(),
      ).toEqual([
        "Arrival.2016.avi",
        "Arrival.2016.mkv",
        "Planet.Earth.S01E02.mp4",
      ]);
      const titles = db.library
        .list("default")
        .map((entry) => db.titles.get(entry.titleId)!);
      expect(titles.map((title) => title.title).sort()).toEqual([
        "Arrival",
        "Planet Earth",
      ]);
      expect(
        titles.find((title) => title.kind === "series")?.sources?.[0],
      ).toMatchObject({
        providerId: "local-files",
        seasonNumber: 1,
        episodeNumber: 2,
      });
      library.setExtensions(["mkv"]);
      await library.waitForScan();
      expect(library.allFiles().map((file) => file.name)).toEqual([
        "Arrival.2016.mkv",
      ]);
      expect(db.library.list("default")).toHaveLength(1);
      library.removeRoot(rootA.id);
      await library.waitForScan();
      expect(db.library.list("default")).toHaveLength(0);
    } finally {
      await library.close();
      db.close();
    }
  });

  it("keeps the absolute local path behind a playback grant", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-"));
    temporary.push(folder);
    const path = resolve(folder, "Dune.2021.mkv");
    await writeFile(path, "movie");
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const library = new LocalMediaLibrary(db);
    const tickets = new InMemoryPlaybackTicketStore();
    try {
      await library.addRoot(folder);
      await library.waitForScan();
      const title = db.titles.list()[0]!;
      const source = title.sources![0]!;
      const provider = new LocalMediaProvider(library, (input) =>
        tickets.issue(input),
      );
      const context = {
        requestId: "test",
        profileId: "default",
        locale: "en",
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      };
      const variant = await provider.inspect(
        { providerId: "local-files", candidateId: source.candidateId },
        context,
      );
      const grant = await provider.createPlayback(
        {
          profileId: "default",
          titleId: title.id,
          seasonNumber: null,
          episodeNumber: null,
          variant: {
            providerId: "local-files",
            candidateId: source.candidateId,
            variantId: variant.variantId,
          },
          startPositionSeconds: 0,
        },
        context,
      );
      expect(grant.url).toMatch(/^\/api\/v1\/playback\/grants\//);
      expect(JSON.stringify(grant)).not.toContain(path);
      expect(tickets.get(grant.grantId)?.directUrl).toMatch(/^file:/);
      expect(() =>
        validatePlaybackSourceUrl("file:///tmp/secret", "webshare"),
      ).toThrow();
      await rm(path);
      await expect(
        provider.inspect(
          { providerId: "local-files", candidateId: source.candidateId },
          context,
        ),
      ).rejects.toThrow();
    } finally {
      await library.close();
      db.close();
    }
  });

  it("opens a local-only episode through the regular title and playback flow", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-playback-"));
    temporary.push(folder);
    await writeFile(join(folder, "Example.Show.S01E03.mkv"), "episode");
    await writeFile(join(folder, "Example.Show.S01E03.avi"), "alternate");
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const library = new LocalMediaLibrary(db);
    const tickets = new InMemoryPlaybackTicketStore();
    try {
      await library.addRoot(folder);
      await library.waitForScan();
      const states = new NonPersistentMemoryIntegrationStateStore();
      const now = new Date().toISOString();
      await states.set({
        integrationId: "local-files",
        status: "connected",
        configured: true,
        updatedAt: now,
      });
      const coordinator = new LiveContentCoordinator({
        agent: {} as AgentProvider,
        metadata: { descriptor: () => ({ id: "tmdb" }) } as MetadataProvider,
        media: new LocalMediaProvider(library, (input) => tickets.issue(input)),
        integrationStateStore: states,
        inference: {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "test",
          minimumVersion: "0.5.0",
          contextTokens: 4096,
          maxOutputTokens: 512,
          timeoutMs: 60_000,
        },
        localeForProfile: () => "en",
      });
      const core = new StreamerCore(db, () => new Date(), coordinator);
      const title = db.titles.list()[0]!;
      const preferred = title.sources!.find((source) =>
        source.releaseName.endsWith(".avi"),
      )!;
      core.recordPlaybackStart(
        "default",
        title.id,
        { seasonNumber: 1, episodeNumber: 3 },
        { providerId: "local-files", candidateId: preferred.candidateId },
      );
      const detail = await core.titleDetail("default", title.id);
      expect(detail.series?.seasons[0]?.episodes[0]).toMatchObject({
        seasonNumber: 1,
        episodeNumber: 3,
      });
      await expect(
        core.checkPlayback("default", title.id, {
          seasonNumber: 1,
          episodeNumber: 3,
        }),
      ).resolves.toBeDefined();
      const grant = await core.preparePlayback("default", title.id, {
        seasonNumber: 1,
        episodeNumber: 3,
      });
      expect(grant.url).toMatch(/^\/api\/v1\/playback\/grants\//);
      expect(tickets.get(grant.grantId)?.providerId).toBe("local-files");
      expect(tickets.get(grant.grantId)?.candidateId).toBe(
        preferred.candidateId,
      );
    } finally {
      await library.close();
      db.close();
    }
  });

  it("exposes folder and format management through the integration API", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-"));
    temporary.push(folder);
    await writeFile(join(folder, "Solaris.1972.mkv"), "movie");
    const app = createApp({ environment: "test", logger: false });
    try {
      const added = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/local-files/roots",
        payload: { path: folder },
      });
      expect(added.statusCode).toBe(201);
      const rootId = added.json().root.id as string;
      let count = 0;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const config = await app.inject({
          method: "GET",
          url: "/api/v1/integrations/local-files",
        });
        count = config.json().scan.fileCount as number;
        if (config.json().scan.state === "complete") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(count).toBe(1);
      const catalog = await app.inject({
        method: "GET",
        url: "/api/v1/integrations",
      });
      expect(
        catalog
          .json()
          .items.find((item: { id: string }) => item.id === "local-files"),
      ).toMatchObject({ configured: true, planned: false });
      const formats = await app.inject({
        method: "PUT",
        url: "/api/v1/integrations/local-files/formats",
        payload: { extensions: ["mp4"] },
      });
      expect(formats.statusCode).toBe(200);
      expect(formats.json().extensions).toEqual(["mp4"]);
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/v1/integrations/local-files/roots/${rootId}`,
      });
      expect(removed.statusCode).toBe(200);
      expect(removed.json().roots).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("downloads a verified Webshare source into the chosen root and indexes it", async () => {
    const folder = await mkdtemp(join(tmpdir(), "streamer-local-"));
    temporary.push(folder);
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const local = new LocalMediaLibrary(db);
    try {
      const root = await local.addRoot(folder);
      await local.waitForScan();
      const checkedAt = new Date().toISOString();
      const sourceId = "a".repeat(32);
      db.titles.upsert({
        id: "movie-1",
        kind: "movie",
        title: "Moon",
        originalTitle: null,
        year: 2009,
        synopsis: "",
        posterUrl: null,
        backdropUrl: null,
        accentColor: "#55565b",
        genres: [],
        ratings: [],
        availability: "available",
        availabilityProvider: "webshare",
        availabilityCheckedAt: checkedAt,
        formats: [
          {
            label: "MKV",
            container: "mkv",
            resolution: null,
            videoCodec: null,
            audioLanguages: [],
            subtitleLanguages: [],
          },
        ],
        sources: [
          {
            id: sourceId,
            providerId: "webshare",
            candidateId: "remote-file",
            releaseName: "unrelated-release-928.mkv",
            sizeBytes: 5,
            format: {
              label: "MKV",
              container: "mkv",
              resolution: null,
              videoCodec: null,
              audioLanguages: [],
              subtitleLanguages: [],
            },
            seasonNumber: null,
            episodeNumber: null,
            checkedAt,
          },
        ],
        seriesCoverage: null,
        metadataProvider: "tmdb",
        metadataValidatedAt: checkedAt,
      });
      const fetchSource = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(Buffer.from("movie"), {
            status: 200,
            headers: { "content-length": "5" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(Buffer.from("other"), {
            status: 200,
            headers: { "content-length": "5" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(Buffer.from("bad"), {
            status: 200,
            headers: { "content-length": "5" },
          }),
        );
      const client = {
        createVideoLink: vi
          .fn()
          .mockResolvedValue("https://download.webshare.cz/file"),
      } as unknown as WebshareClient;
      const downloads = new OfflineDownloadManager(
        db,
        local,
        client,
        fetchSource,
      );
      const job = downloads.start({
        profileId: "default",
        titleId: "movie-1",
        sourceId,
        rootId: root.id,
      });
      for (
        let attempt = 0;
        attempt < 50 && downloads.list("default")[0]?.state === "downloading";
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(downloads.list("default")[0]).toMatchObject({
        id: job.id,
        state: "complete",
        bytes: 5,
      });
      await local.waitForScan();
      expect(local.allFiles().map((file) => file.name)).toEqual([
        "unrelated-release-928.mkv",
      ]);
      expect(
        db.titles
          .get("movie-1")
          ?.sources?.some((source) => source.providerId === "local-files"),
      ).toBe(true);
      expect(db.titles.get("movie-1")?.sources?.[0]?.providerId).toBe(
        "local-files",
      );
      expect(db.titles.get("movie-1")?.availabilityProvider).toBe(
        "local-files",
      );
      expect(
        db.titles
          .list()
          .filter((item) =>
            item.sources?.some((source) => source.providerId === "local-files"),
          ),
      ).toHaveLength(1);
      expect(fetchSource).toHaveBeenCalledWith(
        "https://download.webshare.cz/file",
        expect.objectContaining({ redirect: "error" }),
      );
      const localSource = db.titles.get("movie-1")?.sources?.[0];
      expect(new PreferredSourceStore(db).get("default", "movie-1")).toBe(
        localSource?.id,
      );
      const path = local.allFiles()[0]!.path;
      expect(await readFile(path, "utf8")).toBe("movie");
      const restarted = new OfflineDownloadManager(
        db,
        local,
        client,
        fetchSource,
      );
      expect(restarted.list("default")).toMatchObject([
        { state: "complete", sourceId },
      ]);
      expect(() =>
        restarted.start({
          profileId: "default",
          titleId: "movie-1",
          sourceId,
          rootId: root.id,
        }),
      ).toThrow(/already saved offline/);
      restarted.start({
        profileId: "default",
        titleId: "movie-1",
        sourceId,
        rootId: root.id,
        replaceExisting: true,
      });
      for (
        let attempt = 0;
        attempt < 50 &&
        restarted.list("default").at(-1)?.state === "downloading";
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(restarted.list("default").at(-1)?.state).toBe("complete");
      expect(await readFile(path, "utf8")).toBe("other");
      restarted.start({
        profileId: "default",
        titleId: "movie-1",
        sourceId,
        rootId: root.id,
        replaceExisting: true,
      });
      for (
        let attempt = 0;
        attempt < 50 &&
        restarted.list("default").at(-1)?.state === "downloading";
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(restarted.list("default").at(-1)?.state).toBe("failed");
      expect(await readFile(path, "utf8")).toBe("other");
      expect(
        (await readdir(join(folder, ".streamerai-downloads", job.id))).every(
          (name) => !name.includes(".part"),
        ),
      ).toBe(true);
      local.removeRoot(root.id);
      await local.waitForScan();
      expect(db.titles.get("movie-1")?.sources?.[0]?.providerId).toBe(
        "webshare",
      );
      expect(db.titles.get("movie-1")?.availabilityProvider).toBe("webshare");
    } finally {
      await local.close();
      db.close();
    }
  });
});
