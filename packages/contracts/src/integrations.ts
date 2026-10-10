import { z } from "zod";

import { LocalizedTextSchema, type LocalizedText } from "./locales.js";

export const INTEGRATION_IDS = [
  "tmdb",
  "webshare",
  "ollama",
  "csfd",
  "local-files",
  "ftp",
  "ftps",
  "nas",
  "opensubtitles",
  "titulky-com",
  "brave-search",
  "cloudflare-sync",
] as const;

export const BuiltinIntegrationIdSchema = z.enum(INTEGRATION_IDS);
export type BuiltinIntegrationId = z.infer<typeof BuiltinIntegrationIdSchema>;

/** Community adapters use the same stable, lowercase ID format as built-ins. */
export const IntegrationIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);

export type IntegrationId = z.infer<typeof IntegrationIdSchema>;

export const INTEGRATION_KINDS = [
  "metadata",
  "media",
  "subtitle",
  "inference",
  "enrichment",
  "search",
  "sync",
] as const;

export const IntegrationKindSchema = z.enum(INTEGRATION_KINDS);

export type IntegrationKind = z.infer<typeof IntegrationKindSchema>;

export const INTEGRATION_SETUP_MODES = [
  "none",
  "api-key",
  "credentials",
  "local-runtime",
  "informed-consent",
  "device-pairing",
] as const;

export const IntegrationSetupModeSchema = z.enum(INTEGRATION_SETUP_MODES);

export type IntegrationSetupMode = z.infer<typeof IntegrationSetupModeSchema>;

export const INTEGRATION_SETUP_STATES = [
  "not-configured",
  "needs-user-action",
  "checking",
  "ready",
  "degraded",
  "failed",
  "disabled",
] as const;

export const IntegrationSetupStateSchema = z.enum(INTEGRATION_SETUP_STATES);

export type IntegrationSetupState = z.infer<typeof IntegrationSetupStateSchema>;

export const INTEGRATION_HEALTH_STATES = [
  "unknown",
  "healthy",
  "degraded",
  "unavailable",
  "disabled",
] as const;

export const IntegrationHealthStateSchema = z.enum(INTEGRATION_HEALTH_STATES);

export type IntegrationHealthState = z.infer<
  typeof IntegrationHealthStateSchema
>;

export const CREDENTIAL_STATES = ["not-required", "missing", "stored"] as const;

export const CredentialStateSchema = z.enum(CREDENTIAL_STATES);

export type CredentialState = z.infer<typeof CredentialStateSchema>;

export const SETUP_ACTIONS = [
  "none",
  "connect",
  "enter-credentials",
  "install-runtime",
  "download-model",
  "accept-terms",
  "pair-device",
  "retry",
  "manage",
] as const;

export const IntegrationSetupActionSchema = z
  .object({
    action: z.enum(SETUP_ACTIONS),
    label: LocalizedTextSchema,
    /** Internal application route only. External documentation belongs to the descriptor. */
    href: z
      .string()
      .regex(/^\/(?!\/)/, "Expected an application-relative path")
      .optional(),
  })
  .strict();

export type IntegrationSetupAction = z.infer<
  typeof IntegrationSetupActionSchema
>;

/**
 * Static, non-secret metadata used to render guided integration onboarding.
 * `automatedChecks` means the app can validate the dependency after the minimum
 * user action; it never means that the app may create an external account.
 */
export const IntegrationDescriptorSchema = z
  .object({
    id: IntegrationIdSchema,
    kind: IntegrationKindSchema,
    name: LocalizedTextSchema,
    description: LocalizedTextSchema,
    setupMode: IntegrationSetupModeSchema,
    /** A visible setup choice without an executable adapter yet. */
    planned: z.boolean().optional(),
    optional: z.boolean(),
    canAutoDetect: z.boolean(),
    automatedChecks: z.boolean(),
    supportsDisconnect: z.boolean(),
    documentationUrl: z.string().url().optional(),
  })
  .strict();

export type IntegrationDescriptor = z.infer<typeof IntegrationDescriptorSchema>;

export const IntegrationPublicStatusSchema = z
  .object({
    id: IntegrationIdSchema,
    enabled: z.boolean(),
    setupStatus: IntegrationSetupStateSchema,
    healthStatus: IntegrationHealthStateSchema,
    credentialStatus: CredentialStateSchema,
    healthCode: z.string().trim().min(1).max(80).nullable(),
    lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
    updatedAt: z.string().datetime({ offset: true }),
    nextAction: IntegrationSetupActionSchema.nullable().optional(),
  })
  .strict();

export type IntegrationPublicStatus = z.infer<
  typeof IntegrationPublicStatusSchema
>;

const descriptor = (value: IntegrationDescriptor): IntegrationDescriptor =>
  IntegrationDescriptorSchema.parse(value);

const text = (en: string, cs: string, de: string): LocalizedText => ({
  en,
  cs,
  de,
});

