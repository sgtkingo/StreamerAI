import { z } from "zod";

import { SupportedLocaleSchema } from "./locales.js";

export const PROVIDER_FAMILIES = [
  "metadata",
  "media",
  "subtitle",
  "search",
  "agent",
  "sync",
] as const;
export const ProviderFamilySchema = z.enum(PROVIDER_FAMILIES);
export type ProviderFamily = z.infer<typeof ProviderFamilySchema>;

/** Major version of the normalized adapter contract, independent of adapter releases. */
export const CONNECTOR_CONTRACT_VERSION = 1 as const;

/** Stable capability names understood by the StreamerAI coordinator. */
export const SOURCE_CONNECTOR_CAPABILITIES = {
  metadata: [
    "movies",
    "series",
    "series-structure",
    "ratings",
    "artwork",
    "discovery-feeds",
  ],
  media: [
    "movie-search",
    "episode-search",
    "direct-play",
    "http-range",
    "https",
    "embedded-subtitles",
    "local-files",
  ],
  subtitle: [
    "movie-search",
    "episode-search",
    "hash-search",
    "release-match",
    "hearing-impaired",
    "srt",
    "vtt",
    "ass",
    "ssa",
  ],
} as const;

export type SourceConnectorFamily = keyof typeof SOURCE_CONNECTOR_CAPABILITIES;
export type SourceConnectorCapability<TFamily extends SourceConnectorFamily> =
  (typeof SOURCE_CONNECTOR_CAPABILITIES)[TFamily][number];

export const PROVIDER_ERROR_CATEGORIES = [
  "INVALID_CREDENTIALS",
  "PERMISSION_MISSING",
  "RATE_LIMITED",
  "NETWORK_UNREACHABLE",
  "PROVIDER_UNAVAILABLE",
  "INVALID_RESPONSE",
  "UNSUPPORTED_CAPABILITY",
  "CONTENT_RESTRICTED",
  "NOT_FOUND",
  "UNKNOWN",
] as const;
export const ProviderErrorCategorySchema = z.enum(PROVIDER_ERROR_CATEGORIES);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;

export const VALIDATION_STATES = [
  "verified",
  "derived",
  "unverified",
  "stale",
] as const;
export const ValidationStateSchema = z.enum(VALIDATION_STATES);
export type ValidationState = z.infer<typeof ValidationStateSchema>;

/** Provenance attached to every normalized value originating outside StreamerAI. */
export const FieldProvenanceSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    retrievedAt: z.string().datetime({ offset: true }),
    connectorVersion: z.string().trim().min(1).max(80),
    confidence: z.number().min(0).max(1),
    validationState: ValidationStateSchema,
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.expiresAt !== null &&
      Date.parse(value.expiresAt) <= Date.parse(value.retrievedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Provenance expiry must be later than retrieval time.",
      });
    }
  });
export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;

export const PROVIDER_SETUP_MODES = [
  "none",
  "api-key",
  "credentials",
  "local-runtime",
  "informed-consent",
  "device-pairing",
] as const;
export const ProviderSetupModeSchema = z.enum(PROVIDER_SETUP_MODES);
export type ProviderSetupMode = z.infer<typeof ProviderSetupModeSchema>;

export const CredentialFieldDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    label: z.string().trim().min(1).max(120),
    input: z.enum(["text", "password", "url"]),
    required: z.boolean(),
    secret: z.boolean(),
  })
  .strict();
export type CredentialFieldDescriptor = z.infer<
  typeof CredentialFieldDescriptorSchema
>;

/** Public, non-secret descriptor used by registries and generic setup UI. */
export const ProviderDescriptorSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    family: ProviderFamilySchema,
    displayName: z.string().trim().min(1).max(120),
    /** Omission is accepted for built-in adapters created before contract v1. */
    contractVersion: z.literal(CONNECTOR_CONTRACT_VERSION).optional(),
    connectorVersion: z.string().trim().min(1).max(80),
    capabilities: z.array(z.string().trim().min(1).max(120)).max(80),
    supportedLocales: z.array(SupportedLocaleSchema).max(30),
    setupMode: ProviderSetupModeSchema,
    credentialFields: z.array(CredentialFieldDescriptorSchema).max(20),
    canAutoDetect: z.boolean(),
    supportsRecheck: z.boolean(),
    supportsDisconnect: z.boolean(),
    documentationUrl: z.string().url().nullable(),
    privacySummary: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      new Set(descriptor.capabilities).size !== descriptor.capabilities.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "Provider capabilities must be unique.",
      });
    }
    const ids = descriptor.credentialFields.map((field) => field.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentialFields"],
        message: "Credential field identifiers must be unique.",
      });
    }
  });
export type ProviderDescriptor = z.infer<typeof ProviderDescriptorSchema>;

export const ProviderContextSchema = z
  .object({
    requestId: z.string().trim().min(1).max(120),
    profileId: z.string().trim().min(1).max(120).nullable(),
    locale: SupportedLocaleSchema,
    deadlineAt: z.string().datetime({ offset: true }),
    /** Opaque secret-store pointer. It is resolved only inside the adapter. */
    secretRef: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();
export type SerializableProviderContext = z.infer<typeof ProviderContextSchema>;

/** Runtime-only cancellation is deliberately excluded from serialized payloads. */
export interface ProviderContext extends SerializableProviderContext {
  readonly signal?: AbortSignal;
}

export const ProviderHealthSchema = z
  .object({
    status: z.enum(["healthy", "degraded", "unavailable"]),
    checkedAt: z.string().datetime({ offset: true }),
    latencyMs: z.number().int().nonnegative().nullable(),
    code: ProviderErrorCategorySchema.nullable(),
    connectorVersion: z.string().trim().min(1).max(80),
  })
  .strict();
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const ExternalEntityRefSchema = z
  .object({
    providerId: z.string().trim().min(1).max(80),
    externalId: z.string().trim().min(1).max(160),
    entityType: z.enum(["movie", "series", "season", "episode"]),
  })
  .strict();
export type ExternalEntityRef = z.infer<typeof ExternalEntityRefSchema>;
