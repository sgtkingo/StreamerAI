import { Readable } from "node:stream";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  createAppLogger,
  InMemoryPlaybackTicketStore,
} from "../src/index.js";
import type { PlaybackMediaEngine } from "../src/services/playback-media-engine.js";

describe("in-app media gateway", () => {
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
      subtitle: vi.fn().mockResolvedValue(Buffer.from("WEBVTT\n\n")),
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
    expect(metadata.json()).toEqual(manifest);
    expect(metadata.body).not.toContain(directUrl);

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
      url: "/api/v1/playback/grants/media-grant/subtitles/3",
    });
    expect(subtitle.statusCode).toBe(200);
    expect(subtitle.body).toContain("WEBVTT");
    expect(media.subtitle).toHaveBeenCalledWith(directUrl, 3, 0);

    const laterSubtitle = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/subtitles/3?at=155",
    });
    expect(laterSubtitle.statusCode).toBe(200);
    expect(media.subtitle).toHaveBeenCalledWith(directUrl, 3, 150);
    expect(laterSubtitle.headers["x-streamer-subtitle-offset"]).toBe("148");

    const invalidSubtitleTime = await app.inject({
      method: "GET",
      url: "/api/v1/playback/grants/media-grant/subtitles/3?at=99999",
    });
    expect(invalidSubtitleTime.statusCode).toBe(400);

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
