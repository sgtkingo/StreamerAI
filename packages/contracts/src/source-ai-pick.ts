import { z } from "zod";
import { EpisodeSelectionSchema, TitleSourceSchema } from "./media.js";

export const SourceAiPickRequestSchema = z
  .object({
    episode: EpisodeSelectionSchema.optional(),
    sources: z.array(TitleSourceSchema).min(1).max(1_000),
  })
  .strict();

export const SourceAiPickResponseSchema = z
  .object({
    sourceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    reason: z.string().trim().min(1).max(600),
    applied: z.boolean(),
  })
  .strict();
export type SourceAiPickResponse = z.infer<typeof SourceAiPickResponseSchema>;

export interface PreferredSourceSelection {
  sourceId: string | null;
  aiPick?: { sourceId: string; reason: string };
}
