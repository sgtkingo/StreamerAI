export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

function timestampSeconds(raw: string): number | null {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(raw.trim());
  if (!match) return null;
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function plainText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Parse text cues without relying on native track placement under controls. */
export function parseWebVtt(raw: string): SubtitleCue[] {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:\s|$)/.test(normalized))
    throw new Error("The subtitle file is not WebVTT.");
  const cues: SubtitleCue[] = [];
  for (const block of normalized.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex]!.split(/\s+-->\s+/);
    const start = timestampSeconds(timing[0] ?? "");
    const end = timestampSeconds((timing[1] ?? "").split(/\s+/)[0] ?? "");
    const text = plainText(lines.slice(timingIndex + 1).join("\n"));
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function subtitleTextAt(cues: readonly SubtitleCue[], seconds: number): string {
  return cues
    .filter((cue) => cue.start <= seconds && seconds < cue.end)
    .map((cue) => cue.text)
    .join("\n");
}
