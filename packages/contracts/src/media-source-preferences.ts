import { z } from "zod";
import { IntegrationIdSchema } from "./integrations.js";

export const MediaSourcePreferencesSchema = z
  .object({
    mode: z.enum(["auto", "by-order"]).default("auto"),
    requireSeeking: z.boolean().default(false),
    requireDirectPlay: z.boolean().default(false),
    providerOrder: z
      .array(IntegrationIdSchema)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Source IDs must be unique",
      ),
  })
  .strict();
export type MediaSourcePreferences = z.infer<
  typeof MediaSourcePreferencesSchema
>;
export type MediaSourceRankingMode = MediaSourcePreferences["mode"];

/** New sources append predictably; local storage leads until a viewer changes the order. */
export function resolveMediaSourceOrder(
  saved: readonly string[],
  known: readonly string[],
): string[] {
  return [...new Set([...saved, "local-files", ...known])].filter((id) =>
    known.includes(id),
  );
}

export function orderMediaSources<T extends { providerId: string }>(
  sources: readonly T[],
  order: readonly string[],
): T[] {
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? order.length : index;
  };
  return [...sources].sort((a, b) => rank(a.providerId) - rank(b.providerId));
}

/** Auto compares verified files; By Order puts the chosen provider first. */
export function rankMediaSources<
  T extends {
    providerId: string;
    rankingScore?: number;
    format?: { resolution?: string | null };
  },
>(
  sources: readonly T[],
  mode: MediaSourceRankingMode,
  order: readonly string[],
): T[] {
  const providerRank = (source: T) => {
    const index = order.indexOf(source.providerId);
    return index < 0 ? order.length : index;
  };
  return [...sources].sort((a, b) =>
    mode === "by-order"
      ? providerRank(a) - providerRank(b) ||
        mediaSourceRankingScore(b) - mediaSourceRankingScore(a)
      : mediaSourceRankingScore(b) - mediaSourceRankingScore(a),
  );
}

export function mediaSourceRankingScore(source: {
  rankingScore?: number;
  format?: { resolution?: string | null };
}): number {
  if (source.rankingScore !== undefined) return source.rankingScore;
  const resolution = source.format?.resolution?.toLowerCase() ?? "";
  return resolution.includes("2160") || resolution.includes("4k")
    ? 12
    : resolution.includes("1080")
      ? 8
      : resolution.includes("720")
        ? 4
        : 0;
}
