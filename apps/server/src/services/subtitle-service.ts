import { PlaybackMediaError } from "./playback-media-engine.js";
import type { SubtitleCue, SubtitleWindow } from "@streamer-ai/contracts";

export const DEFAULT_SUBTITLE_WINDOW_MS = 120_000;
export const MIN_SUBTITLE_WINDOW_MS = 30_000;
export const MAX_SUBTITLE_WINDOW_MS = 300_000;
const SEEK_LOOKBACK_MS = 10_000;
const CACHE_LIMIT_BYTES = 32 * 1024 * 1024;
const MAX_ACTIVE_JOBS = 2;
const CONVERTER_VERSION = "subtitle-window-v1";

export class SubtitleServiceError extends Error {
  constructor(
    readonly code: "INVALID_WINDOW" | "BUSY" | "INVALID_SUBTITLE",
    readonly statusCode: 400 | 429 | 502,
  ) {
    super(code);
    this.name = "SubtitleServiceError";
  }
}

export interface CanonicalSubtitleWindow {
  startMs: number;
  endMs: number;
}

/** The requested position identifies an aligned window; duration is in ms. */
export function canonicalSubtitleWindow(
  startMs: number,
  durationMs = DEFAULT_SUBTITLE_WINDOW_MS,
  movieDurationMs: number | null = null,
): CanonicalSubtitleWindow {
  if (
    !Number.isSafeInteger(startMs) ||
    startMs < 0 ||
    startMs >= 86_400_000 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < MIN_SUBTITLE_WINDOW_MS ||
    durationMs > MAX_SUBTITLE_WINDOW_MS ||
    (movieDurationMs !== null &&
      (!Number.isFinite(movieDurationMs) ||
        movieDurationMs <= 0 ||
        startMs >= movieDurationMs))
  ) {
    throw new SubtitleServiceError("INVALID_WINDOW", 400);
  }
  const canonicalStart = Math.floor(startMs / durationMs) * durationMs;
  return {
    startMs: canonicalStart,
    endMs:
      movieDurationMs === null
        ? canonicalStart + durationMs
        : Math.min(canonicalStart + durationMs, Math.ceil(movieDurationMs)),
  };
}

export function cueOverlaps(
  cue: SubtitleCue,
  window: CanonicalSubtitleWindow,
): boolean {
  return cue.endMs > window.startMs && cue.startMs < window.endMs;
}

function timestampMs(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{2,3})$/.exec(value.trim());
  if (!match) return null;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (minutes > 59 || seconds > 59) return null;
  const fraction = match[4]!.padEnd(3, "0");
  return (
    (Number(match[1] ?? 0) * 3600 + minutes * 60 + seconds) * 1000 +
    Number(fraction)
  );
}

function plainText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/gi, "&")
    .trim();
}

