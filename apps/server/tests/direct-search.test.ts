import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import type { MediaCandidate } from "@streamer-ai/contracts";
import { createApp } from "../src/app.js";
import {
  DirectPositionStore,
  directSearchItems,
  directTitleId,
  isDirectTitleId,
  similarity,
} from "../src/services/direct-search.js";
import { formatFromReleaseName } from "../src/integrations/release-name.js";
import { LocalMediaLibrary } from "../src/services/local-media-library.js";
import {
  DIRECT_FOLDER,
  OfflineDownloadManager,
} from "../src/services/offline-download-manager.js";
import type { WebshareClient } from "../src/integrations/webshare-client.js";
import type { DirectSearchBackend } from "../src/routes/direct-search.js";
import { StreamerCore } from "../src/services/streamer-core.js";
import { WebshareMediaProvider } from "../src/integrations/webshare-media-provider.js";
import { LocalMediaProvider } from "../src/integrations/local-media-provider.js";

const tempRoot = realpathSync.native(tmpdir());
const temporary: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function candidate(
  providerId: string,
  candidateId: string,
  releaseName: string,
  sizeBytes: number | null = 1_000,
): MediaCandidate {
  return {
    ref: { providerId, candidateId },
    releaseName,
    sizeBytes,
    seasonNumber: null,
    episodeNumber: null,
    confidence: 0.5,
    provenance: {
      providerId,
      retrievedAt: new Date().toISOString(),
      connectorVersion: "test",
      confidence: 0.5,
      validationState: "derived",
      expiresAt: null,
    },
  };
}

describe("Fast Search ranking", () => {
  it("prefers names that contain the whole query and ignores technical tags", () => {
    const exact = similarity(
      "dune part two",
      "Dune.Part.Two.2024.2160p.CZ.mkv",
    );
    const partial = similarity("dune part two", "Dune.1984.1080p.mkv");
    const noisy = similarity(
      "dune part two",
      "Dune Part Two behind the scenes interview making of.mkv",
    );
    expect(exact).toBeGreaterThan(noisy);
    expect(noisy).toBeGreaterThan(partial);
    expect(similarity("Počátek", "Pocatek.2010.CZ.dabing.avi")).toBe(1);
    expect(similarity("", "anything")).toBe(0);
  });

  it("reads technical details and episodes from file names", () => {
    expect(
      formatFromReleaseName("Show.S02E05.720p.HEVC.CZ.EN.mkv"),
    ).toMatchObject({
      container: "mkv",
      resolution: "720p",
      videoCodec: "H.265",
      audioLanguages: ["cs", "en"],
    });
    const [item] = directSearchItems(
      "show",
      [candidate("webshare", "abc", "Show.S02E05.720p.mkv")],
      50,
    );
    expect(item).toMatchObject({
      providerRank: 50,
      episode: { seasonNumber: 2, episodeNumber: 5 },
      downloadable: true,
      directId: directTitleId({ providerId: "webshare", candidateId: "abc" }),
    });
    expect(isDirectTitleId(item!.directId)).toBe(true);
    expect(isDirectTitleId("movie-1")).toBe(false);
    const [local] = directSearchItems("show", [
      candidate("local-files", "file-1", "Show.mkv"),
    ]);
    expect(local!.downloadable).toBe(false);
  });

  it("keeps only the most recent resume positions", () => {
    const db = openStreamerDatabase({ filename: ":memory:" });
    const store = new DirectPositionStore(db);
    for (let index = 0; index < 205; index++)
      store.set(
        "p1",
        `direct-${String(index).padStart(32, "0")}`,
        { positionSeconds: index, durationSeconds: 300, progressPercent: 10 },
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      );
    expect(store.get("p1", `direct-${"0".repeat(32)}`)).toBeNull();
    expect(
      store.get("p1", `direct-${String(204).padStart(32, "0")}`),
    ).toMatchObject({ positionSeconds: 204 });
    db.close();
  });
});

