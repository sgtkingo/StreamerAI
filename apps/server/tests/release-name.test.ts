import { describe, expect, it } from "vitest";
import {
  formatFromMeasuredMedia,
  languageCode,
  resolutionClass,
  videoCodecName,
} from "../src/integrations/release-name.js";

describe("measured media formats", () => {
  it("classifies widescreen and cropped pictures by width", () => {
    expect(resolutionClass(1920, 816)).toBe("1080p");
    expect(resolutionClass(3840, 1600)).toBe("2160p");
    expect(resolutionClass(1280, 536)).toBe("720p");
    expect(resolutionClass(1024, 576)).toBe("576p");
    expect(resolutionClass(720, 400)).toBe("480p");
    expect(resolutionClass(null, null)).toBeNull();
  });

  it("normalizes codec names and ISO 639-2 language tags", () => {
    expect(videoCodecName("H264")).toBe("H.264");
    expect(videoCodecName("HEVC")).toBe("H.265");
    expect(videoCodecName("XVID")).toBe("MPEG-4");
    expect(videoCodecName("av1")).toBe("AV1");
    expect(languageCode("CZE")).toBe("cs");
    expect(languageCode("ENG")).toBe("en");
    expect(languageCode("slo")).toBe("sk");
    expect(languageCode("und")).toBeNull();
    expect(languageCode("")).toBeNull();
  });

  it("trusts tagged tracks over the name and keeps the name's hint for untagged ones", () => {
    const media = {
      durationSeconds: 100,
      width: 1920,
      height: 1080,
      bitrate: null,
      videoCodec: "HEVC",
    };
    // The name claims CZ, but every track is tagged English.
    expect(
      formatFromMeasuredMedia("Film.2020.CZ.mkv", "mkv", {
        ...media,
        audio: [{ codec: "AAC", channels: 2, language: "ENG" }],
      }).audioLanguages,
    ).toEqual(["en"]);
    // An untagged track may be the CZ dub the name mentions.
    expect(
      formatFromMeasuredMedia("Film.2020.CZ.mkv", "mkv", {
        ...media,
        audio: [
          { codec: "AAC", channels: 2, language: "ENG" },
          { codec: "AC3", channels: 6, language: null },
        ],
      }).audioLanguages,
    ).toEqual(["en", "cs"]);
    expect(
      formatFromMeasuredMedia("Film.2020.720p.x264.mkv", "mkv", null),
    ).not.toHaveProperty("details");
  });
});
