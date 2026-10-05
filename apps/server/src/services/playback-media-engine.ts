import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  PlaybackMediaInfoSchema,
  SUBTITLE_WINDOW_OVERLAP_SECONDS,
  SUBTITLE_WINDOW_SECONDS,
  type PlaybackMediaInfo,
} from "@streamer-ai/contracts";

export type { PlaybackMediaInfo } from "@streamer-ai/contracts";

export interface PlaybackMediaStream {
  body: Readable;
  stop(): void;
  completion?: Promise<PlaybackStreamOutcome>;
}

export interface PlaybackStreamOutcome {
  status: "ended" | "cancelled" | "failed";
  exitCode: number | null;
  bytes: number;
}

export type PlaybackMediaFailureCode =
  | "PROCESS_UNAVAILABLE"
  | "PROCESS_TIMEOUT"
  | "PROCESS_OUTPUT_TOO_LARGE"
  | "PROCESS_EXIT_NONZERO"
  | "NO_VIDEO_STREAM";

/** Fixed diagnostic codes only: never preserve FFmpeg stderr or source URLs. */
export class PlaybackMediaError extends Error {
  constructor(
    readonly failureCode: PlaybackMediaFailureCode,
    readonly exitCode: number | null = null,
  ) {
    super(failureCode);
    this.name = "PlaybackMediaError";
  }
}

export interface PlaybackMediaEngine {
  probe(sourceUrl: string): Promise<PlaybackMediaInfo>;
  stream(
    sourceUrl: string,
    info: PlaybackMediaInfo,
    audioStreamIndex: number | null,
    startSeconds: number,
  ): PlaybackMediaStream;
  thumbnail(sourceUrl: string, atSeconds: number): Promise<Buffer>;
  subtitle(
    sourceUrl: string,
    streamIndex: number,
    windowStart: number,
  ): Promise<Buffer>;
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  channels?: number;
  channel_layout?: string;
  tags?: { language?: string; title?: string };
}

const TEXT_SUBTITLE_CODECS = new Set([
  "subrip",
  "ass",
  "ssa",
  "webvtt",
  "mov_text",
  "text",
  "ttml",
]);

function safeText(value: unknown, maxLength = 80): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : null;
}

function runBuffered(
  command: string,
  args: string[],
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error: Error | null, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new PlaybackMediaError("PROCESS_TIMEOUT"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        finish(new PlaybackMediaError("PROCESS_OUTPUT_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () =>
      finish(new PlaybackMediaError("PROCESS_UNAVAILABLE")),
    );
    child.on("close", (code) => {
      if (code !== 0)
        finish(new PlaybackMediaError("PROCESS_EXIT_NONZERO", code));
      else finish(null, Buffer.concat(chunks));
    });
  });
}

/** FFmpeg runs without a shell; provider URLs never appear in command logs. */
export class FfmpegPlaybackMediaEngine implements PlaybackMediaEngine {
  constructor(
    private readonly ffmpeg = process.env.STREAMERAI_FFMPEG_PATH || "ffmpeg",
    private readonly ffprobe = process.env.STREAMERAI_FFPROBE_PATH || "ffprobe",
  ) {}

  async probe(sourceUrl: string): Promise<PlaybackMediaInfo> {
    const output = await runBuffered(
      this.ffprobe,
      [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        sourceUrl,
      ],
      512 * 1024,
      25_000,
    );
    const parsed = JSON.parse(output.toString("utf8")) as {
      streams?: ProbeStream[];
      format?: { duration?: string };
    };
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const video = streams.find(
      (item) => item.codec_type === "video" && Number.isInteger(item.index),
    );
    if (!video?.codec_name || video.index === undefined) {
      throw new PlaybackMediaError("NO_VIDEO_STREAM");
    }
    const rawDuration = Number(parsed.format?.duration);
    const durationSeconds =
      Number.isFinite(rawDuration) &&
      rawDuration > 0 &&
      rawDuration <= 24 * 3600
        ? rawDuration
        : null;
    return PlaybackMediaInfoSchema.parse({
      durationSeconds,
      videoCodec: video.codec_name,
      videoPixelFormat: safeText(video.pix_fmt),
      audioTracks: streams
        .filter(
          (item) => item.codec_type === "audio" && Number.isInteger(item.index),
        )
        .slice(0, 20)
        .map((item) => ({
          streamIndex: item.index!,
          codec: safeText(item.codec_name) ?? "unknown",
          channels: Number.isInteger(item.channels)
            ? Math.max(1, Math.min(item.channels!, 8))
            : 2,
          channelLayout: safeText(item.channel_layout),
          language: safeText(item.tags?.language, 16),
          title: safeText(item.tags?.title),
        })),
      subtitleTracks: streams
        .filter(
          (item) =>
            item.codec_type === "subtitle" &&
            Number.isInteger(item.index) &&
            TEXT_SUBTITLE_CODECS.has(item.codec_name ?? ""),
        )
        .slice(0, 20)
        .map((item) => ({
          streamIndex: item.index!,
          codec: item.codec_name!,
          language: safeText(item.tags?.language, 16),
          title: safeText(item.tags?.title),
        })),
    });
  }

