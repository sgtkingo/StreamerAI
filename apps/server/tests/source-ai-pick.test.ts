import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProvider } from "@streamer-ai/contracts";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { PreviewContentProvider } from "../src/services/content-provider.js";
import { registerSourceAiPickRoutes } from "../src/routes/source-ai-pick.js";
import { PreferredSourceStore } from "../src/services/preferred-source-store.js";
import { StreamerCore } from "../src/services/streamer-core.js";

const apps: ReturnType<typeof Fastify>[] = [];
const databases: StreamerDatabase[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of databases.splice(0)) db.close();
});

function setup(kind: "movie" | "series" = "movie") {
  const db = openStreamerDatabase({ filename: ":memory:" });
  databases.push(db);
  db.profiles.create({
    id: "viewer",
    name: "Viewer",
    locale: "cs",
    preferences: { genres: ["PRIVATE_PREFERENCE"] },
  });
  const title = new PreviewContentProvider()
    .bootstrapTitles()
    .find((item) => item.kind === kind)!;
  db.titles.upsert(title);
  const sources = ["a", "b"].map((letter) => ({
    id: letter.repeat(32),
    providerId: "webshare",
    candidateId: letter,
    releaseName: `${title.title}.${letter}.mkv`,
    sizeBytes: null,
    format: title.formats[0]!,
    seasonNumber: null,
    episodeNumber: null,
    checkedAt: new Date().toISOString(),
  }));
  const generate = vi.fn().mockResolvedValue(result(sources[1]!.id));
  const app = Fastify();
  apps.push(app);
  registerSourceAiPickRoutes(app, {
    database: db,
    agent: { generateStructured: generate } as unknown as AgentProvider,
    inference: () => ({ model: "selected-model", contextTokens: 8192 }),
  });
  const pick = (payload: unknown = { sources }) =>
    app.inject({
      method: "POST",
      url: `/api/v1/profiles/viewer/titles/${encodeURIComponent(title.id)}/ai-pick`,
      payload: payload as object,
    });
  return {
    db,
    app,
    title,
    sources,
    generate,
    pick,
    preferred: new PreferredSourceStore(db),
  };
}
function result(sourceId: string | null, finishReason = "completed") {
  return {
    output: { sourceId, reason: "Matches the requested title." },
    finishReason,
  };
}

describe("AI source selection", () => {
  it("uses the saved AI pick for ordinary Play and retains the existing unavailable-source fallback", async () => {
    const { db, title, preferred, sources } = setup();
    const preview = new PreviewContentProvider();
    const grant = {
      grantId: "test",
      titleId: title.id,
      providerId: "webshare",
      variantId: "file",
      url: "/api/v1/playback/grants/test",
      supportsHttpRange: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      embeddedSubtitles: [],
    };
    const preparePlayback = vi.fn().mockResolvedValue(grant);
    const core = new StreamerCore(db, () => new Date(), {
      id: "ai-pick-test",
      mode: "live",
      bootstrapTitles: () => [title],
      buildHome: (input) => preview.buildHome(input),
      discover: vi.fn(),
      preparePlayback,
    });
    preferred.setAi("viewer", title.id, sources[1]!.id, "Matches title.");
    await core.preparePlayback("viewer", title.id);
    expect(preparePlayback.mock.calls[0]![3]).toBe(sources[1]!.id);
    preparePlayback.mockRejectedValueOnce(new Error("Source expired"));
    await core.preparePlayback("viewer", title.id);
    expect(preparePlayback.mock.calls[2]![3]).toBeUndefined();
  });
  it("persists the chosen source with its explanation and sends no personal preferences or credentials", async () => {
    const { pick, generate, preferred, title, sources } = setup();
    const response = await pick();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sourceId: sources[1]!.id,
      applied: true,
    });
    expect(preferred.selection("viewer", title.id)).toEqual({
      sourceId: sources[1]!.id,
      aiPick: {
        sourceId: sources[1]!.id,
        reason: "Matches the requested title.",
      },
    });
    const request = generate.mock.calls[0]![0];
    expect(request.model).toBe("selected-model");
    expect(request.allowedToolNames).toEqual([]);
    expect(JSON.stringify(request)).not.toContain("PRIVATE_PREFERENCE");
    expect(request.messages[1].content).not.toContain("candidateId");
    preferred.set("viewer", title.id, sources[1]!.id);
    expect(preferred.selection("viewer", title.id).aiPick).toBeDefined();
    preferred.set("viewer", title.id, sources[0]!.id);
    expect(preferred.selection("viewer", title.id)).toEqual({
      sourceId: sources[0]!.id,
    });
  });
  it.each(["unknown", "incomplete", "unavailable", "no-match"])(
    "keeps the existing choice on %s",
    async (kind) => {
      const { pick, generate, preferred, title, sources } = setup();
      preferred.set("viewer", title.id, sources[0]!.id);
      if (kind === "unavailable")
        generate.mockRejectedValue(new Error("private provider details"));
      else
        generate.mockResolvedValue(
          result(
            kind === "no-match" ? null : "c".repeat(32),
            kind === "incomplete" ? "length" : "completed",
          ),
        );
      const response = await pick();
      expect(response.statusCode).toBe(kind === "no-match" ? 200 : 503);
      expect(preferred.get("viewer", title.id)).toBe(sources[0]!.id);
      expect(response.body).not.toContain("private provider details");
    },
  );
  it("does not overwrite a manual choice made while AI was running and rejects concurrent calls", async () => {
    const { pick, generate, preferred, title, sources } = setup();
    let complete!: (value: unknown) => void;
    const started = new Promise<void>((resolve) =>
      generate.mockImplementationOnce(() => {
        resolve();
        return new Promise((done) => {
          complete = done;
        });
      }),
    );
    const pending = pick();
    void pending.then(() => undefined);
    await started;
    expect((await pick()).statusCode).toBe(409);
    preferred.set("viewer", title.id, sources[0]!.id);
    complete(result(sources[1]!.id));
    expect((await pending).json().applied).toBe(false);
    expect(preferred.get("viewer", title.id)).toBe(sources[0]!.id);
  });
  it("requires an exact episode and rejects mixed source lists before inference", async () => {
    const { pick, generate, sources } = setup();
    expect(
      (await pick({ sources, episode: { seasonNumber: 1, episodeNumber: 2 } }))
        .statusCode,
    ).toBe(400);
    expect((await pick({ sources: [sources[0], sources[0]] })).statusCode).toBe(
      400,
    );
    expect(generate).not.toHaveBeenCalled();
  });
  it("handles episode choices independently", async () => {
    const { pick, title, sources, preferred, generate } = setup("series");
    const episode = { seasonNumber: 3, episodeNumber: 12 };
    expect(
      (
        await pick({
          episode,
          sources: sources.map((source) => ({ ...source, ...episode })),
        })
      ).statusCode,
    ).toBe(200);
    expect(preferred.get("viewer", title.id, episode)).toBe(sources[1]!.id);
    expect(
      preferred.get("viewer", title.id, { seasonNumber: 3, episodeNumber: 11 }),
    ).toBeNull();
    expect(generate.mock.calls[0]![0].messages[1].content).toContain(
      '"episodeNumber":12',
    );
  });
  it("rejects oversized context without invoking the model", async () => {
    const { pick, sources, generate } = setup();
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...sources[0]!,
      id: index.toString(16).padStart(32, "0"),
      releaseName: "x".repeat(500),
    }));
    expect((await pick({ sources: many })).statusCode).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });
});