describe("provider text search", () => {
  it("passes Webshare paging through and keeps its result order", async () => {
    const search = vi.fn().mockResolvedValue({
      total: 2,
      items: [
        {
          ident: "b",
          name: "Moon.2009.mkv",
          size: 5,
          passwordProtected: false,
          positiveVotes: 3,
          negativeVotes: 0,
        },
        {
          ident: "x",
          name: "Locked.mkv",
          size: 5,
          passwordProtected: true,
          positiveVotes: null,
          negativeVotes: null,
        },
      ],
    });
    const provider = new WebshareMediaProvider({
      client: { forProfile: () => ({ search }) } as unknown as WebshareClient,
      issuePlaybackTicket: vi.fn(),
    } as never);
    const found = await provider.searchText(
      { query: "moon", limit: 51, offset: 50 },
      { profileId: "p1" } as never,
    );
    expect(search).toHaveBeenCalledWith(
      { query: "moon", limit: 51, offset: 50 },
      undefined,
    );
    expect(found).toMatchObject([
      {
        ref: { providerId: "webshare", candidateId: "b" },
        qualityVotes: { positive: 3, negative: 0 },
        seasonNumber: null,
      },
    ]);
  });

  it("finds local files containing every query word", async () => {
    const folder = await mkdtemp(join(tempRoot, "streamer-direct-local-"));
    temporary.push(folder);
    await writeFile(join(folder, "Moon (2009).mkv"), "x");
    await writeFile(join(folder, "Moonlight.2016.mkv"), "x");
    await writeFile(join(folder, "Sun.mkv"), "x");
    const db = openStreamerDatabase({ filename: ":memory:" });
    const library = new LocalMediaLibrary(db);
    await library.addRoot(folder);
    await library.waitForScan();
    const provider = new LocalMediaProvider(library, vi.fn() as never);
    const names = async (query: string) =>
      (
        await provider.searchText({ query, limit: 10, offset: 0 }, {} as never)
      ).map((item) => item.releaseName);
    expect(await names("moon 2009")).toEqual(["Moon (2009).mkv"]);
    expect(await names("moon")).toEqual([
      "Moon (2009).mkv",
      "Moonlight.2016.mkv",
    ]);
    db.close();
  });
});

describe("Fast Search routes", () => {
  function setup(backend: Partial<DirectSearchBackend> = {}) {
    const database = openStreamerDatabase({ filename: ":memory:" });
    database.profiles.create({ id: "p1", name: "Viewer", locale: "en" });
    const directSearch: DirectSearchBackend = {
      directSearchProviders: async () => [
        { id: "webshare", name: "Webshare" },
        { id: "local-files", name: "Local files" },
      ],
      directSearch: async (_profile, providerId, _query, offset) =>
        Array.from({ length: 51 }, (_, index) =>
          candidate(providerId, `file-${offset + index}`, `Movie ${index}.mkv`),
        ),
      directInspect: async () => ({
        format: formatFromReleaseName("Movie.1080p.mkv"),
        languages: null,
      }),
      prepareDirectPlayback: async (_profile, ref, titleId) => ({
        grantId: "grant-1",
        titleId,
        providerId: ref.providerId,
        variantId: ref.candidateId,
        url: "/api/v1/playback/grants/grant-1",
        supportsHttpRange: true,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        embeddedSubtitles: [],
      }),
      ...backend,
    };
    const app = createApp({
      environment: "test",
      logger: false,
      database,
      directSearch,
    });
    apps.push(app);
    return { app, database };
  }

  it("lists providers and pages one provider's results", async () => {
    const { app } = setup();
    const providers = await app.inject({
      url: "/api/v1/profiles/p1/direct-search/providers",
    });
    expect(providers.json().providers).toHaveLength(2);
    const page = await app.inject({
      url: "/api/v1/profiles/p1/direct-search?provider=webshare&q=movie&offset=50",
    });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ provider: "webshare", hasMore: true });
    expect(page.json().items).toHaveLength(50);
    expect(page.json().items[0]).toMatchObject({
      candidateId: "file-50",
      providerRank: 50,
    });
  });

  it("reports a provider failure without hiding the other providers", async () => {
    const { app } = setup({
      directSearch: async () => {
        throw new Error("timeout");
      },
    });
    const failed = await app.inject({
      url: "/api/v1/profiles/p1/direct-search?provider=webshare&q=movie",
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error.code).toBe("DIRECT_SEARCH_FAILED");
  });

  it("plays a file and resumes it without touching Library or history", async () => {
    const { app, database } = setup();
    const ref = { providerId: "webshare", candidateId: "abc" };
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/p1/direct-search/play",
      payload: { ...ref, releaseName: "Movie.2024.mkv" },
    });
    expect(first.statusCode).toBe(200);
    const titleId = directTitleId(ref);
    expect(first.json().playback.titleId).toBe(titleId);
    expect(first.json().title).toMatchObject({
      id: titleId,
      kind: "movie",
      title: "Movie.2024.mkv",
      resumePositionSeconds: null,
    });
    // The playback routes call these with the grant's title id.
    const direct = new StreamerCore(database, () => new Date());
    direct.recordPlaybackStart("p1", titleId);
    direct.recordPlaybackProgress("p1", titleId, 40, 120, 300);
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/p1/direct-search/play",
      payload: { ...ref, releaseName: "Movie.2024.mkv" },
    });
    expect(second.json().title).toMatchObject({
      progressPercent: 40,
      resumePositionSeconds: 120,
    });
    expect(database.library.list("p1")).toEqual([]);
    expect(database.history.list("p1")).toEqual([]);
  });
});

