import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import {
  PlaybackMediaInfoSchema,
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
  timedOut?: boolean;
}

export type PlaybackMediaFailureCode =
  | "PROCESS_UNAVAILABLE"
  | "PROCESS_TIMEOUT"
  | "PROCESS_CANCELLED"
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
    seekStartMs: number,
    durationMs: number,
    signal?: AbortSignal,
    maxCues?: number,
  ): Promise<Buffer>;
  subtitlePacketCount?(
    sourceUrl: string,
    streamIndex: number,
    seekStartMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<number>;
}

interface ProbeStream {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  pix_fmt?: string;
  channels?: number;
  channel_layout?: string;
  tags?: { language?: string; title?: string };
  disposition?: {
    default?: number;
    forced?: number;
    hearing_impaired?: number;
  };
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
  signal?: AbortSignal,
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
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result ?? Buffer.alloc(0));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new PlaybackMediaError("PROCESS_TIMEOUT"));
    }, timeoutMs);
    const abort = () => {
      child.kill();
      finish(new PlaybackMediaError("PROCESS_CANCELLED"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
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

export function playbackMediaArguments(
  sourceUrl: string,
  info: PlaybackMediaInfo,
  audioStreamIndex: number | null,
  startSeconds: number,
): string[] {
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
    startSeconds === 0 &&
    info.videoCodec === "h264" &&
    ["yuv420p", "yuvj420p", null].includes(info.videoPixelFormat)
  ) {
    args.push("-c:v", "copy");
  } else {
    // Input-side -ss preserves pre-roll up to the preceding keyframe when
    // copying video, while transcoded audio starts at the requested time.
    // Encoding video on seeks lets FFmpeg discard that pre-roll for both.
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
  return args;
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
      format?: { duration?: string; format_name?: string };
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
      container: safeText(parsed.format?.format_name),
      videoTracks: streams
        .filter(
          (item) => item.codec_type === "video" && Number.isInteger(item.index),
        )
        .slice(0, 20)
        .map((item) => ({
          streamIndex: item.index!,
          codec: safeText(item.codec_name) ?? "unknown",
          pixelFormat: safeText(item.pix_fmt),
          language: safeText(item.tags?.language, 16),
          title: safeText(item.tags?.title),
        })),
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
          source: "embedded",
          kind: "text",
          default: item.disposition?.default === 1,
          forced: item.disposition?.forced === 1,
          hearingImpaired: item.disposition?.hearing_impaired === 1,
        })),
    });
  }

  stream(
    sourceUrl: string,
    info: PlaybackMediaInfo,
    audioStreamIndex: number | null,
    startSeconds: number,
  ): PlaybackMediaStream {
    const args = playbackMediaArguments(
      sourceUrl,
      info,
      audioStreamIndex,
      startSeconds,
    );
    const child = spawn(this.ffmpeg, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let cancelled = false;
    let failedToSpawn = false;
    let closed = false;
    let timedOut = false;
    let bytes = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 180_000);
      idleTimer.unref();
    };
    resetIdleTimer();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      resetIdleTimer();
    });
    const completion = new Promise<PlaybackStreamOutcome>((resolve) => {
      child.on("error", () => {
        failedToSpawn = true;
        child.stdout.destroy();
      });
      child.on("close", (code) => {
        closed = true;
        clearTimeout(idleTimer);
        resolve({
          status:
            timedOut || failedToSpawn || (!cancelled && code !== 0)
              ? "failed"
              : cancelled
                ? "cancelled"
                : "ended",
          exitCode: code,
          bytes,
          timedOut,
        });
      });
    });
    return {
      body: child.stdout,
      completion,
      stop: () => {
        if (closed) return;
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
    seekStartMs: number,
    durationMs: number,
    signal?: AbortSignal,
    maxCues?: number,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(seekStartMs) ||
      seekStartMs < 0 ||
      !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 ||
      durationMs > 310_000 ||
      (maxCues !== undefined &&
        (!Number.isSafeInteger(maxCues) || maxCues < 1 || maxCues > 10_000))
    )
      throw new PlaybackMediaError("PROCESS_EXIT_NONZERO");
    return runBuffered(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        // Keep subtitle packet timestamps in absolute movie time.
        "-copyts",
        // Input-side seeking lets libavformat use the source's byte index.
        "-ss",
        (seekStartMs / 1000).toFixed(3),
        "-i",
        sourceUrl,
        "-map",
        `0:${streamIndex}`,
        "-vn",
        "-an",
        "-dn",
        // With -copyts, output-side -t can stop at the wrong absolute time.
        "-to",
        ((seekStartMs + durationMs) / 1000).toFixed(3),
        ...(maxCues === undefined ? [] : ["-frames:s", String(maxCues)]),
        "-c:s",
        "webvtt",
        "-f",
        "webvtt",
        "pipe:1",
      ],
      2 * 1024 * 1024,
      45_000,
      signal,
    );
  }

  async subtitlePacketCount(
    sourceUrl: string,
    streamIndex: number,
    seekStartMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<number> {
    const output = await runBuffered(
      this.ffprobe,
      [
        "-v",
        "error",
        // Keep all streams in the demux loop: selecting only sparse subtitles
        // can make ffprobe read through a long silent tail.
        "-read_intervals",
        `${(seekStartMs / 1000).toFixed(3)}%${(endMs / 1000).toFixed(3)}`,
        "-show_packets",
        "-show_entries",
        "packet=stream_index,pts_time,duration_time",
        "-of",
        "json",
        sourceUrl,
      ],
      8 * 1024 * 1024,
      45_000,
      signal,
    );
    const parsed = JSON.parse(output.toString("utf8")) as {
      packets?: Array<{
        stream_index?: number;
        pts_time?: string;
        duration_time?: string;
      }>;
    };
    if (!Array.isArray(parsed.packets))
      throw new PlaybackMediaError("PROCESS_EXIT_NONZERO");
    let count = 0;
    for (const packet of parsed.packets) {
      if (packet.stream_index !== streamIndex) continue;
      const startMs = Number(packet.pts_time) * 1000;
      const durationMs = Number(packet.duration_time) * 1000;
      if (!Number.isFinite(startMs))
        throw new PlaybackMediaError("PROCESS_EXIT_NONZERO");
      const packetEndMs =
        startMs + (Number.isFinite(durationMs) ? Math.max(1, durationMs) : 1);
      if (startMs < endMs && packetEndMs > seekStartMs) count++;
      if (count > 10_000)
        throw new PlaybackMediaError("PROCESS_OUTPUT_TOO_LARGE");
    }
    return count;
  }
}
