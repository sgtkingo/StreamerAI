import type { SubtitleWindow } from "@streamer-ai/contracts";
import type { SubtitleCue } from "./webvtt";

export const SUBTITLE_WINDOW_MS = 120_000;

export function canonicalSubtitleWindowStart(seconds: number): number {
  const milliseconds = Number.isFinite(seconds)
    ? Math.max(0, Math.floor(seconds * 1_000))
    : 0;
  return Math.floor(milliseconds / SUBTITLE_WINDOW_MS) * SUBTITLE_WINDOW_MS;
}

export function parseSubtitleWindow(
  value: unknown,
  requestedStartMs: number,
): SubtitleWindow {
  if (!value || typeof value !== "object")
    throw new Error("Invalid subtitle window.");
  const window = value as Partial<SubtitleWindow>;
  if (
    typeof window.trackId !== "string" ||
    window.startMs !== requestedStartMs ||
    typeof window.endMs !== "number" ||
    !Number.isInteger(window.endMs) ||
    window.endMs <= requestedStartMs ||
    window.endMs > requestedStartMs + SUBTITLE_WINDOW_MS ||
    !Array.isArray(window.cues)
  ) {
    throw new Error("Invalid subtitle window.");
  }
  const endMs = window.endMs;
  const cues = window.cues
    .map((cue) => {
      if (
        !cue ||
        !Number.isFinite(cue.startMs) ||
        !Number.isFinite(cue.endMs) ||
        cue.startMs < 0 ||
        cue.endMs <= cue.startMs ||
        typeof cue.text !== "string" ||
        (cue.settings !== undefined && typeof cue.settings !== "string")
      ) {
        throw new Error("Invalid subtitle cue.");
      }
      return cue;
    })
    .filter((cue) => cue.endMs > requestedStartMs && cue.startMs < endMs);
  return {
    trackId: window.trackId,
    startMs: requestedStartMs,
    endMs,
    cues,
  };
}

export function nearbySubtitleCues(
  windows: ReadonlyMap<number, SubtitleWindow>,
  currentStartMs: number,
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const seen = new Set<string>();
  for (const startMs of [
    currentStartMs - SUBTITLE_WINDOW_MS,
    currentStartMs,
    currentStartMs + SUBTITLE_WINDOW_MS,
  ]) {
    for (const cue of windows.get(startMs)?.cues ?? []) {
      const key = JSON.stringify([cue.startMs, cue.endMs, cue.text]);
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push({
        start: cue.startMs / 1_000,
        end: cue.endMs / 1_000,
        text: cue.text,
      });
    }
  }
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
