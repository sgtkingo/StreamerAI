import { z } from "zod";

const sourceFeedbackFields = z
  .object({
    profileId: z.string().min(1).max(160),
    titleId: z.string().min(1).max(160),
    providerId: z.string().trim().min(1).max(80),
    candidateId: z.string().trim().min(1).max(240),
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    vote: z.enum(["up", "down"]).nullable(),
  })
  .strict();
const hasPairedEpisode = (value: {
  seasonNumber: number | null;
  episodeNumber: number | null;
}) => (value.seasonNumber === null) === (value.episodeNumber === null);

/** A profile's judgement, shared across its account. */
export const SourceFeedbackSchema = sourceFeedbackFields.refine(
  hasPairedEpisode,
  { message: "Episode coordinates must be paired." },
);
export type SourceFeedback = z.infer<typeof SourceFeedbackSchema>;
export const SourceFeedbackRequestSchema = z
  .object({
    sourceId: z.string().regex(/^[a-f0-9]{32}$/),
    vote: z.enum(["up", "down"]).nullable(),
  })
  .strict();
export const SourceFeedbackSettingsSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export const SourceFeedbackResponseSchema = z
  .object({
    enabled: z.boolean(),
    items: z.array(
      sourceFeedbackFields
        .extend({ isOwn: z.boolean() })
        .refine(hasPairedEpisode),
    ),
  })
  .strict();
export type SourceFeedbackResponse = z.infer<
  typeof SourceFeedbackResponseSchema
>;

/** Reserved sync scope; account data is independent of every profile lifecycle. */
export const ACCOUNT_SYNC_SCOPE = "$account";
