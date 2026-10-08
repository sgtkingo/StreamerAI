import { describe, expect, it, vi } from "vitest";
import {
  SubtitleService,
  canonicalSubtitleWindow,
  cueOverlaps,
  normalizeSubtitleCues,
  parseAss,
  parseExternalSubtitle,
  parseSrt,
  parseWebVtt,
} from "../src/services/subtitle-service.js";

describe("subtitle window normalization", () => {
  it("aligns windows, clips at movie end, and rejects invalid requests", () => {
    expect(canonicalSubtitleWindow(170_000)).toEqual({
      startMs: 120_000,
      endMs: 240_000,
    });
    expect(canonicalSubtitleWindow(230_000, 120_000, 235_500)).toEqual({
      startMs: 120_000,
      endMs: 235_500,
    });
    expect(() => canonicalSubtitleWindow(-1)).toThrow();
    expect(() => canonicalSubtitleWindow(0, 1)).toThrow();
    expect(() => canonicalSubtitleWindow(0, 300_001)).toThrow();
    expect(() => canonicalSubtitleWindow(240_000, 120_000, 240_000)).toThrow();
  });

  it("includes overlapping cues, excludes touching boundaries, and deduplicates", () => {
    const window = { startMs: 120_000, endMs: 240_000 };
    expect(
      cueOverlaps({ startMs: 119_000, endMs: 123_000, text: "A" }, window),
    ).toBe(true);
    expect(
      cueOverlaps({ startMs: 239_000, endMs: 241_000, text: "B" }, window),
    ).toBe(true);
    expect(
      cueOverlaps({ startMs: 100_000, endMs: 120_000, text: "C" }, window),
    ).toBe(false);
    expect(
      cueOverlaps({ startMs: 240_000, endMs: 241_000, text: "D" }, window),
    ).toBe(false);
    expect(
      normalizeSubtitleCues([
        { startMs: 1, endMs: 2, text: "same" },
        { startMs: 1, endMs: 2, text: "same" },
        { startMs: 1, endMs: 3, text: "other" },
      ]),
    ).toHaveLength(2);
  });
});

describe("subtitle parsing", () => {
  it("parses absolute WebVTT timestamps, text, and settings", () => {
    expect(
      parseWebVtt(
        "WEBVTT\n\n1\n01:22:59.000 --> 01:23:03.000 align:start\n<i>Ahoj</i> &amp; welcome\n",
      ),
    ).toEqual([
      {
        startMs: 4_979_000,
        endMs: 4_983_000,
        text: "Ahoj & welcome",
        settings: "align:start",
      },
    ]);
    expect(() => parseWebVtt("not a WebVTT file")).toThrow();
  });

  it("parses SRT and ASS/SSA without raw styling tags", () => {
    expect(
      parseSrt("1\r\n00:00:01,000 --> 00:00:03,200\r\nHello\r\nworld\r\n"),
    ).toEqual([{ startMs: 1000, endMs: 3200, text: "Hello\nworld" }]);
    const ass =
      "[Script Info]\nTitle: Example\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:04.50,Default,,0,0,0,,{\\an8}Hello\\Nworld, again";
    expect(parseAss(ass)).toEqual([
      { startMs: 2000, endMs: 4500, text: "Hello\nworld, again" },
    ]);
    expect(parseExternalSubtitle("movie.ssa", ass)).toEqual(parseAss(ass));
  });
});

describe("SubtitleService", () => {
  it("seeks before an embedded window, keeps absolute timestamps, and reuses the cache", async () => {
    const service = new SubtitleService();
    const extract = vi
      .fn()
      .mockResolvedValue(
        Buffer.from(
          "WEBVTT\n\n00:01:59.000 --> 00:02:03.000\nAcross\n\n00:04:00.000 --> 00:04:03.000\nOutside\n",
        ),
      );
    const input = {
      mediaIdentity: "webshare:abc:grant-1",
      trackId: "embedded:2",
      sourceUrl: "https://source.example/private",
      streamIndex: 2,
      startMs: 121_000,
      movieDurationMs: 600_000,
      extract,
    };
    const first = await service.getEmbeddedWindow(input);
    expect(first).toEqual({
      trackId: "embedded:2",
      startMs: 120_000,
      endMs: 240_000,
      cues: [{ startMs: 119_000, endMs: 123_000, text: "Across" }],
    });
    expect(extract).toHaveBeenCalledWith(
      input.sourceUrl,
      2,
      110_000,
      130_000,
      expect.any(AbortSignal),
    );
    expect(
      await service.getEmbeddedWindow({ ...input, startMs: 170_000 }),
    ).toEqual(first);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(service.stats.cacheEntries).toBe(1);
    service.close();
  });

  it("downloads and parses an external file once, then filters each window", async () => {
    const service = new SubtitleService();
    const load = vi.fn().mockResolvedValue({
      filename: "Movie.cs.srt",
      content:
        "1\n00:00:01,000 --> 00:00:03,000\nFirst\n\n2\n00:02:01,000 --> 00:02:03,000\nSecond\n",
    });
    const base = {
      mediaIdentity: "webshare:abc:grant-1",
      trackId: "external:file-1",
      fileId: "file-1",
      movieDurationMs: 240_000,
      load,
    };
    expect(
      (await service.getExternalWindow({ ...base, startMs: 0 })).cues.map(
        (cue) => cue.text,
      ),
    ).toEqual(["First"]);
    expect(
      (await service.getExternalWindow({ ...base, startMs: 120_000 })).cues.map(
        (cue) => cue.text,
      ),
    ).toEqual(["Second"]);
    expect(load).toHaveBeenCalledTimes(1);
    service.close();
  });

  it("skips FFmpeg for an empty indexed MKV window and caps a populated window by packet count", async () => {
    const service = new SubtitleService();
    const extract = vi
      .fn()
      .mockResolvedValue(
        Buffer.from("WEBVTT\n\n00:05:00.000 --> 00:05:04.000\nMiddle\n"),
      );
    const scanPackets = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);
    const base = {
      mediaIdentity: "media-1",
      trackId: "embedded:2",
      sourceUrl: "https://source.example/private",
      streamIndex: 2,
      movieDurationMs: 600_000,
      scanPackets,
      extract,
    };
    expect(
      (await service.getEmbeddedWindow({ ...base, startMs: 360_000 })).cues,
    ).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
    expect(
      (await service.getEmbeddedWindow({ ...base, startMs: 300_000 })).cues,
    ).toEqual([{ startMs: 300_000, endMs: 304_000, text: "Middle" }]);
    expect(extract).toHaveBeenCalledWith(
      base.sourceUrl,
      2,
      230_000,
      130_000,
      expect.any(AbortSignal),
      1,
    );
    service.close();
  });

  it("cancels an abandoned embedded extraction", async () => {
    const service = new SubtitleService();
    const controller = new AbortController();
    const extract = vi.fn(
      (
        _url: string,
        _track: number,
        _seek: number,
        _duration: number,
        signal: AbortSignal,
      ) =>
        new Promise<Buffer>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        ),
    );
    const pending = service.getEmbeddedWindow({
      mediaIdentity: "media-1",
      trackId: "embedded:2",
      sourceUrl: "https://source.example/private",
      streamIndex: 2,
      startMs: 120_000,
      movieDurationMs: 600_000,
      extract,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      failureCode: "PROCESS_CANCELLED",
    });
    await vi.waitFor(() => expect(service.stats.activeJobs).toBe(0));
    service.close();
  });
});
