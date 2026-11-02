import { z } from "zod";
import { AppearancePreferencesSchema } from "./appearance.js";
import { SupportedLocaleSchema } from "./locales.js";
import { PlaybackPreferencesSchema } from "./onboarding.js";
import { ACCOUNT_SYNC_SCOPE, SourceFeedbackSchema } from "./source-feedback.js";

export const ACCOUNT_SYNC_VERSION = 1 as const;
const identifier = z.string().min(1).max(160);
const timestamp = z.string().datetime({ offset: true });

/** Only metadata for titles explicitly referenced by user state; never media sources. */
export const AccountSyncTitleSchema = z
  .object({
    id: identifier,
    kind: z.enum(["movie", "series"]),
    title: z.string().min(1).max(240),
    originalTitle: z.string().max(240).nullable(),
    year: z.number().int().min(1870).max(2200).nullable(),
    synopsis: z.string().max(1500),
    genres: z.array(z.string().min(1).max(60)).max(20),
    metadataProvider: z.string().min(1).max(80),
    metadataValidatedAt: timestamp,
  })
  .strict();

/** Device-specific outputs and raw taste/AI prompts intentionally stay local. */
export const AccountSyncProfileSchema = z
  .object({
    name: z.string().min(1).max(80),
    locale: SupportedLocaleSchema,
    genres: z.array(z.string().min(1).max(80)).max(50),
    playback: PlaybackPreferencesSchema.omit({ audioOutputDeviceId: true }),
    appearance: AppearancePreferencesSchema,
    onboardingComplete: z.boolean(),
    sourceFeedbackEnabled: z.boolean().optional(),
  })
  .strict();
export const AccountSyncLibrarySchema = z
  .object({
    title: AccountSyncTitleSchema,
    membershipReason: z.enum(["explicit", "playback"]),
    state: z.enum(["saved", "in-progress", "completed"]),
    progressPercent: z.number().min(0).max(100).nullable(),
    lastPlayedAt: timestamp.nullable(),
  })
  .strict();
export const AccountSyncHistorySchema = z
  .object({
    title: AccountSyncTitleSchema,
    eventType: z.enum(["start", "progress", "stop", "complete"]),
    episodeLabel: z.string().max(120).nullable(),
    progressPercent: z.number().min(0).max(100),
    occurredAt: timestamp,
  })
  .strict();
export const AccountSyncProgressSchema = z
  .object({
    title: AccountSyncTitleSchema,
    seasonNumber: z.number().int().positive().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    positionSeconds: z.number().finite().nonnegative(),
    durationSeconds: z.number().finite().nonnegative(),
    progressPercent: z.number().min(0).max(100),
    sessionId: identifier,
    sessionStartedAt: timestamp,
  })
  .strict()
  .refine(
    (value) => (value.seasonNumber === null) === (value.episodeNumber === null),
    { message: "Episode coordinates must be paired." },
  );

const operationBase = {
  id: z.string().uuid(),
  profileId: identifier,
  entityId: identifier,
  updatedAt: timestamp,
};
export const AccountSyncOperationSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...operationBase,
        kind: z.literal("source-feedback"),
        action: z.enum(["upsert", "delete"]),
        payload: SourceFeedbackSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...operationBase,
        kind: z.literal("profile"),
        action: z.enum(["upsert", "delete"]),
        payload: AccountSyncProfileSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...operationBase,
        kind: z.literal("library"),
        action: z.enum(["upsert", "delete"]),
        payload: AccountSyncLibrarySchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...operationBase,
        kind: z.literal("history"),
        action: z.enum(["upsert", "delete"]),
        payload: AccountSyncHistorySchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...operationBase,
        kind: z.literal("progress"),
        action: z.enum(["upsert", "delete"]),
        payload: AccountSyncProgressSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((operation, context) => {
    if (
      (operation.kind === "source-feedback") !==
      (operation.profileId === ACCOUNT_SYNC_SCOPE)
    ) {
      context.addIssue({
        code: "custom",
        message: "Account feedback requires the account scope.",
        path: ["profileId"],
      });
    }
    if ((operation.action === "delete") !== (operation.payload === null)) {
      context.addIssue({
        code: "custom",
        message: "Only deletion operations have a null payload.",
        path: ["payload"],
      });
    }
    if (
      operation.kind === "profile" &&
      operation.entityId !== operation.profileId
    ) {
      context.addIssue({
        code: "custom",
        message: "Profile entity ID must match profile ID.",
        path: ["entityId"],
      });
    }
  });
export type AccountSyncOperation = z.infer<typeof AccountSyncOperationSchema>;
export type AccountSyncTitle = z.infer<typeof AccountSyncTitleSchema>;
export const AccountSyncPushSchema = z
  .object({ operations: z.array(AccountSyncOperationSchema).min(1).max(10) })
  .strict();
export const AccountSyncPullSchema = z
  .object({
    cursor: z.string().max(160),
    operations: z.array(AccountSyncOperationSchema).max(100),
    hasMore: z.boolean(),
  })
  .strict();
export const AccountSyncPushResultSchema = z
  .object({
    cursor: z.string().max(160),
    acceptedIds: z.array(z.string().uuid()).max(10),
  })
  .strict();
