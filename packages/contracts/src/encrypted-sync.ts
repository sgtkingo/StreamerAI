import { z } from "zod";
import { AccountSyncTitleSchema } from "./account-sync.js";
import { IntegrationIdSchema } from "./integrations.js";
import { SupportedLocaleSchema } from "./locales.js";
import { MediaSourcePreferencesSchema } from "./media-source-preferences.js";
import { SourceFeedbackSchema } from "./source-feedback.js";

export const ENCRYPTED_HOUSEHOLD_VERSION = 1 as const;
export const ENCRYPTED_HOUSEHOLD_MAX_BYTES = 16 * 1024 * 1024;
/** D1's maximum row is 2,000,000 bytes; reserve space for metadata and indexes. */
export const ENCRYPTED_CHECKPOINT_MAX_BYTES = 1_800_000;
const id = z.string().min(1).max(160);
const timestamp = z.string().datetime({ offset: true });
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const cipher = z
  .object({
    algorithm: z.literal("aes-256-gcm"),
    nonce: base64url.length(16),
    tag: base64url.length(22),
    ciphertext: base64url.max(ENCRYPTED_HOUSEHOLD_MAX_BYTES * 2),
  })
  .strict();

/** Public metadata contains no profile names, provider identities or credentials. */
export const EncryptedHouseholdEnvelopeSchema = z
  .object({
    format: z.literal("streamerai-encrypted-household"),
    version: z.literal(ENCRYPTED_HOUSEHOLD_VERSION),
    datasetId: z.string().uuid(),
    keyVersion: z.number().int().positive().max(1_000_000),
    recoveryVersion: z.number().int().positive().max(1_000_000),
    snapshotId: z.string().uuid(),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    createdAt: timestamp,
    recovery: cipher.extend({ ciphertext: base64url.length(43) }),
    payload: cipher,
  })
  .strict();
export type EncryptedHouseholdEnvelope = z.infer<
  typeof EncryptedHouseholdEnvelopeSchema
>;

/** The same Master PIN protected format is used for downloads and cloud copies. */
export const MasterPinHouseholdBackupSchema = z
  .object({
    format: z.literal("streamerai-master-pin-household"),
    version: z.literal(1),
    kdf: z
      .object({
        algorithm: z.literal("argon2id"),
        memory: z.literal(65_536),
        passes: z.literal(3),
        parallelism: z.literal(1),
        salt: base64url.length(22),
      })
      .strict(),
    cloudRecovery: EncryptedHouseholdEnvelopeSchema.shape.recovery,
    envelope: EncryptedHouseholdEnvelopeSchema,
  })
  .strict();
export type MasterPinHouseholdBackup = z.infer<
  typeof MasterPinHouseholdBackupSchema
>;

export const PortableCredentialKeySchema = z.enum([
  "integration.tmdb.read-token",
  "integration.webshare.wst",
  "integration.hellspy.session",
  "inference.api.openai",
  "inference.api.anthropic",
  "inference.api.gemini",
  "inference.api.grok",
  "inference.api.kimi",
  "inference.api.deepseek",
]);
export type PortableCredentialKey = z.infer<typeof PortableCredentialKeySchema>;

const library = z
  .object({
    titleId: id,
    membershipReason: z.enum(["explicit", "playback"]),
    state: z.enum(["saved", "in-progress", "completed"]),
    progressPercent: z.number().min(0).max(100).nullable(),
    lastPlayedAt: timestamp.nullable(),
  })
  .strict();
const history = z
  .object({
    sourceId: id,
    titleId: id,
    eventType: z.enum(["start", "progress", "stop", "complete"]),
    episodeLabel: z.string().max(120).nullable(),
    progressPercent: z.number().min(0).max(100),
    occurredAt: timestamp,
  })
  .strict();
const progress = z
  .object({
    titleId: id,
    seasonNumber: z.number().int().nonnegative().nullable(),
    episodeNumber: z.number().int().positive().nullable(),
    positionSeconds: z.number().finite().nonnegative(),
    durationSeconds: z.number().finite().nonnegative(),
    progressPercent: z.number().min(0).max(100),
    updatedAt: timestamp,
  })
  .strict()
  .refine((v) => (v.seasonNumber === null) === (v.episodeNumber === null));
const profile = z
  .object({
    sourceId: id,
    syncId: id,
    name: z.string().min(1).max(80),
    locale: SupportedLocaleSchema,
    /** Versioned whole preference record, including private taste prompts; always encrypted. */
    preferences: z.record(z.string(), z.unknown()),
    pinHash: z.string().min(32).max(512).nullable(),
    mediaSourcePreferences: MediaSourcePreferencesSchema,
    integrations: z
      .array(
        z.object({ id: IntegrationIdSchema, enabled: z.boolean() }).strict(),
      )
      .max(100),
    library: z.array(library).max(100_000),
    history: z.array(history).max(100_000),
    progress: z.array(progress).max(100_000),
  })
  .strict();

/** Internal decrypted contract. Never use as a cloud request or browser response. */
export const EncryptedHouseholdSnapshotSchema = z
  .object({
    version: z.literal(1),
    datasetId: z.string().uuid(),
    profiles: z.array(profile).max(5),
    titles: z.array(AccountSyncTitleSchema).max(100_000),
    credentials: z
      .array(
        z
          .object({
            key: PortableCredentialKeySchema,
            value: z.string().min(1).max(100_000),
          })
          .strict(),
      )
      .max(9),
    sourceFeedback: z
      .array(
        z
          .object({ payload: SourceFeedbackSchema, updatedAt: timestamp })
          .strict(),
      )
      .max(100_000),
    /** Explicit omissions prevent an export being confused with a complete server snapshot. */
    limitations: z.array(z.string().max(240)).max(30),
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const [key, values] of [
      ["profiles", snapshot.profiles.map((p) => p.sourceId)],
      ["profileSyncIds", snapshot.profiles.map((p) => p.syncId)],
      ["titles", snapshot.titles.map((t) => t.id)],
      ["credentials", snapshot.credentials.map((c) => c.key)],
    ] as const) {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: "custom", message: `Duplicate ${key}.` });
    }
    const titles = new Set(snapshot.titles.map((t) => t.id));
    for (const p of snapshot.profiles) {
      if (
        [...p.library, ...p.history, ...p.progress].some(
          (v) => !titles.has(v.titleId),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Referenced title is missing.",
        });
      }
    }
    // Feedback is account-owned and can legitimately outlive its author profile.
  });
export type EncryptedHouseholdSnapshot = z.infer<
  typeof EncryptedHouseholdSnapshotSchema
>;

export const EncryptedCheckpointWriteSchema = z
  .object({
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    envelope: MasterPinHouseholdBackupSchema,
  })
  .strict();
export const EncryptedCheckpointSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    envelope: MasterPinHouseholdBackupSchema.nullable(),
  })
  .strict();
export type EncryptedCheckpoint = z.infer<typeof EncryptedCheckpointSchema>;