  stream(
    sourceUrl: string,
    info: PlaybackMediaInfo,
    audioStreamIndex: number | null,
    startSeconds: number,
  ): PlaybackMediaStream {
    const audioTrack = info.audioTracks.find(
      (item) => item.streamIndex === audioStreamIndex,
    );
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
    if (startSeconds > 0) args.push("-ss", startSeconds.toFixed(3));
    args.push("-i", sourceUrl, "-map", "0:v:0", "-sn", "-dn");
    if (audioTrack) {
      args.push(
        "-map",
        `0:${audioTrack.streamIndex}`,
        "-c:a",
        "aac",
        // Browser/device decoders vary on multichannel AAC. Decode every
        // source layout, but downmix 2.1/5.1/7.1 tracks to audible stereo.
        ...(audioTrack.channels > 2 ? ["-ac", "2"] : []),
        "-b:a",
        `${audioTrack.channels > 2 ? 192 : Math.max(128, audioTrack.channels * 96)}k`,
      );
    } else {
      args.push("-an");
    }
    if (
      info.videoCodec === "h264" &&
      ["yuv420p", "yuvj420p", null].includes(info.videoPixelFormat)
    ) {
      args.push("-c:v", "copy");
    } else {
      args.push(
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
      );
    }
    args.push(
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration",
      "1000000",
      "-f",
      "mp4",
      "pipe:1",
    );
    const child = spawn(this.ffmpeg, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let cancelled = false;
    let failedToSpawn = false;
    let endedOutput = false;
    let bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    child.stdout.on("end", () => {
      endedOutput = true;
    });
    const completion = new Promise<PlaybackStreamOutcome>((resolve) => {
      child.on("error", () => {
        failedToSpawn = true;
        child.stdout.destroy();
      });
      child.on("close", (code) => {
        resolve({
          status: cancelled
            ? "cancelled"
            : failedToSpawn || code !== 0
              ? "failed"
              : "ended",
          exitCode: code,
          bytes,
        });
      });
    });
    return {
      body: child.stdout,
      completion,
      stop: () => {
        if (endedOutput) return;
        cancelled = true;
        if (!child.killed) child.kill();
      },
    };
  }

  thumbnail(sourceUrl: string, atSeconds: number): Promise<Buffer> {
    return runBuffered(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        atSeconds.toFixed(3),
        "-i",
        sourceUrl,
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-q:v",
        "6",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "pipe:1",
      ],
      512 * 1024,
      25_000,
    );
  }

  subtitle(
    sourceUrl: string,
    streamIndex: number,
    windowStart: number,
  ): Promise<Buffer> {
    const seekStart = Math.max(
      0,
      windowStart - SUBTITLE_WINDOW_OVERLAP_SECONDS,
    );
    return runBuffered(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-ss",
        seekStart.toFixed(3),
        // Subtitle-only extraction still reads the interleaved remote media.
        // Keep each seek short, and let FFmpeg emit segment-relative cues.
        "-t",
        String(SUBTITLE_WINDOW_SECONDS + 2 * SUBTITLE_WINDOW_OVERLAP_SECONDS),
        "-i",
        sourceUrl,
        "-map",
        `0:${streamIndex}`,
        "-c:s",
        "webvtt",
        "-f",
        "webvtt",
        "pipe:1",
      ],
      1024 * 1024,
      24_000,
    );
  }
}
