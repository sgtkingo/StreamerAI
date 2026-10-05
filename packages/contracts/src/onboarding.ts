import { z } from "zod";

import { IntegrationIdSchema } from "./integrations.js";
import { SupportedLocaleSchema } from "./locales.js";

/**
 * Accepted only on the inbound setup route. Responses use
 * `IntegrationConnectionResultSchema`, which has no credential-shaped field.
 */
export const TmdbConnectRequestSchema = z
  .object({
    token: z.string().trim().min(20).max(2_048),
  })
  .strict();

export type TmdbConnectRequest = z.infer<typeof TmdbConnectRequestSchema>;

export const PUBLIC_INTEGRATION_ERROR_CODES = [
  "CREDENTIAL_REQUIRED",
  "CREDENTIAL_REJECTED",
  "RATE_LIMITED",
  "TIMEOUT",
  "INVALID_RESPONSE",
  "PROVIDER_UNAVAILABLE",
  "SECURE_STORAGE_UNAVAILABLE",
  "UNKNOWN",
] as const;

export const PublicIntegrationErrorCodeSchema = z.enum(
  PUBLIC_INTEGRATION_ERROR_CODES,
);

export type PublicIntegrationErrorCode = z.infer<
  typeof PublicIntegrationErrorCodeSchema
>;

export const PUBLIC_INTEGRATION_SUCCESS_CODES = [
  "VERIFIED",
  "CONNECTED",
] as const;

export const PublicIntegrationSuccessCodeSchema = z.enum(
  PUBLIC_INTEGRATION_SUCCESS_CODES,
);

export type PublicIntegrationSuccessCode = z.infer<
  typeof PublicIntegrationSuccessCodeSchema
>;

export const IntegrationPersistenceSchema = z.enum(["memory", "secure-local"]);

export type IntegrationPersistence = z.infer<
  typeof IntegrationPersistenceSchema
>;

const IntegrationConnectionSuccessSchema = z
  .object({
    ok: z.literal(true),
    integrationId: IntegrationIdSchema,
    status: z.enum(["verified", "connected"]),
    messageCode: PublicIntegrationSuccessCodeSchema,
    persistence: IntegrationPersistenceSchema.optional(),
  })
  .strict();

const IntegrationConnectionFailureSchema = z
  .object({
    ok: z.literal(false),
    integrationId: IntegrationIdSchema,
    status: z.enum(["action-required", "unavailable"]),
    messageCode: PublicIntegrationErrorCodeSchema,
    persistence: IntegrationPersistenceSchema.optional(),
  })
  .strict();

/** Stable, localized-by-message-code response that can never echo a token or secret reference. */
export const IntegrationConnectionResultSchema = z.discriminatedUnion("ok", [
  IntegrationConnectionSuccessSchema,
  IntegrationConnectionFailureSchema,
]);

export type IntegrationConnectionResult = z.infer<
  typeof IntegrationConnectionResultSchema
>;

export const MediaLanguageSchema = z.enum([
  "cs",
  "en",
  "sk",
  "de",
  "fr",
  "es",
  "it",
  "pl",
  "ja",
]);
export type MediaLanguage = z.infer<typeof MediaLanguageSchema>;

export const PlaybackPreferencesSchema = z
  .object({
    primaryAudioLanguage: MediaLanguageSchema.default("cs"),
    secondaryAudioLanguage: MediaLanguageSchema.default("en"),
    autoFindSubtitles: z.boolean().default(false),
    primaryAudioSubtitleLanguage: z
      .union([z.literal("off"), MediaLanguageSchema])
      .default("off"),
    secondaryAudioSubtitleLanguage: z
      .union([z.literal("off"), MediaLanguageSchema])
      .default("cs"),
    audioOutputDeviceId: z.string().trim().max(512).default("default"),
    subtitleSizePercent: z.number().int().min(75).max(200).default(100),
    subtitleColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
    subtitleFont: z.enum(["sans", "serif", "mono"]).default("sans"),
  })
  .strict();
export type PlaybackPreferences = z.infer<typeof PlaybackPreferencesSchema>;

export const DEFAULT_PLAYBACK_PREFERENCES: PlaybackPreferences =
  PlaybackPreferencesSchema.parse({});

export const ViewerProfileSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    onboardingComplete: z.boolean(),
    locale: SupportedLocaleSchema,
    genres: z.array(z.string().min(1).max(80)).max(50),
    prompt: z.string().max(3000),
    playback: PlaybackPreferencesSchema,
  })
  .strict();
export type ViewerProfile = z.infer<typeof ViewerProfileSchema>;

export const CreateViewerProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    locale: SupportedLocaleSchema.default("en"),
  })
  .strict();

export const UpdateViewerProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    locale: SupportedLocaleSchema.optional(),
    genres: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    prompt: z.string().trim().max(3000).optional(),
    playback: PlaybackPreferencesSchema.optional(),
  })
  .strict();
export type UpdateViewerProfile = z.infer<typeof UpdateViewerProfileSchema>;

export const SetupProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    locale: SupportedLocaleSchema,
    preferences: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
    playback: PlaybackPreferencesSchema.default(DEFAULT_PLAYBACK_PREFERENCES),
  })
  .strict();

export type SetupProfile = z.infer<typeof SetupProfileSchema>;

export const CompleteSetupRequestSchema = z
  .object({
    profile: SetupProfileSchema,
    localAiEnabled: z.boolean(),
    profileId: z.string().min(1).max(120).optional(),
  })
  .strict();

export type CompleteSetupRequest = z.infer<typeof CompleteSetupRequestSchema>;
