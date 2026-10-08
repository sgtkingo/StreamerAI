import type { PlaybackMediaInfo } from "@streamer-ai/contracts";
import { describe, expect, it } from "vitest";
import { playbackMediaArguments } from "../src/services/playback-media-engine.js";

const info: PlaybackMediaInfo = {
  durationSeconds: 120,
  videoCodec: "h264",
  videoPixelFormat: "yuv420p",
  audioTracks: [
    {
      streamIndex: 1,
      codec: "eac3",
      channels: 6,
      channelLayout: "5.1(side)",
      language: "en",
      title: null,
    },
  ],
  subtitleTracks: [],
};

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

describe("playback FFmpeg arguments", () => {
  it("copies compatible H.264 from the start while encoding the selected audio", () => {
    const args = playbackMediaArguments("source.mkv", info, 1, 0);
    expect(option(args, "-c:v")).toBe("copy");
    expect(option(args, "-c:a")).toBe("aac");
    expect(option(args, "-ac")).toBe("2");
    expect(args).not.toContain("-ss");
  });

  it("decodes both streams at a seek so video does not retain keyframe pre-roll", () => {
    const args = playbackMediaArguments("source.mkv", info, 1, 7.25);
    expect(option(args, "-ss")).toBe("7.250");
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
    expect(option(args, "-c:v")).toBe("libx264");
    expect(option(args, "-c:a")).toBe("aac");
    expect(args).toContain("0:1");
  });

  it("still transcodes incompatible video at the beginning", () => {
    const args = playbackMediaArguments(
      "source.mkv",
      { ...info, videoCodec: "hevc" },
      1,
      0,
    );
    expect(option(args, "-c:v")).toBe("libx264");
  });
});
