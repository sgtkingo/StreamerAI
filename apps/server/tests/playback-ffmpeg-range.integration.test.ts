import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { FfmpegPlaybackMediaEngine } from "../src/services/playback-media-engine.js";

const ffmpeg = process.env.STREAMERAI_FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.STREAMERAI_FFPROBE_PATH || "ffprobe";
const hasFfmpeg =
  spawnSync(ffmpeg, ["-version"], { windowsHide: true }).status === 0 &&
  spawnSync(ffprobe, ["-version"], { windowsHide: true }).status === 0;

interface ProcessResult {
  stdout: string;
  stderr: string;
}

function run(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolvePromise(result);
      else
        rejectPromise(new Error(`${command} exited ${code}: ${result.stderr}`));
    });
  });
}

interface RangeRead {
  start: number;
  bytesRead: number;
}

function expectCueTime(
  output: string,
  expectedStartMs: number,
  expectedEndMs: number,
) {
  const lines = output.split(/\r?\n/).filter((line) => line.includes(" --> "));
  expect(lines).toHaveLength(1);
  const [start, end] = lines[0]!.split(" --> ");
  const toMs = (timestamp: string) => {
    const parts = timestamp.split(":").map(Number);
    return Math.round(
      parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000,
    );
  };
  // Encoder priming may shift the container timeline by a few milliseconds.
  expect(Math.abs(toMs(start!) - expectedStartMs)).toBeLessThan(100);
  expect(Math.abs(toMs(end!) - expectedEndMs)).toBeLessThan(100);
}