/** Public registry; it contains no keys, account identifiers, tokens, or secret references. */
export const INTEGRATION_DESCRIPTORS = {
  tmdb: descriptor({
    id: "tmdb",
    kind: "metadata",
    name: text("TMDB", "TMDB", "TMDB"),
    description: text(
      "Movie and series metadata, artwork, releases, and trends.",
      "Metadata filmů a seriálů, plakáty, premiéry a trendy.",
      "Metadaten, Bilder, Veröffentlichungen und Trends für Filme und Serien.",
    ),
    setupMode: "api-key",
    optional: false,
    canAutoDetect: false,
    automatedChecks: true,
    supportsDisconnect: true,
    documentationUrl: "https://developer.themoviedb.org/",
  }),
  webshare: descriptor({
    id: "webshare",
    kind: "media",
    name: text("Webshare", "Webshare", "Webshare"),
    description: text(
      "Find and play media available through your Webshare account.",
      "Vyhledávání a přehrávání médií dostupných přes váš účet Webshare.",
      "Medien über Ihr Webshare-Konto suchen und wiedergeben.",
    ),
    setupMode: "credentials",
    optional: false,
    canAutoDetect: false,
    automatedChecks: true,
    supportsDisconnect: true,
    documentationUrl: "https://webshare.cz/apidoc/",
  }),
  ollama: descriptor({
    id: "ollama",
    kind: "inference",
    name: text("Local AI", "Lokální AI", "Lokale KI"),
    description: text(
      "Private on-device matching, labels, and recommendations.",
      "Soukromé párování, štítky a doporučení přímo v zařízení.",
      "Privates lokales Zuordnen, Kennzeichnen und Empfehlen.",
    ),
    setupMode: "local-runtime",
    optional: true,
    canAutoDetect: true,
    automatedChecks: true,
    supportsDisconnect: true,
    documentationUrl: "https://ollama.com/",
  }),
  csfd: descriptor({
    id: "csfd",
    kind: "metadata",
    name: text("ČSFD", "ČSFD", "ČSFD"),
    description: text(
      "Optional Czech and Slovak title enrichment with source-specific limitations.",
      "Volitelné české a slovenské obohacení titulů s omezeními daného zdroje.",
      "Optionale tschechische und slowakische Titelanreicherung mit Quellenbeschränkungen.",
    ),
    setupMode: "informed-consent",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
    documentationUrl: "https://www.csfd.cz/",
  }),
  "local-files": descriptor({
    id: "local-files",
    kind: "media",
    name: text(
      "Local folder or drive",
      "Místní složka nebo disk",
      "Lokaler Ordner oder Datenträger",
    ),
    description: text(
      "Play files from a folder or drive you choose.",
      "Přehrávání souborů z vybrané složky nebo disku.",
      "Dateien aus einem ausgewählten Ordner oder Datenträger abspielen.",
    ),
    setupMode: "informed-consent",
    optional: true,
    canAutoDetect: false,
    automatedChecks: true,
    supportsDisconnect: true,
  }),
  ftp: descriptor({
    id: "ftp",
    kind: "media",
    name: text("FTP", "FTP", "FTP"),
    description: text(
      "Browse a configured FTP media server.",
      "Procházení nastaveného FTP serveru s médii.",
      "Einen konfigurierten FTP Medienserver durchsuchen.",
    ),
    setupMode: "credentials",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
  }),
  ftps: descriptor({
    id: "ftps",
    kind: "media",
    name: text("FTPS", "FTPS", "FTPS"),
    description: text(
      "Browse a configured FTP server with TLS.",
      "Procházení nastaveného FTP serveru se šifrováním TLS.",
      "Einen konfigurierten FTP Server mit TLS durchsuchen.",
    ),
    setupMode: "credentials",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
  }),
  nas: descriptor({
    id: "nas",
    kind: "media",
    name: text("NAS", "NAS", "NAS"),
    description: text(
      "Play media from a network storage connection.",
      "Přehrávání médií ze síťového úložiště.",
      "Medien von einem Netzwerkspeicher abspielen.",
    ),
    setupMode: "credentials",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
  }),
  opensubtitles: descriptor({
    id: "opensubtitles",
    kind: "subtitle",
    name: text("OpenSubtitles", "OpenSubtitles", "OpenSubtitles"),
    description: text(
      "Find matching external subtitles.",
      "Vyhledávání odpovídajících externích titulků.",
      "Passende externe Untertitel finden.",
    ),
    setupMode: "api-key",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
    documentationUrl: "https://www.opensubtitles.org/",
  }),
  "titulky-com": descriptor({
    id: "titulky-com",
    kind: "subtitle",
    name: text("Titulky.com", "Titulky.com", "Titulky.com"),
    description: text(
      "Find Czech and Slovak external subtitles.",
      "Vyhledávání českých a slovenských externích titulků.",
      "Tschechische und slowakische externe Untertitel finden.",
    ),
    setupMode: "informed-consent",
    planned: true,
    optional: true,
    canAutoDetect: false,
    automatedChecks: false,
    supportsDisconnect: true,
    documentationUrl: "https://www.titulky.com/",
  }),
  "brave-search": descriptor({
    id: "brave-search",
    kind: "search",
    name: text("Brave Search", "Brave Search", "Brave Search"),
    description: text(
      "Optional web discovery for news and trends with a user-provided API key.",
      "Volitelné webové hledání novinek a trendů s API klíčem uživatele.",
      "Optionale Websuche nach Neuigkeiten und Trends mit eigenem API-Schlüssel.",
    ),
    setupMode: "api-key",
    optional: true,
    canAutoDetect: false,
    automatedChecks: true,
    supportsDisconnect: true,
    documentationUrl: "https://brave.com/search/api/",
  }),
  "cloudflare-sync": descriptor({
    id: "cloudflare-sync",
    kind: "sync",
    name: text(
      "Cloud sync",
      "Cloudová synchronizace",
      "Cloud-Synchronisierung",
    ),
    description: text(
      "Optional encrypted synchronization of small user state between devices.",
      "Volitelná šifrovaná synchronizace malého uživatelského stavu mezi zařízeními.",
      "Optionale verschlüsselte Synchronisierung kleiner Benutzerzustände zwischen Geräten.",
    ),
    setupMode: "device-pairing",
    optional: true,
    canAutoDetect: false,
    automatedChecks: true,
    supportsDisconnect: true,
  }),
} as const satisfies Record<BuiltinIntegrationId, IntegrationDescriptor>;
