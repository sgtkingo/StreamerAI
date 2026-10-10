import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import type {
  MediaProvider,
  MetadataProvider,
  ProviderRegistry,
  SubtitleProvider,
} from "@streamer-ai/contracts";
import type { InferenceFetch } from "./integrations/ollama-preflight.js";
import { type FetchLike } from "./integrations/tmdb-client.js";
import type { ProviderFetch } from "./integrations/tmdb-api-client.js";
import { TmdbApiClient } from "./integrations/tmdb-api-client.js";
import { TmdbMetadataProvider } from "./integrations/tmdb-metadata-provider.js";
import { WebshareClient } from "./integrations/webshare-client.js";
import { WebshareMediaProvider } from "./integrations/webshare-media-provider.js";
import { OllamaAgentProvider } from "./integrations/ollama-agent-provider.js";
import { AdapterRegistry } from "./integrations/provider-registry.js";
import { createAppLogger } from "./logging.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerInferenceRoutes } from "./routes/inference.js";
import {
  registerPlaybackRoutes,
  type ExternalSubtitleSource,
} from "./routes/playback.js";
import { registerTmdbRoutes } from "./routes/tmdb.js";
import { registerWebshareRoutes } from "./routes/webshare.js";
import { StreamerCore } from "./services/streamer-core.js";
import { WebshareExternalSubtitleService } from "./services/external-subtitle-service.js";
import { MultiSourceExternalSubtitleService } from "./services/multi-source-subtitle-service.js";
import type { StreamerContentProvider } from "./services/content-provider.js";
import { LiveContentCoordinator } from "./services/live-content-coordinator.js";
import {
  InMemoryPlaybackTicketStore,
  type PlaybackTicketStore,
} from "./services/playback-ticket-store.js";
import {
  FfmpegPlaybackMediaEngine,
  type PlaybackMediaEngine,
} from "./services/playback-media-engine.js";
import {
  SqliteIntegrationStateStore,
  type IntegrationStateStore,
} from "./stores/integration-state-store.js";
import {
  createSecretStore,
  EncryptedFileSecretStore,
  type SecretStore,
} from "./stores/secret-store.js";
import { readRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";

export interface CreateAppOptions {
  environment?: string;
  logger?: FastifyBaseLogger | false;
  fetch?: FetchLike;
  providerFetch?: ProviderFetch;
  inferenceFetch?: InferenceFetch;
  now?: () => Date;
  tmdbTimeoutMs?: number;
  secretStore?: SecretStore;
  integrationStateStore?: IntegrationStateStore;
  database?: StreamerDatabase;
  databaseFilename?: string;
  contentProvider?: StreamerContentProvider;
  /** Additional trusted connector adapters. Their descriptors are registered for setup. */
  metadataProviders?: readonly MetadataProvider[];
  mediaProviders?: readonly MediaProvider[];
  subtitleProviders?: ProviderRegistry<SubtitleProvider>;
  runtimeConfig?: RuntimeConfig;
  playbackTicketStore?: PlaybackTicketStore;
  playbackMediaEngine?: PlaybackMediaEngine;
  externalSubtitleSource?: ExternalSubtitleSource;
}

function defaultFetch(): FetchLike {
  return async (url, options) => globalThis.fetch(url, options);
}

function defaultInferenceFetch(): InferenceFetch {
  return async (url, options) => globalThis.fetch(url, options);
}

function defaultProviderFetch(): ProviderFetch {
  return async (url, options) => globalThis.fetch(url, options);
}

function createStores(
  options: CreateAppOptions,
  database: StreamerDatabase,
  environment: string,
  runtimeConfig: RuntimeConfig,
) {
  let configuredSecretStore = options.secretStore;
  if (
    configuredSecretStore === undefined &&
    runtimeConfig.secrets.backend === "encrypted-file"
  ) {
    const keyFilename = runtimeConfig.secrets.keyFile;
    if (keyFilename === null) {
      throw new Error(
        "STREAMERAI_SECRET_KEY_FILE is required for encrypted-file secret storage.",
      );
    }
    configuredSecretStore = new EncryptedFileSecretStore({
      filename: runtimeConfig.secrets.vaultFile,
      keyFilename,
    });
  }
  const secretStore = createSecretStore({ adapter: configuredSecretStore });
  const integrationStateStore =
    options.integrationStateStore ?? new SqliteIntegrationStateStore(database);

  if (
    environment === "production" &&
    (!secretStore.isPersistent ||
      !secretStore.capabilities.encryptedAtRest ||
      !integrationStateStore.isPersistent)
  ) {
    throw new Error(
      "Production requires an encrypted persistent SecretStore and a persistent IntegrationStateStore.",
    );
  }

  return { secretStore, integrationStateStore, environment };
}

export function createApp(options: CreateAppOptions = {}): FastifyInstance {
  const now = options.now ?? (() => new Date());
  const environment =
    options.environment ??
    options.runtimeConfig?.environment ??
    process.env.NODE_ENV ??
    "development";
  const runtimeConfig =
    options.runtimeConfig ??
    readRuntimeConfig({ ...process.env, NODE_ENV: environment });
  const ownsDatabase = options.database === undefined;
  let database = options.database;
  if (database === undefined) {
    const filename =
      options.databaseFilename ??
      (environment === "test"
        ? ":memory:"
        : resolve(runtimeConfig.server.dataDir, "streamer-ai.db"));
    if (filename !== ":memory:")
      mkdirSync(resolve(filename, ".."), { recursive: true });
    database = openStreamerDatabase({ filename, clock: now });
  }
  const stores = createStores(options, database, environment, runtimeConfig);
  const playbackTicketStore =
    options.playbackTicketStore ?? new InMemoryPlaybackTicketStore(now);
  const playbackMediaEngine =
    options.playbackMediaEngine ?? new FfmpegPlaybackMediaEngine();
  const webshareClient = new WebshareClient({
    secretStore: stores.secretStore,
    fetch: options.providerFetch ?? defaultProviderFetch(),
    timeoutMs: 8_000,
  });
  const metadata = new AdapterRegistry("metadata", [
    new TmdbMetadataProvider({
      client: new TmdbApiClient({
        secretStore: stores.secretStore,
        fetch: options.providerFetch ?? defaultProviderFetch(),
        timeoutMs: options.tmdbTimeoutMs ?? 8_000,
      }),
      now,
    }),
    ...(options.metadataProviders ?? []),
  ]);
  const media = new AdapterRegistry("media", [
    new WebshareMediaProvider({
      client: webshareClient,
      issuePlaybackTicket: (input) => playbackTicketStore.issue(input),
      probeMedia: (directUrl) => playbackMediaEngine.probe(directUrl),
      now,
    }),
    ...(options.mediaProviders ?? []),
  ]);
  const subtitleProviders = new AdapterRegistry<SubtitleProvider>(
    "subtitle",
    options.subtitleProviders?.list() ?? [],
  );
  const agent = new OllamaAgentProvider({
    config: runtimeConfig.inference,
    now,
  });
  const providerDescriptors = [
    ...metadata.list().map((provider) => provider.descriptor()),
    ...media.list().map((provider) => provider.descriptor()),
    ...subtitleProviders.list().map((provider) => provider.descriptor()),
    agent.descriptor(),
  ];
  const providerIds = new Set<string>();
  for (const descriptor of providerDescriptors) {
    if (providerIds.has(descriptor.id))
      throw new Error(
        `Provider '${descriptor.id}' is registered in more than one family.`,
      );
    providerIds.add(descriptor.id);
  }
  const contentProvider =
    options.contentProvider ??
    (environment === "production"
      ? new LiveContentCoordinator({
          agent,
          metadata,
          media,
          integrationStateStore: stores.integrationStateStore,
          secretRefForProvider: (providerId) =>
            database.integrations.getSecretRef(providerId),
          inference: runtimeConfig.inference,
          localeForProfile: (profileId) =>
            database.profiles.get(profileId)?.locale ?? "en",
          now,
        })
      : undefined);
  const core = new StreamerCore(database, now, contentProvider);
  const app =
    options.logger === false
      ? Fastify({ logger: false, bodyLimit: 64 * 1024 })
      : Fastify({
          loggerInstance: options.logger ?? createAppLogger(),
          bodyLimit: 64 * 1024,
        });

  if (!stores.secretStore.isPersistent) {
    app.log.warn(
      {
        code: "VOLATILE_PLAINTEXT_SECRET_STORAGE",
        backend: stores.secretStore.capabilities.backend,
        encryptedAtRest: stores.secretStore.capabilities.encryptedAtRest,
      },
      "Development secret storage is memory-only and is not encrypted at rest",
    );
  }

  app.setErrorHandler((error, request, reply) => {
    const validationError =
      typeof error === "object" && error !== null && "validation" in error;
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const clientError =
      validationError ||
      (statusCode !== undefined && statusCode >= 400 && statusCode < 500);
    if (!clientError) {
      request.log.error(
        { err: error, code: "UNHANDLED_REQUEST_ERROR" },
        "Unhandled request error",
      );
    }

    return reply.code(validationError ? 400 : (statusCode ?? 500)).send({
      error: {
        code: clientError ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: clientError
          ? "The request is incomplete or invalid."
          : "The request could not be completed.",
      },
    });
  });

  registerSystemRoutes(app, {
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    database,
    now,
    providerDescriptors,
  });
  registerContentRoutes(app, { core });
  const externalSubtitleSource =
    options.externalSubtitleSource ??
    new WebshareExternalSubtitleService(webshareClient);
  registerPlaybackRoutes(
    app,
    playbackTicketStore,
    core,
    playbackMediaEngine,
    async (ticket) => {
      const provider = media.get(ticket.providerId);
      if (!provider)
        throw new Error(
          `Media provider '${ticket.providerId}' is not registered.`,
        );
      if (!provider.refreshPlaybackSource) return ticket.directUrl;
      return provider.refreshPlaybackSource(
        {
          candidate: {
            providerId: ticket.providerId,
            candidateId: ticket.candidateId ?? ticket.variantId,
          },
          variantId: ticket.variantId,
        },
        {
          requestId: randomUUID(),
          profileId: ticket.profileId,
          locale: database.profiles.get(ticket.profileId)?.locale ?? "en",
          deadlineAt: new Date(now().getTime() + 15_000).toISOString(),
          secretRef: database.integrations.getSecretRef(ticket.providerId),
        },
      );
    },
    externalSubtitleSource,
    new MultiSourceExternalSubtitleService({
      legacy: externalSubtitleSource,
      providers: subtitleProviders,
      titleForTicket: (ticket) => {
        const title = database.titles.get(ticket.titleId);
        return title
          ? { kind: title.kind, title: title.title, year: title.year }
          : null;
      },
      localeForProfile: (profileId) =>
        database.profiles.get(profileId)?.locale ?? "en",
      isEnabled: async (providerId) =>
        (await stores.integrationStateStore.get(providerId))?.configured ===
        true,
      secretRefForProvider: (providerId) =>
        database.integrations.getSecretRef(providerId),
      onProviderFailure: (providerId, phase) =>
        app.log.warn(
          { code: "PLAYBACK_SUBTITLE_PROVIDER_FAILED", providerId, phase },
          "Subtitle source unavailable",
        ),
    }),
  );
  registerInferenceRoutes(app, {
    fetch: options.inferenceFetch ?? defaultInferenceFetch(),
    config: runtimeConfig.inference,
    integrationStateStore: stores.integrationStateStore,
    now,
  });
  registerTmdbRoutes(app, {
    fetch: options.fetch ?? defaultFetch(),
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    timeoutMs: options.tmdbTimeoutMs ?? 8_000,
    now,
  });
  registerWebshareRoutes(app, {
    fetch: options.providerFetch ?? defaultProviderFetch(),
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    timeoutMs: 8_000,
    now,
  });

  if (ownsDatabase) {
    app.addHook("onClose", async () => database.close());
  }

  return app;
}
