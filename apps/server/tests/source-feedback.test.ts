import { afterEach, expect, it } from "vitest";
import { CatalogTitleSchema } from "@streamer-ai/contracts";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { createApp, PreviewContentProvider } from "../src/index.js";

const apps: ReturnType<typeof createApp>[] = [];
const databases: StreamerDatabase[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

it("shares separate profile votes across an account and validates file identity", async () => {
  const db = openStreamerDatabase({ filename: ":memory:" });
  databases.push(db);
  const preview = new PreviewContentProvider();
  const base = preview.bootstrapTitles().find((item) => item.kind === "movie")!;
  const movie = CatalogTitleSchema.parse({
    ...base,
    sources: ["a", "b"].map((id) => ({
      id: id.repeat(32),
      providerId: "webshare",
      candidateId: `file-${id}`,
      releaseName: `${base.title}.mkv`,
      sizeBytes: 100,
      format: base.formats[0],
      seasonNumber: null,
      episodeNumber: null,
      checkedAt: new Date().toISOString(),
    })),
  });
  const app = createApp({
    database: db,
    environment: "test",
    logger: false,
    contentProvider: {
      id: "feedback-test",
      mode: "preview",
      bootstrapTitles: () => [movie],
      buildHome: (input) => preview.buildHome(input),
      discover: (request, completedAt, context) =>
        preview.discover(request, completedAt, context),
    },
  });
  apps.push(app);
  await app.ready();
  db.profiles.create({ id: "second", name: "Second", locale: "cs" });
  db.accounts.upsert({ id: "another-account" });
  db.profiles.create({
    id: "other",
    accountId: "another-account",
    name: "Other",
    locale: "cs",
  });
  const path = (profile: string) =>
    `/api/v1/profiles/${profile}/titles/${encodeURIComponent(movie.id)}/source-feedback`;
  const settings = (profile: string) =>
    `/api/v1/profiles/${profile}/source-feedback-settings`;
  expect((await app.inject(settings("default"))).json()).toEqual({
    enabled: true,
  });
  const write = (
    profile: string,
    vote: "up" | "down" | null,
    sourceId = "b".repeat(32),
  ) =>
    app.inject({
      method: "PUT",
      url: path(profile),
      payload: { sourceId, vote },
    });
  expect((await write("default", "up")).statusCode).toBe(200);
  expect((await app.inject(path("second"))).json().items).toEqual([
    {
      profileId: db.profiles.get("default")!.syncId,
      isOwn: false,
      titleId: movie.id,
      providerId: "webshare",
      candidateId: "file-b",
      seasonNumber: null,
      episodeNumber: null,
      vote: "up",
    },
  ]);
  expect((await write("second", "down")).statusCode).toBe(200);
  const shared = (await app.inject(path("second"))).json().items;
  expect(shared).toHaveLength(2);
  expect(shared.find((item: { isOwn: boolean }) => item.isOwn).vote).toBe(
    "down",
  );
  expect(
    (await app.inject(path("default")))
      .json()
      .items.find((item: { isOwn: boolean }) => item.isOwn).vote,
  ).toBe("up");
  const detailPath = (profile: string) =>
    `/api/v1/profiles/${profile}/titles/${encodeURIComponent(movie.id)}`;
  // Opposing votes cancel out for ranking.
  expect(
    (await app.inject(detailPath("second"))).json().title.sources[0]
      .candidateId,
  ).toBe("file-a");
  expect(
    (
      await app.inject({
        method: "PUT",
        url: settings("second"),
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200);
  expect((await app.inject(path("second"))).json()).toEqual({
    enabled: false,
    items: [],
  });
  expect(
    (await app.inject(detailPath("second"))).json().title.sources[0]
      .candidateId,
  ).toBe("file-a");
  expect((await write("second", "down")).statusCode).toBe(409);
  expect((await write("default", "up", "c".repeat(32))).statusCode).toBe(404);
  expect(
    (
      await app.inject({
        method: "PUT",
        url: path("default"),
        payload: {
          sourceId: "b".repeat(32),
          vote: "up",
          candidateId: "injected",
        },
      })
    ).statusCode,
  ).toBe(400);
  expect((await app.inject(path("other"))).statusCode).toBe(404);
  expect((await write("default", "down")).statusCode).toBe(200);
  db.profiles.delete("default");
  expect(db.sourceFeedback.list("local")).toHaveLength(2);
  await app.inject({
    method: "PUT",
    url: settings("second"),
    payload: { enabled: true },
  });
  expect(
    (await app.inject(path("second")))
      .json()
      .items.find((item: { isOwn: boolean }) => item.isOwn).vote,
  ).toBe("down");
  expect((await write("second", null)).statusCode).toBe(200);
  expect(
    (await app.inject(path("second")))
      .json()
      .items.find((item: { isOwn: boolean }) => item.isOwn).vote,
  ).toBeNull();
});