describe.skipIf(!hasFfmpeg)("FFmpeg subtitle windows over HTTP Range", () => {
  const mediaEngine = new FfmpegPlaybackMediaEngine(ffmpeg, ffprobe);
  let fixtureDir: string;
  let server: Server;
  let port: number;
  const sizes = new Map<string, number>();
  const reads: RangeRead[] = [];
  let delayedRequests = 0;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "streamer-ffmpeg-range-"));
    const srtPath = join(fixtureDir, "fixture.srt");
    const assPath = join(fixtureDir, "fixture.ass");
    const mkvPath = join(fixtureDir, "fixture.mkv");
    const mp4Path = join(fixtureDir, "fixture.mp4");
    await writeFile(
      srtPath,
      "1\n00:00:10,000 --> 00:00:12,000\nEarly SRT\n\n" +
        "2\n00:01:59,000 --> 00:02:03,000\nCross SRT\n\n" +
        "3\n00:05:00,000 --> 00:05:04,000\nMiddle SRT\n\n" +
        "4\n00:09:49,000 --> 00:09:53,000\nLate SRT\n",
    );
    await writeFile(
      assPath,
      "[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n" +
        "[V4+ Styles]\n" +
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n" +
        "Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n" +
        "[Events]\n" +
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n" +
        "Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Early {\\i1}ASS{\\i0}\n" +
        "Dialogue: 0,0:01:59.00,0:02:03.00,Default,,0,0,0,,Cross\\NASS\n" +
        "Dialogue: 0,0:05:00.00,0:05:04.00,Default,,0,0,0,,Middle ASS\n" +
        "Dialogue: 0,0:09:49.00,0:09:53.00,Default,,0,0,0,,Late ASS\n",
    );
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000",
      "-i",
      srtPath,
      "-i",
      assPath,
      "-t",
      "600",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "2:s:0",
      "-map",
      "3:s:0",
      "-c:v",
      "mpeg4",
      "-q:v",
      "2",
      "-g",
      "10",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-c:s",
      "copy",
      "-f",
      "matroska",
      mkvPath,
    ]);
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-i",
      mkvPath,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      "-map",
      "0:s:0",
      "-map",
      "0:s:1",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-c:s",
      "mov_text",
      "-movflags",
      "+faststart",
      mp4Path,
    ]);

    for (const ext of ["mkv", "mp4"]) {
      const path = ext === "mkv" ? mkvPath : mp4Path;
      const probe = JSON.parse(
        (
          await run(ffprobe, [
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name",
            "-of",
            "json",
            path,
          ])
        ).stdout,
      ) as { streams: Array<{ index: number; codec_name: string }> };
      expect(probe.streams[2]?.index).toBe(2);
      expect(probe.streams[3]?.index).toBe(3);
      expect(probe.streams[2]?.codec_name).toBe(
        ext === "mkv" ? "subrip" : "mov_text",
      );
      const { size } = await stat(path);
      sizes.set(ext, size);
    }

    server = createServer((request, response) => {
      const ext =
        request.url === "/fixture.mkv" || request.url === "/delayed.mkv"
          ? "mkv"
          : request.url === "/fixture.mp4"
            ? "mp4"
            : null;
      if (!ext) {
        response.writeHead(404).end();
        return;
      }
      const size = sizes.get(ext)!;
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
      const start = match ? Number(match[1]) : 0;
      const end =
        match && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start >= size || end < start) {
        response.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return;
      }
      const read: RangeRead = { start, bytesRead: 0 };
      reads.push(read);
      const serve = () => {
        if (response.destroyed) return;
        response.writeHead(match ? 206 : 200, {
          "content-type": ext === "mkv" ? "video/x-matroska" : "video/mp4",
          "content-length": end - start + 1,
          "accept-ranges": "bytes",
          ...(match
            ? { "content-range": `bytes ${start}-${end}/${size}` }
            : {}),
        });
        const stream = createReadStream(join(fixtureDir, `fixture.${ext}`), {
          start,
          end,
          highWaterMark: 64 * 1024,
        });
        stream.on("data", (chunk: Buffer) => {
          read.bytesRead += chunk.length;
        });
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      };
      if (request.url === "/delayed.mkv") {
        delayedRequests++;
        const timer = setTimeout(serve, 1000);
        response.on("close", () => clearTimeout(timer));
      } else {
        serve();
      }
    });
    await new Promise<void>((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP fixture failed to listen");
    port = address.port;
  }, 60_000);

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolvePromise) =>
        server.close(() => resolvePromise()),
      );
    const target = fixtureDir && resolve(fixtureDir);
    const tempRoot = resolve(tmpdir());
    if (
      target?.startsWith(tempRoot + sep) &&
      basename(target).startsWith("streamer-ffmpeg-range-")
    ) {
      await rm(target, { recursive: true, force: true });
    }
  });

  async function window(
    ext: string,
    stream: number,
    start: number,
    end: number,
  ) {
    reads.length = 0;
    const result = await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-copyts",
      "-ss",
      String(start),
      "-i",
      `http://127.0.0.1:${port}/fixture.${ext}`,
      "-map",
      `0:${stream}`,
      "-to",
      String(end),
      "-c:s",
      "webvtt",
      "-f",
      "webvtt",
      "pipe:1",
    ]);
    return { output: result.stdout, reads: reads.map((read) => ({ ...read })) };
  }

  for (const ext of ["mkv", "mp4"]) {
    it(`keeps sparse ${ext} cues in absolute time and stops at the window end`, async () => {
      const early = await window(ext, 2, 0, 15);
      expectCueTime(early.output, 10_000, 12_000);
      expect(early.output).toContain("Early SRT");
      expect(early.output).not.toContain("Cross SRT");

      // Seek before the requested boundary so an already-active cue can be included.
      const overlapping = await window(ext, 2, 115, 127);
      expectCueTime(overlapping.output, 119_000, 123_000);
      expect(overlapping.output).toContain("Cross SRT");
      expect(overlapping.output).not.toContain("Middle SRT");
      expect(overlapping.output).not.toContain("Late SRT");

      const middle = await window(ext, 2, 295, 310);
      expectCueTime(middle.output, 300_000, 304_000);
      expect(middle.output).toContain("Middle SRT");
      expect(middle.output).not.toContain("Late SRT");

      const late = await window(ext, 2, 585, 600);
      expectCueTime(late.output, 589_000, 593_000);
      expect(late.output).toContain("Late SRT");
      expect(late.output).not.toContain("Middle SRT");
      expect(
        late.reads.some((read) => read.start > sizes.get(ext)! * 0.75),
      ).toBe(true);
      expect(
        late.reads.reduce((total, read) => total + read.bytesRead, 0),
      ).toBeLessThan(sizes.get(ext)! / 2);
      // The previous endpoint extracted a complete subtitle track. Compare
      // actual HTTP bytes, not loopback wall time, which varies by host.
      reads.length = 0;
      const full = await run(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        `http://127.0.0.1:${port}/fixture.${ext}`,
        "-map",
        "0:2",
        "-c:s",
        "webvtt",
        "-f",
        "webvtt",
        "pipe:1",
      ]);
      expect(full.stdout).toContain("Late SRT");
      const fullBytes = reads.reduce(
        (total, read) => total + read.bytesRead,
        0,
      );
      const lateBytes = late.reads.reduce(
        (total, read) => total + read.bytesRead,
        0,
      );
      expect(lateBytes).toBeLessThan(fullBytes / 2);
    }, 30_000);

    it(`converts ${ext} ASS text with absolute times and line breaks`, async () => {
      const result = await window(ext, 3, 115, 127);
      expectCueTime(result.output, 119_000, 123_000);
      expect(result.output).toContain("Cross\nASS");
      expect(result.output).not.toContain("\\N");
      expect(result.output).not.toContain("Middle ASS");
    }, 30_000);
  }

  it("discovers text subtitle streams through the playback engine", async () => {
    for (const ext of ["mkv", "mp4"]) {
      const info = await mediaEngine.probe(
        `http://127.0.0.1:${port}/fixture.${ext}`,
      );
      expect(info.subtitleTracks).toEqual([
        expect.objectContaining({
          streamIndex: 2,
          codec: ext === "mkv" ? "subrip" : "mov_text",
        }),
        expect.objectContaining({
          streamIndex: 3,
          codec: ext === "mkv" ? "ass" : "mov_text",
        }),
      ]);
    }
  }, 30_000);

  it("starts sought H.264 video and AAC audio at the same point", async () => {
    const source = join(fixtureDir, "sync-source.mkv");
    const output = join(fixtureDir, "sync-output.mp4");
    await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "color=c=red:s=64x64:r=5:d=8",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=64x64:r=5:d=4",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000:duration=12",
      "-filter_complex",
      "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map",
      "[v]",
      "-map",
      "2:a:0",
      "-c:v",
      "libx264",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      source,
    ]);
    const info = await mediaEngine.probe(source);
    const media = mediaEngine.stream(
      source,
      info,
      info.audioTracks[0]!.streamIndex,
      9,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of media.body) chunks.push(chunk as Buffer);
    expect((await media.completion)?.status).toBe("ended");
    await writeFile(output, Buffer.concat(chunks));

    const firstFrame = await run(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      output,
      "-frames:v",
      "1",
      "-vf",
      "scale=1:1",
      "-pix_fmt",
      "gray",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    // The keyframe before 9 s is red; the requested frame is blue.
    expect(firstFrame.stdout.charCodeAt(0)).toBeLessThan(55);

    const probed = JSON.parse(
      (
        await run(ffprobe, [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type,start_time",
          "-of",
          "json",
          output,
        ])
      ).stdout,
    ) as { streams: Array<{ codec_type: string; start_time: string }> };
    const videoStart = Number(
      probed.streams.find((stream) => stream.codec_type === "video")
        ?.start_time,
    );
    const audioStart = Number(
      probed.streams.find((stream) => stream.codec_type === "audio")
        ?.start_time,
    );
    expect(Math.abs(videoStart - audioStart)).toBeLessThan(0.2);
  }, 30_000);

  it("bounds empty MKV SubRip windows and limits populated extraction", async () => {
    const url = `http://127.0.0.1:${port}/fixture.mkv`;
    reads.length = 0;
    expect(
      await mediaEngine.subtitlePacketCount(url, 2, 360_000, 480_000),
    ).toBe(0);
    expect(
      reads.reduce((total, read) => total + read.bytesRead, 0),
    ).toBeLessThan(sizes.get("mkv")! / 2);

    reads.length = 0;
    const count = await mediaEngine.subtitlePacketCount(
      url,
      2,
      115_000,
      310_000,
    );
    expect(count).toBe(2);
    reads.length = 0;
    const output = (
      await mediaEngine.subtitle(url, 2, 115_000, 195_000, undefined, count)
    ).toString("utf8");
    const cueLines = output
      .split(/\r?\n/)
      .filter((line) => line.includes(" --> "));
    expect(cueLines).toHaveLength(2);
    expect(cueLines[0]).toMatch(/^01:59\.\d{3} --> 02:03\.\d{3}$/);
    expect(cueLines[1]).toMatch(/^05:00\.\d{3} --> 05:04\.\d{3}$/);
    expect(output).toContain("Cross SRT");
    expect(output).toContain("Middle SRT");
    expect(output).not.toContain("Late SRT");
    // FFmpeg 9 can read farther through a sparse MKV subtitle stream than 5.1;
    // both still stop before consuming the full fixture.
    expect(
      reads.reduce((total, read) => total + read.bytesRead, 0),
    ).toBeLessThan(sizes.get("mkv")! * 0.95);
    reads.length = 0;
    const oneOutput = (
      await mediaEngine.subtitle(url, 2, 230_000, 130_000, undefined, 1)
    ).toString("utf8");
    expect(oneOutput).toContain("Middle SRT");
    expect(oneOutput).not.toContain("Late SRT");
    expect(
      reads.reduce((total, read) => total + read.bytesRead, 0),
    ).toBeLessThan(sizes.get("mkv")! * 0.75);
  }, 30_000);

  it("cancels FFmpeg while a delayed Range request is pending", async () => {
    const controller = new AbortController();
    const pending = mediaEngine.subtitle(
      `http://127.0.0.1:${port}/delayed.mkv`,
      2,
      585_000,
      15_000,
      controller.signal,
    );
    try {
      await vi.waitFor(() => expect(delayedRequests).toBeGreaterThan(0), {
        timeout: 10_000,
      });
    } finally {
      controller.abort();
    }
    await expect(pending).rejects.toMatchObject({
      failureCode: "PROCESS_CANCELLED",
    });
  }, 15_000);
});