describe("Fast Search downloads", () => {
  it("saves a Webshare file under its own name in the Fast Search folder", async () => {
    const folder = await mkdtemp(join(tempRoot, "streamer-direct-"));
    temporary.push(folder);
    const db = openStreamerDatabase({ filename: ":memory:" });
    db.profiles.create({ id: "p1", name: "Viewer", locale: "en" });
    const local = new LocalMediaLibrary(db);
    const root = await local.addRoot(folder);
    await local.waitForScan();
    await writeFile(
      join(folder, "unrelated.txt"),
      "keeps the root non-empty",
      "utf8",
    );
    const client = {
      forProfile: vi.fn().mockReturnValue({
        fileInfo: vi.fn().mockResolvedValue({
          ident: "abc",
          name: "Some Film (2024).mkv",
          type: "mkv",
          size: 5,
          downloadable: true,
          passwordProtected: false,
          copyrighted: false,
        }),
        createVideoLink: vi
          .fn()
          .mockResolvedValue("https://download.webshare.cz/file"),
      }),
    } as unknown as WebshareClient;
    const fetchSource = vi.fn().mockImplementation(
      async () =>
        new Response(Buffer.from("movie"), {
          status: 200,
          headers: { "content-length": "5" },
        }),
    );
    const downloads = new OfflineDownloadManager(
      db,
      local,
      client,
      fetchSource,
    );
    const wait = async () => {
      for (
        let attempt = 0;
        attempt < 100 &&
        downloads.list("p1").some((job) => job.state === "downloading");
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const job = await downloads.startDirect({
      profileId: "p1",
      candidateId: "abc",
      rootId: root.id,
    });
    expect(job).toMatchObject({
      direct: true,
      label: "Some Film (2024).mkv",
      titleId: directTitleId({ providerId: "webshare", candidateId: "abc" }),
    });
    await wait();
    expect(downloads.list("p1")[0]).toMatchObject({
      state: "complete",
      bytes: 5,
    });
    const saved = join(folder, DIRECT_FOLDER, "Some Film (2024).mkv");
    expect(await readFile(saved, "utf8")).toBe("movie");
    // The file joins the local library like any other file in the folder.
    expect(local.allFiles().map((file) => file.name)).toContain(
      "Some Film (2024).mkv",
    );
    await expect(
      downloads.startDirect({
        profileId: "p1",
        candidateId: "abc",
        rootId: root.id,
      }),
    ).rejects.toThrow(/already saved offline/);
    // Another file with the same name does not overwrite the first one.
    await downloads.startDirect({
      profileId: "p1",
      candidateId: "other",
      rootId: root.id,
    });
    await wait();
    expect((await readdir(join(folder, DIRECT_FOLDER))).sort()).toEqual([
      "Some Film (2024) (2).mkv",
      "Some Film (2024).mkv",
    ]);
    expect(await downloads.removeSaved(job.id, "p1")).toBe(true);
    expect(await readdir(join(folder, DIRECT_FOLDER))).toEqual([
      "Some Film (2024) (2).mkv",
    ]);
    db.close();
  });
});
