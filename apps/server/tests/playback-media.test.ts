import { Readable } from "node:stream";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  createAppLogger,
  InMemoryPlaybackTicketStore,
} from "../src/index.js";
import type { PlaybackMediaEngine } from "../src/services/playback-media-engine.js";
import { registerPlaybackRoutes } from "../src/routes/playback.js";
import type { StreamerCore } from "../src/services/streamer-core.js";

describe("in-app media gateway", () => {
  it("refreshes the private source on an explicit media retry", async () => {
    const tickets = new InMemoryPlaybackTicketStore();
    tickets.issue({
      grantId: "retry-grant",
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "file-1",
      directUrl: "https://media.example/old-source",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const refreshSource = vi
      .fn()
      .mockResolvedValue("https://media.example/new-source");
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 120,
        videoCodec: "h264",
        videoPixelFormat: "yuv420p",
        audioTracks: [],
        subtitleTracks: [],
      }),
      stream: vi.fn().mockImplementation(() => ({
        body: Readable.from([Buffer.from("mp4")]),
        stop: vi.fn(),
      })),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const core = {
      recordPlaybackStart: vi.fn(),
    } as unknown as StreamerCore;
    const app = Fastify({ logger: false });
    registerPlaybackRoutes(app, tickets, core, media, refreshSource);
    const path = "/api/v1/playback/grants/retry-grant/media";

    expect(
      (await app.inject({ method: "GET", url: `${path}?start=10` })).statusCode,
    ).toBe(200);
    expect(media.stream).toHaveBeenLastCalledWith(
      "https://media.example/old-source",
      expect.anything(),
      null,
      10,
    );
    expect(
      (await app.inject({ method: "GET", url: `${path}?start=10&refresh=1` }))
        .statusCode,
    ).toBe(200);
    expect(refreshSource).toHaveBeenCalledTimes(1);
    expect(media.stream).toHaveBeenLastCalledWith(
      "https://media.example/new-source",
      expect.anything(),
      null,
      10,
    );
    expect(
      (await app.inject({ method: "GET", url: `${path}?start=11` })).statusCode,
    ).toBe(200);
    expect(refreshSource).toHaveBeenCalledTimes(1);
    expect(media.stream).toHaveBeenLastCalledWith(
      "https://media.example/new-source",
      expect.anything(),
      null,
      11,
    );
    await app.close();
  });

  it("refreshes a community source on seek and rejects an unsafe replacement URL", async () => {
    const tickets = new InMemoryPlaybackTicketStore();
    tickets.issue({
      grantId: "nas-grant",
      profileId: "default",
      providerId: "nas",
      titleId: "sai:tmdb:movie:42",
      candidateId: "share-item-42",
      variantId: "nas-variant-42",
      directUrl: "https://media.example/first",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const refreshSource = vi
      .fn()
      .mockResolvedValueOnce("https://media.example/second")
      .mockResolvedValueOnce("file:///private/share/movie.mkv");
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 120,
        videoCodec: "h264",
        videoPixelFormat: "yuv420p",
        audioTracks: [],
        subtitleTracks: [],
      }),
      stream: vi.fn().mockImplementation(() => ({
        body: Readable.from([Buffer.from("mp4")]),
        stop: vi.fn(),
      })),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const core = { recordPlaybackStart: vi.fn() } as unknown as StreamerCore;
    const app = Fastify({ logger: false });
    registerPlaybackRoutes(app, tickets, core, media, refreshSource);
    const path = "/api/v1/playback/grants/nas-grant/media";

    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(
      200,
    );
    expect(refreshSource).not.toHaveBeenCalled();
    expect(media.stream).toHaveBeenLastCalledWith(
      "https://media.example/first",
      expect.anything(),
      null,
      0,
    );

    expect(
      (await app.inject({ method: "GET", url: `${path}?start=12` })).statusCode,
    ).toBe(200);
    expect(refreshSource).toHaveBeenCalledTimes(1);
    expect(media.stream).toHaveBeenLastCalledWith(
      "https://media.example/second",
      expect.anything(),
      null,
      12,
    );

    expect(
      (await app.inject({ method: "GET", url: `${path}?start=14` })).statusCode,
    ).toBe(502);
    expect(refreshSource).toHaveBeenCalledTimes(2);
    expect(media.stream).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("authorizes discovered external subtitles and caches their parsed cues", async () => {
    const tickets = new InMemoryPlaybackTicketStore();
    tickets.issue({
      grantId: "external-grant",
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "media-file",
      directUrl: "https://dl.wsfiles.cz/private-video",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceFilename: "Movie.2020.mkv",
      sourceSizeBytes: 123456,
      supportsHttpRange: true,
    });
    const candidate = {
      fileId: "subtitle-file",
      filename: "Movie.2020.cs.srt",
      extension: "srt" as const,
      language: "cs",
      forced: false,
      default: false,
      matchScore: 0.97,
      matchType: "language" as const,
    };
    const discover = vi.fn().mockResolvedValue([candidate]);
    const subtitleContent = "1\n00:00:02,000 --> 00:00:04,000\nAhoj\n";
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        filename: "Other.2021.srt",
        content: subtitleContent,
      })
      .mockResolvedValue({
        filename: candidate.filename,
        content: subtitleContent,
      });
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 240,
        videoCodec: "h264",
        videoPixelFormat: "yuv420p",
        audioTracks: [],
        subtitleTracks: [],
      }),
      stream: vi.fn(),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const app = createApp({
      environment: "test",
      logger: false,
      playbackTicketStore: tickets,
      playbackMediaEngine: media,
      externalSubtitleSource: { discover, load },
    });
    const manifest = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/external-grant/manifest",
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().externalSubtitleTracks).toEqual([candidate]);
    expect(manifest.json()).toMatchObject({
      seekable: true,
      sourceSizeBytes: 123456,
      sourceVersion: "media-file",
    });
    expect(discover).toHaveBeenCalledWith(
      "media-file",
      "Movie.2020.mkv",
      expect.any(AbortSignal),
    );
    const unknown = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/external-grant/subtitles/external/other-file/window?startMs=0",
    });
    expect(unknown.statusCode).toBe(404);
    expect(load).not.toHaveBeenCalled();
    const renamed = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/external-grant/subtitles/external/subtitle-file/window?startMs=0",
    });
    expect(renamed.statusCode).toBe(502);
    const first = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/external-grant/subtitles/external/subtitle-file/window?startMs=0",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      trackId: "external:subtitle-file",
      startMs: 0,
      endMs: 120000,
      cues: [{ startMs: 2000, endMs: 4000, text: "Ahoj" }],
    });
    const cached = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/external-grant/subtitles/external/subtitle-file/window?startMs=60000",
    });
    expect(cached.statusCode).toBe(200);
    expect(load).toHaveBeenCalledTimes(2);
    expect(first.body).not.toContain("dl.wsfiles.cz");
    await app.close();
  });

  it("serves a selected audio track, thumbnail and subtitle without exposing the source", async () => {
    let current = new Date("2026-10-02T12:00:00.000Z");
    const now = () => current;
    const tickets = new InMemoryPlaybackTicketStore(now);
    const directUrl = "https://vip.17.dl.wsfiles.cz/private-video";
    tickets.issue({
      grantId: "media-grant",
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "file-1",
      directUrl,
      expiresAt: "2026-10-02T12:01:00.000Z",
    });
    const manifest = {
      durationSeconds: 3600,
      videoCodec: "h264",
      videoPixelFormat: "yuv420p",
      audioTracks: [
        {
          streamIndex: 2,
          codec: "eac3",
          channels: 6,
          channelLayout: "5.1(side)",
          language: "cs",
          title: "Czech 5.1",
        },
      ],
      subtitleTracks: [
        { streamIndex: 3, codec: "subrip", language: "cs", title: "Czech" },
      ],
    };
    const stop = vi.fn();
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue(manifest),
      stream: vi.fn().mockReturnValue({
        body: Readable.from([Buffer.from("fragmented-mp4")]),
        stop,
      }),
      thumbnail: vi.fn().mockResolvedValue(Buffer.from([0xff, 0xd8, 0xff])),
      subtitle: vi
        .fn()
        .mockResolvedValue(
          Buffer.from("WEBVTT\n\n00:01:59.000 --> 00:02:03.000\nAhoj\n"),
        ),
    };
    const app = createApp({
      environment: "test",
      logger: false,
      now,
      playbackTicketStore: tickets,
      playbackMediaEngine: media,
    });

    const metadata = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/manifest",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual({
      ...manifest,
      seekable: null,
      sourceSizeBytes: null,
      sourceVersion: "file-1",
      externalSubtitleTracks: [],
    });
    expect(metadata.body).not.toContain(directUrl);
    const directGrant = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant",
    });
    expect(directGrant.statusCode).toBe(404);
    expect(directGrant.headers.location).toBeUndefined();
    expect(directGrant.body).not.toContain(directUrl);

    const prematureProgress = await app.inject({
      method: "POST",
      url: "/api/v1/playback/grants/media-grant/progress",
      payload: { progressPercent: 37.5 },
    });
    expect(prematureProgress.statusCode).toBe(409);

    const invalid = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/media?audio=9&start=0",
    });
    expect(invalid.statusCode).toBe(400);

    const stream = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/media?audio=2&start=31.500",
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("video/mp4");
    expect(media.stream).toHaveBeenCalledWith(directUrl, manifest, 2, 31.5);
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/default/history",
    });
    expect(history.json().items).toHaveLength(1);

    const progress = await app.inject({
      method: "POST",
      url: "/api/v1/playback/grants/media-grant/progress",
      payload: { progressPercent: 37.5 },
    });
    expect(progress.statusCode).toBe(204);
    const library = await app.inject({
      method: "GET",
      url: "/api/v1/profiles/default/library",
    });
    expect(library.json().items[0].title.progressPercent).toBe(37.5);

    const thumbnail = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/thumbnail?at=33",
    });
    expect(thumbnail.statusCode).toBe(200);
    expect(media.thumbnail).toHaveBeenCalledWith(directUrl, 30);

    const subtitle = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/subtitles/3/window?startMs=121000&durationMs=120000",
    });
    expect(subtitle.statusCode).toBe(200);
    expect(subtitle.json()).toEqual({
      trackId: "embedded:3",
      startMs: 120000,
      endMs: 240000,
      cues: [{ startMs: 119000, endMs: 123000, text: "Ahoj" }],
    });
    expect(media.subtitle).toHaveBeenCalledWith(
      directUrl,
      3,
      110000,
      130000,
      expect.any(AbortSignal),
    );

    const cachedSubtitle = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/subtitles/3/window?startMs=170000&durationMs=120000",
    });
    expect(cachedSubtitle.statusCode).toBe(200);
    expect(cachedSubtitle.json()).toEqual(subtitle.json());
    expect(media.subtitle).toHaveBeenCalledTimes(1);

    current = new Date("2026-10-02T12:02:00.000Z");
    expect(tickets.get("media-grant")).not.toBeNull();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/playback/grants/media-grant",
        })
      ).statusCode,
    ).toBe(204);
    expect(tickets.get("media-grant")).toBeNull();
    expect(stop).toHaveBeenCalled();
    await app.close();
  });

  it("logs a failed media probe without secrets or a grant capability", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const tickets = new InMemoryPlaybackTicketStore();
    const secret = "provider-link-secret-123";
    const grantId = "private-grant-123";
    tickets.issue({
      grantId,
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "file-1",
      directUrl: `https://media.example/${secret}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockRejectedValue(new Error(`Failed ${secret}`)),
      stream: vi.fn(),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const app = createApp({
      environment: "test",
      logger: createAppLogger({ destination }),
      playbackTicketStore: tickets,
      playbackMediaEngine: media,
    });

    const result = await app.inject({
      method: "GET",
      url: `/api/v1/playback/grants/${grantId}/manifest`,
    });
    expect(result.statusCode).toBe(502);
    expect(output).toContain("PLAYBACK_MANIFEST_FAILED");
    expect(output).toContain("UNEXPECTED_MEDIA_FAILURE");
    expect(output).not.toContain(secret);
    expect(output).not.toContain(grantId);
    await app.close();
  });

  it("records a failed transcoder exit using numeric diagnostics only", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const grantId = "stream-secret-grant";
    const tickets = new InMemoryPlaybackTicketStore();
    tickets.issue({
      grantId,
      profileId: "default",
      providerId: "webshare",
      titleId: "sai:preview:lake-house",
      variantId: "file-1",
      directUrl: "https://media.example/private-stream-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const media: PlaybackMediaEngine = {
      probe: vi.fn().mockResolvedValue({
        durationSeconds: 60,
        videoCodec: "h264",
        videoPixelFormat: "yuv420p",
        audioTracks: [],
        subtitleTracks: [],
      }),
      stream: vi.fn().mockReturnValue({
        body: Readable.from([Buffer.from("mp4")]),
        stop: vi.fn(),
        completion: Promise.resolve({
          status: "failed",
          exitCode: 1,
          bytes: 3,
        }),
      }),
      thumbnail: vi.fn(),
      subtitle: vi.fn(),
    };
    const app = createApp({
      environment: "test",
      logger: createAppLogger({ destination }),
      playbackTicketStore: tickets,
      playbackMediaEngine: media,
    });

    const result = await app.inject({
      method: "GET",
      url: `/api/v1/playback/grants/${grantId}/media?start=0`,
    });
    expect(result.statusCode).toBe(200);
    expect(output).toContain("PLAYBACK_STREAM_STARTED");
    expect(output).toContain("PLAYBACK_STREAM_FAILED");
    expect(output).toContain('"exitCode":1');
    expect(output).not.toContain("private-stream-token");
    expect(output).not.toContain(grantId);
    await app.close();
  });
});
