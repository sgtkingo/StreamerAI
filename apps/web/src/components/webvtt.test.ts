import { describe, expect, it } from "vitest";
import { parseWebVtt, subtitleTextAt } from "./webvtt";

describe("WebVTT subtitles", () => {
  it("shows the correct cue at an absolute playback position after seeking", () => {
    const cues = parseWebVtt(
      "WEBVTT\n\n1\n00:01:02.500 --> 00:01:04.000 align:start\n<i>Hello</i> &amp; welcome\n\n00:01:04.000 --> 00:01:05.000\nNext line\n",
    );
    expect(subtitleTextAt(cues, 62.7)).toBe("Hello & welcome");
    expect(subtitleTextAt(cues, 64.2)).toBe("Next line");
    expect(subtitleTextAt(cues, 66)).toBe("");
  });

  it("rejects malformed files and ignores empty cue blocks", () => {
    expect(() => parseWebVtt("not subtitles")).toThrow(/WebVTT/);
    expect(
      parseWebVtt("WEBVTT\n\nNOTE hi\n\n00:01.000 --> 00:02.000\n"),
    ).toEqual([]);
  });
});