export function normalizeSubtitleCues(
  cues: readonly SubtitleCue[],
): SubtitleCue[] {
  const seen = new Set<string>();
  const result: SubtitleCue[] = [];
  for (const cue of cues) {
    if (
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs ||
      !cue.text.trim()
    )
      continue;
    const normalized: SubtitleCue = {
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text.trim().slice(0, 4000),
      ...(cue.settings ? { settings: cue.settings.slice(0, 200) } : {}),
    };
    const key = `${normalized.startMs}\u0000${normalized.endMs}\u0000${normalized.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length > 10_000) {
      throw new SubtitleServiceError("INVALID_SUBTITLE", 502);
    }
  }
  return result.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function parseWebVtt(raw: string): SubtitleCue[] {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:\s|$)/.test(text)) {
    throw new SubtitleServiceError("INVALID_SUBTITLE", 502);
  }
  const cues: SubtitleCue[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const match = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+(.*))?$/.exec(lines[index]!);
    if (!match) continue;
    const startMs = timestampMs(match[1]!);
    const endMs = timestampMs(match[2]!);
    const cueText = plainText(lines.slice(index + 1).join("\n"));
    if (startMs === null || endMs === null || !cueText) continue;
    cues.push({
      startMs,
      endMs,
      text: cueText,
      ...(match[3] ? { settings: match[3].trim() } : {}),
    });
  }
  return normalizeSubtitleCues(cues);
}

export function parseSrt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const match = /^\s*(\S+)\s+-->\s+(\S+)/.exec(lines[index]!);
    if (!match) continue;
    const startMs = timestampMs(match[1]!);
    const endMs = timestampMs(match[2]!);
    const cueText = plainText(lines.slice(index + 1).join("\n"));
    if (startMs !== null && endMs !== null && cueText) {
      cues.push({ startMs, endMs, text: cueText });
    }
  }
  return normalizeSubtitleCues(cues);
}

export function parseAss(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let fields: string[] = [];
  for (const line of raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const trimmed = line.trim();
    if (/^\[Events\]$/i.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (/^\[/.test(trimmed)) inEvents = false;
    if (!inEvents) continue;
    if (/^Format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((part) => part.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line) || fields.length === 0) continue;
    const parts = line.slice(line.indexOf(":") + 1).split(",");
    if (parts.length < fields.length) continue;
    const values = [
      ...parts.slice(0, fields.length - 1),
      parts.slice(fields.length - 1).join(","),
    ];
    const startMs = timestampMs(values[fields.indexOf("start")] ?? "");
    const endMs = timestampMs(values[fields.indexOf("end")] ?? "");
    const cueText = plainText(
      (values[fields.indexOf("text")] ?? "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\\[Nn]/g, "\n")
        .replace(/\\h/g, " "),
    );
    if (startMs !== null && endMs !== null && cueText) {
      cues.push({ startMs, endMs, text: cueText });
    }
  }
  return normalizeSubtitleCues(cues);
}

export function parseExternalSubtitle(
  filename: string,
  content: string,
): SubtitleCue[] {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  switch (extension) {
    case "srt":
      return parseSrt(content);
    case "vtt":
      return parseWebVtt(content);
    case "ass":
    case "ssa":
      return parseAss(content);
    default:
      throw new SubtitleServiceError("INVALID_SUBTITLE", 502);
  }
}

interface Job<T> {
  controller: AbortController;
  promise: Promise<T>;
  subscribers: number;
}

export class SubtitleService {
  readonly #windows = new Map<
    string,
    { value: SubtitleWindow; bytes: number }
  >();
  readonly #external = new Map<
    string,
    { value: SubtitleCue[]; bytes: number }
  >();
  readonly #jobs = new Map<string, Job<SubtitleWindow | SubtitleCue[]>>();
  #cachedBytes = 0;
  #cacheHits = 0;
  #cacheMisses = 0;

  constructor(private readonly maxCacheBytes = CACHE_LIMIT_BYTES) {}

  get stats() {
    return {
      cachedBytes: this.#cachedBytes,
      cacheEntries: this.#windows.size + this.#external.size,
      activeJobs: this.#jobs.size,
      cacheHits: this.#cacheHits,
      cacheMisses: this.#cacheMisses,
    };
  }

  async getEmbeddedWindow(input: {
    mediaIdentity: string;
    trackId: string;
    sourceUrl: string;
    streamIndex: number;
    startMs: number;
    durationMs?: number;
    movieDurationMs: number | null;
    extract: (
      sourceUrl: string,
      streamIndex: number,
      seekStartMs: number,
      durationMs: number,
      signal: AbortSignal,
      maxCues?: number,
    ) => Promise<Buffer>;
    scanPackets?: (
      sourceUrl: string,
      streamIndex: number,
      seekStartMs: number,
      endMs: number,
      signal: AbortSignal,
    ) => Promise<number>;
    signal?: AbortSignal;
  }): Promise<SubtitleWindow> {
    const window = canonicalSubtitleWindow(
      input.startMs,
      input.durationMs,
      input.movieDurationMs,
    );
    const key = `${CONVERTER_VERSION}|${input.mediaIdentity}|${input.trackId}|${window.startMs}|${window.endMs}`;
    const cached = this.#windows.get(key);
    if (cached) {
      this.#cacheHits++;
      this.#windows.delete(key);
      this.#windows.set(key, cached);
      return cached.value;
    }
    this.#cacheMisses++;
    const value = await this.#runJob(
      key,
      async (signal) => {
        const seekStartMs = Math.max(0, window.startMs - SEEK_LOOKBACK_MS);
        const packetCount = input.scanPackets
          ? await input.scanPackets(
              input.sourceUrl,
              input.streamIndex,
              seekStartMs,
              window.endMs,
              signal,
            )
          : undefined;
        if (packetCount === 0) {
          const empty: SubtitleWindow = {
            trackId: input.trackId,
            ...window,
            cues: [],
          };
          this.#remember(this.#windows, key, empty);
          return empty;
        }
        const args = [
          input.sourceUrl,
          input.streamIndex,
          seekStartMs,
          window.endMs - seekStartMs,
          signal,
        ] as const;
        const output =
          packetCount === undefined
            ? await input.extract(...args)
            : await input.extract(...args, packetCount);
        const cues = parseWebVtt(output.toString("utf8")).filter((cue) =>
          cueOverlaps(cue, window),
        );
        const result: SubtitleWindow = {
          trackId: input.trackId,
          ...window,
          cues,
        };
        this.#remember(this.#windows, key, result);
        return result;
      },
      input.signal,
    );
    return value as SubtitleWindow;
  }

  async getExternalWindow(input: {
    mediaIdentity: string;
    trackId: string;
    fileId: string;
    startMs: number;
    durationMs?: number;
    movieDurationMs: number | null;
    load: (
      signal: AbortSignal,
    ) => Promise<{ filename: string; content: string }>;
    signal?: AbortSignal;
  }): Promise<SubtitleWindow> {
    const window = canonicalSubtitleWindow(
      input.startMs,
      input.durationMs,
      input.movieDurationMs,
    );
    const key = `${CONVERTER_VERSION}|${input.mediaIdentity}|external:${input.fileId}`;
    let cached = this.#external.get(key);
    if (!cached) {
      this.#cacheMisses++;
      const cues = (await this.#runJob(
        key,
        async (signal) => {
          const loaded = await input.load(signal);
          const result = parseExternalSubtitle(loaded.filename, loaded.content);
          this.#remember(this.#external, key, result);
          return result;
        },
        input.signal,
      )) as SubtitleCue[];
      cached = this.#external.get(key) ?? { value: cues, bytes: 0 };
    } else {
      this.#cacheHits++;
      this.#external.delete(key);
      this.#external.set(key, cached);
    }
    return {
      trackId: input.trackId,
      ...window,
      cues: cached.value.filter((cue) => cueOverlaps(cue, window)),
    };
  }

  cancelMedia(mediaIdentity: string): void {
    for (const [key, job] of this.#jobs) {
      if (key.includes(`|${mediaIdentity}|`)) job.controller.abort();
    }
  }

  close(): void {
    for (const job of this.#jobs.values()) job.controller.abort();
    this.#windows.clear();
    this.#external.clear();
    this.#cachedBytes = 0;
  }

  async #runJob<T>(
    key: string,
    start: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new PlaybackMediaError("PROCESS_CANCELLED");
    let job = this.#jobs.get(key) as Job<T> | undefined;
    if (!job) {
      if (this.#jobs.size >= MAX_ACTIVE_JOBS)
        throw new SubtitleServiceError("BUSY", 429);
      const controller = new AbortController();
      job = {
        controller,
        subscribers: 0,
        promise: Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return start(controller.signal);
        }),
      };
      this.#jobs.set(key, job as Job<SubtitleWindow | SubtitleCue[]>);
      void job.promise
        .finally(() => {
          if (this.#jobs.get(key) === job) this.#jobs.delete(key);
        })
        .catch(() => undefined);
    }
    job.subscribers += 1;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = (error?: unknown, value?: T) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        job!.subscribers -= 1;
        if (job!.subscribers === 0 && this.#jobs.get(key) === job)
          job!.controller.abort();
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      const abort = () => finish(new PlaybackMediaError("PROCESS_CANCELLED"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void job!.promise.then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
    });
  }

  #remember<T>(
    cache: Map<string, { value: T; bytes: number }>,
    key: string,
    value: T,
  ): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > this.maxCacheBytes) return;
    while (this.#cachedBytes + bytes > this.maxCacheBytes) {
      const firstWindow = this.#windows.keys().next().value;
      if (firstWindow !== undefined) {
        this.#cachedBytes -= this.#windows.get(firstWindow)!.bytes;
        this.#windows.delete(firstWindow);
        continue;
      }
      const firstExternal = this.#external.keys().next().value;
      if (firstExternal === undefined) break;
      this.#cachedBytes -= this.#external.get(firstExternal)!.bytes;
      this.#external.delete(firstExternal);
    }
    cache.set(key, { value, bytes });
    this.#cachedBytes += bytes;
  }
}
