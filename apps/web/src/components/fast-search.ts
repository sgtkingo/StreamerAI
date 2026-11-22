import type { MediaAudioTrack, MediaDetails } from "@streamer-ai/contracts";
import type { DirectSearchItem } from "../api/client";

export type FastSearchSortKey =
  | "match"
  | "provider"
  | "source"
  | "name"
  | "format"
  | "video"
  | "audio"
  | "size";
export interface FastSearchSort {
  key: FastSearchSortKey;
  direction: "asc" | "desc";
}
export interface FastSearchFilters {
  sources: string[] | null;
  name: string;
  format: string;
  video: string;
  audio: string;
  minSizeGb: string;
  maxSizeGb: string;
}
export const EMPTY_FILTERS: FastSearchFilters = {
  sources: null,
  name: "",
  format: "",
  video: "",
  audio: "",
  minSizeGb: "",
  maxSizeGb: "",
};

const RESOLUTION_ORDER = ["480p", "576p", "720p", "1080p", "2160p"];
const GB = 1024 ** 3;

export function itemKey(
  item: Pick<DirectSearchItem, "providerId" | "candidateId">,
) {
  return `${item.providerId}:${item.candidateId}`;
}
export function videoLabel(item: DirectSearchItem): string {
  return [item.format.resolution, item.format.videoCodec]
    .filter(Boolean)
    .join(" · ");
}
export function audioLabel(item: DirectSearchItem): string {
  return item.format.audioLanguages
    .map((code) => code.toUpperCase())
    .join(", ");
}
export function formatLabel(item: DirectSearchItem): string {
  return item.format.container?.toUpperCase() ?? "";
}

const CHANNEL_LAYOUTS: Record<number, string> = {
  1: "mono",
  2: "2.0",
  6: "5.1",
  8: "7.1",
};
/** "CS · AC3 2.0" for one measured audio track. */
export function trackLabel(track: MediaAudioTrack): string {
  const layout =
    track.channels === null
      ? ""
      : (CHANNEL_LAYOUTS[track.channels] ?? `${track.channels} ch`);
  return [
    track.language?.toUpperCase() ?? "Unknown language",
    [track.codec, layout].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(" · ");
}
export function durationLabel(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
/** "1920×816 · 7.0 Mbit/s" for the measured picture. */
export function pictureLabel(details: MediaDetails | undefined): string {
  if (!details) return "";
  return [
    details.width && details.height ? `${details.width}×${details.height}` : "",
    details.bitrate ? `${(details.bitrate / 1_000_000).toFixed(1)} Mbit/s` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Distinct values offered by the column filters, from the current results. */
export function filterOptions(items: DirectSearchItem[]) {
  const unique = (values: string[]) =>
    [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    formats: unique(items.map(formatLabel)),
    videos: [...new Set(items.map((item) => item.format.resolution ?? ""))]
      .filter(Boolean)
      .sort(
        (a, b) => RESOLUTION_ORDER.indexOf(b) - RESOLUTION_ORDER.indexOf(a),
      ),
    audio: unique(
      items.flatMap((item) =>
        item.format.audioLanguages.map((code) => code.toUpperCase()),
      ),
    ),
  };
}

export function filterItems(
  items: DirectSearchItem[],
  filters: FastSearchFilters,
): DirectSearchItem[] {
  const words = filters.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const min = Number.parseFloat(filters.minSizeGb.replace(",", "."));
  const max = Number.parseFloat(filters.maxSizeGb.replace(",", "."));
  return items.filter((item) => {
    if (filters.sources && !filters.sources.includes(item.providerId))
      return false;
    if (words.length) {
      const name = item.releaseName
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "");
      if (!words.every((word) => name.includes(word))) return false;
    }
    if (filters.format && formatLabel(item) !== filters.format) return false;
    if (filters.video && item.format.resolution !== filters.video) return false;
    if (
      filters.audio &&
      !item.format.audioLanguages.some(
        (code) => code.toUpperCase() === filters.audio,
      )
    )
      return false;
    if (Number.isFinite(min) || Number.isFinite(max)) {
      if (item.sizeBytes === null) return false;
      if (Number.isFinite(min) && item.sizeBytes < min * GB) return false;
      if (Number.isFinite(max) && item.sizeBytes > max * GB) return false;
    }
    return true;
  });
}

/**
 * "match" ranks by similarity to the query; "provider" keeps each source's own
 * order and interleaves sources rank by rank. Ties fall back to those orders.
 */
export function sortItems(
  items: DirectSearchItem[],
  sort: FastSearchSort,
  providerOrder: string[],
): DirectSearchItem[] {
  const providerIndex = (item: DirectSearchItem) => {
    const index = providerOrder.indexOf(item.providerId);
    return index < 0 ? providerOrder.length : index;
  };
  const byProvider = (a: DirectSearchItem, b: DirectSearchItem) =>
    a.providerRank - b.providerRank || providerIndex(a) - providerIndex(b);
  const byMatch = (a: DirectSearchItem, b: DirectSearchItem) =>
    b.similarity - a.similarity || byProvider(a, b);
  const sign = sort.direction === "asc" ? 1 : -1;
  const compare = (a: DirectSearchItem, b: DirectSearchItem): number => {
    switch (sort.key) {
      case "match":
        return byMatch(a, b);
      case "provider":
        return byProvider(a, b);
      case "source":
        return sign * (providerIndex(a) - providerIndex(b)) || byProvider(a, b);
      case "name":
        return (
          sign * a.releaseName.localeCompare(b.releaseName) || byMatch(a, b)
        );
      case "format":
        return (
          sign * formatLabel(a).localeCompare(formatLabel(b)) || byMatch(a, b)
        );
      case "video":
        return (
          sign *
            (RESOLUTION_ORDER.indexOf(a.format.resolution ?? "") -
              RESOLUTION_ORDER.indexOf(b.format.resolution ?? "")) ||
          byMatch(a, b)
        );
      case "audio":
        return (
          sign * audioLabel(a).localeCompare(audioLabel(b)) || byMatch(a, b)
        );
      case "size":
        return (
          sign * ((a.sizeBytes ?? -1) - (b.sizeBytes ?? -1)) || byMatch(a, b)
        );
    }
  };
  return [...items].sort(compare);
}
