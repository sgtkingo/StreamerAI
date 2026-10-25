import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import type {
  EpisodeSelection,
  MediaCandidateRef,
  MediaProvider,
  MetadataProvider,
  ProviderRegistry,
  SubtitleProvider,
} from "@streamer-ai/contracts";
import type { InferenceFetch } from "./integrations/ollama-preflight.js";
import { type FetchLike } from "./integrations/tmdb-client.js";
import type { ProviderFetch } from "./integrations/tmdb-api-client.js";
import { TmdbApiClient } from "./integrations/tmdb-api-client.js";
import { TMDB_READ_TOKEN_SECRET_KEY } from "./integrations/tmdb-client.js";
import { TmdbMetadataProvider } from "./integrations/tmdb-metadata-provider.js";
import {
  WEBSHARE_WST_SECRET_KEY,
  WebshareClient,
} from "./integrations/webshare-client.js";
import { WebshareMediaProvider } from "./integrations/webshare-media-provider.js";
import {
  HellspyClient,
  HELLSPY_SESSION_SECRET_KEY,
} from "./integrations/hellspy-client.js";
import { HellspyMediaProvider } from "./integrations/hellspy-media-provider.js";
import { registerHellspyRoutes } from "./routes/hellspy.js";
import { LocalMediaProvider } from "./integrations/local-media-provider.js";
import { MediaSourcePreferenceStore } from "./services/media-source-preferences.js";
import { registerMediaSourcePreferenceRoutes } from "./routes/media-source-preferences.js";
import { OllamaAgentProvider } from "./integrations/ollama-agent-provider.js";
import { discoverOllamaModels } from "./integrations/ollama-model-catalog.js";
import { discoveryTierForAgent } from "./integrations/agent-model-catalog.js";
import { AgentRouter } from "./integrations/agent-router.js";
import { StreamerToolService } from "./mcp/streamer-tools.js";
import { LocalAgentHost } from "./integrations/local-agent-host.js";
import { CustomLocalAgent } from "./integrations/custom-local-agent.js";
import {
  RemoteApiAgent,
  REMOTE_API_NAMES,
  remoteApiSecretKey,
} from "./integrations/remote-api-agent.js";
import {
  manualAgentSettingKey,
  parseManualAgentConfig,
  type ManualAgentConfig,
} from "./integrations/manual-agent-config.js";
import { AdapterRegistry } from "./integrations/provider-registry.js";
import { createAppLogger, logDiscoveryEvent } from "./logging.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerContentRoutes } from "./routes/content.js";
import { registerInferenceRoutes } from "./routes/inference.js";
import {
  registerPlaybackRoutes,
  type ExternalSubtitleSource,
} from "./routes/playback.js";
import { registerTmdbRoutes } from "./routes/tmdb.js";
import { registerWebshareRoutes } from "./routes/webshare.js";
import { registerLocalFilesRoutes } from "./routes/local-files.js";
import { registerEnvironmentRoutes } from "./routes/environment.js";
import {
  OpenMeteoClient,
  type EnvironmentFetch,
} from "./integrations/open-meteo-client.js";
import { EnvironmentWeatherService } from "./services/environment-weather.js";
import { StreamerCore } from "./services/streamer-core.js";
import { LocalMediaLibrary } from "./services/local-media-library.js";
import { OfflineDownloadManager } from "./services/offline-download-manager.js";
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
  profileSecretKey,
  type SecretStore,
} from "./stores/secret-store.js";
import { readRuntimeConfig, type RuntimeConfig } from "./runtime-config.js";

export interface CreateAppOptions {
  environment?: string;
  logger?: FastifyBaseLogger | false;
  fetch?: FetchLike;
  providerFetch?: ProviderFetch;
  inferenceFetch?: InferenceFetch;
  remoteApiFetch?: typeof fetch;
  /** Optional, fixed-host Open-Meteo transport, independent of media providers. */
  environmentFetch?: EnvironmentFetch;
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
  /** Replace the native folder dialog in tests or a desktop host. */
  localFolderPicker?: () => Promise<string | null>;
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
  const activeInferenceConfig = { ...runtimeConfig.inference };
  const profileInferenceConfigs = new Map<string, RuntimeConfig["inference"]>();
  const configForProfile = (profileId: string) => {
    const cached = profileInferenceConfigs.get(profileId);
    if (cached) return selectedOllamaConfig(profileId, cached);
    const config = { ...runtimeConfig.inference };
    const stored = database.settings.get<unknown>(
      manualAgentSettingKey(profileId),
    );
    if (stored !== null) {
      try {
        Object.assign(config, parseManualAgentConfig(stored));
      } catch {
        // Invalid saved values leave this profile on the server defaults.
      }
    }
    profileInferenceConfigs.set(profileId, config);
    return selectedOllamaConfig(profileId, config);
  };
  function selectedOllamaConfig(
    profileId: string,
    config: RuntimeConfig["inference"],
  ): RuntimeConfig["inference"] {
    const selection = agent.selection(profileId);
    return selection.mode === "api" && selection.provider === "ollama"
      ? {
          ...config,
          ...(selection.model ? { model: selection.model } : {}),
          contextTokens: agent.contextTokens(profileId, config.contextTokens),
        }
      : config;
  }
  const isManualAgent = (profileId: string) =>
    database.settings.get<unknown>(manualAgentSettingKey(profileId)) !== null;
  const stores = createStores(options, database, environment, runtimeConfig);
  const playbackTicketStore =
    options.playbackTicketStore ?? new InMemoryPlaybackTicketStore(now);
  const playbackMediaEngine =
    options.playbackMediaEngine ?? new FfmpegPlaybackMediaEngine();
  const localMediaLibrary = new LocalMediaLibrary(database, now);
  if (localMediaLibrary.getConfig().roots.length > 0)
    localMediaLibrary.startScan();
  const webshareClient = new WebshareClient({
    secretStore: stores.secretStore,
    fetch: options.providerFetch ?? defaultProviderFetch(),
    timeoutMs: 8_000,
  });
  const offlineDownloads = new OfflineDownloadManager(
    database,
    localMediaLibrary,
    webshareClient,
  );
  const hellspyClient = new HellspyClient({
    secretStore: stores.secretStore,
    fetch: options.providerFetch ?? defaultProviderFetch(),
    now,
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
      diagnostic: (event) => logDiscoveryEvent(app.log, event),
    }),
    new HellspyMediaProvider({
      client: hellspyClient,
      issuePlaybackTicket: (input) => playbackTicketStore.issue(input),
      probeMedia: (url) => playbackMediaEngine.probe(url),
      now,
    }),
    new LocalMediaProvider(
      localMediaLibrary,
      (input) => playbackTicketStore.issue(input),
      now,
    ),
    ...(options.mediaProviders ?? []),
  ]);
  const sourcePreferences = new MediaSourcePreferenceStore(database);
  const mediaProviderOrder = (profileId: string) =>
    sourcePreferences.order(
      profileId,
      media.list().map((provider) => provider.descriptor().id),
    );
  const subtitleProviders = new AdapterRegistry<SubtitleProvider>(
    "subtitle",
    options.subtitleProviders?.list() ?? [],
  );
  const ollamaAgent = new OllamaAgentProvider({
    config: activeInferenceConfig,
    configForProfile,
    now,
    diagnostic: (event) => logDiscoveryEvent(app.log, event),
  });
  const remoteApi = new RemoteApiAgent(
    stores.secretStore,
    options.remoteApiFetch ?? fetch,
    now,
  );
  const inferenceFetcher = options.inferenceFetch ?? defaultInferenceFetch();
  const agent = new AgentRouter(
    database,
    runtimeConfig.agent,
    ollamaAgent,
    remoteApi,
    new StreamerToolService(`http://127.0.0.1:${runtimeConfig.server.port}`),
    now,
    new LocalAgentHost((event) => app.log.info(event, "Local agent lifecycle")),
    async (profileId) =>
      (await stores.integrationStateStore.get("ollama", profileId))
        ?.configured === true,
    (profileId) =>
      discoverOllamaModels(inferenceFetcher, configForProfile(profileId)),
    new CustomLocalAgent(database, options.remoteApiFetch ?? fetch, now),
  );
  const agentInferenceForProfile = (
    profileId: string,
  ): RuntimeConfig["inference"] => {
    const selection = agent.selection(profileId);
    return selection.mode === "local" ||
      (selection.mode === "api" && selection.provider !== "ollama")
      ? {
          ...configForProfile(profileId),
          model:
            selection.model ??
            agent.cachedRecommendedModel(
              profileId,
              selection.provider,
              selection.reasoningEffort,
            ) ??
            selection.provider,
          contextTokens: selection.contextTokens ?? 8192,
          maxOutputTokens: 1024,
          discoveryTier: discoveryTierForAgent(
            selection.provider,
            selection.model ??
              agent.cachedRecommendedModel(
                profileId,
                selection.provider,
                selection.reasoningEffort,
              ) ??
              undefined,
          ),
        }
      : {
          ...configForProfile(profileId),
          model:
            selection.model ??
            agent.cachedRecommendedModel(
              profileId,
              "ollama",
              selection.reasoningEffort,
            ) ??
            configForProfile(profileId).model,
        };
  };
  const providerDescriptors = [
    ...metadata.list().map((provider) => provider.descriptor()),
    ...media.list().map((provider) => provider.descriptor()),
    ...subtitleProviders.list().map((provider) => provider.descriptor()),
    ollamaAgent.descriptor(),
  ];
  const providerIds = new Set<string>();
  for (const descriptor of providerDescriptors) {
    if (providerIds.has(descriptor.id))
      throw new Error(
        `Provider '${descriptor.id}' is registered in more than one family.`,
      );
    providerIds.add(descriptor.id);
  }
  type SavedEpisodeCandidate = {
    episode: EpisodeSelection;
    ref: MediaCandidateRef;
  };
  const episodeCandidateKey = (titleId: string) =>
    `series-candidates:${createHash("sha256").update(titleId).digest("hex")}`;
  const loadEpisodeCandidates = (titleId: string): SavedEpisodeCandidate[] =>
    database.settings.get<SavedEpisodeCandidate[]>(
      episodeCandidateKey(titleId),
    ) ?? [];
  const saveEpisodeCandidate = (
    titleId: string,
    episode: EpisodeSelection,
    ref: MediaCandidateRef,
  ) => {
    const known = loadEpisodeCandidates(titleId);
    if (
      known.some(
        (item) =>
          item.episode.seasonNumber === episode.seasonNumber &&
          item.episode.episodeNumber === episode.episodeNumber &&
          item.ref.providerId === ref.providerId &&
          item.ref.candidateId === ref.candidateId,
      )
    )
      return;
    database.settings.set(
      episodeCandidateKey(titleId),
      [...known, { episode, ref }].slice(-1_000),
    );
  };
  const contentProvider =
    options.contentProvider ??
    (environment === "production"
      ? new LiveContentCoordinator({
          agent,
          agentReady: async (profileId) => {
            const selection = agent.selection(profileId);
            if (selection.mode === "disabled" || selection.mode === "mcp")
              return false;
            return (await agent.status(profileId)).available;
          },
          metadata,
          media,
          mediaProviderOrder,
          integrationStateStore: stores.integrationStateStore,
          secretRefForProvider: (providerId, profileId) =>
            database.integrations.getSecretRef(providerId, profileId),
          inference: activeInferenceConfig,
          inferenceForProfile: agentInferenceForProfile,
          localeForProfile: (profileId) =>
            database.profiles.get(profileId)?.locale ?? "en",
          loadEpisodeCandidates,
          saveEpisodeCandidate,
          now,
          diagnostic: (event) => logDiscoveryEvent(app.log, event),
          discoveryBudgetMsForProfile: (profileId) =>
            (agent.selection(profileId).reasoningEffort ?? "low") === "none"
              ? 55_000
              : 110_000,
        })
      : undefined);
  const core = new StreamerCore(
    database,
    now,
    contentProvider,
    (profileId, providerId) =>
      media.get(providerId) !== null &&
      stores.integrationStateStore.isConfigured(providerId, profileId),
    mediaProviderOrder,
  );
  const availabilityTimer =
    environment === "test"
      ? null
      : setInterval(() => {
          void core.runScheduledAvailabilityChecks();
        }, 60_000);
  availabilityTimer?.unref();
  const app =
    options.logger === false
      ? Fastify({ logger: false, bodyLimit: 64 * 1024 })
      : Fastify({
          loggerInstance:
            options.logger ??
            createAppLogger({ level: runtimeConfig.server.logLevel }),
          bodyLimit: 64 * 1024,
        });

  app.addHook("onReady", async () => {
    if (environment !== "test") {
      await localMediaLibrary.ensureDefaultRoot(
        resolve(runtimeConfig.server.dataDir, "StreamerAI", "Local", "Library"),
      );
    }
    const configured = localMediaLibrary.getConfig().roots.length > 0;
    await stores.integrationStateStore.set({
      integrationId: "local-files",
      status: configured ? "connected" : "not_configured",
      configured,
      updatedAt: now().toISOString(),
    });
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

  registerEnvironmentRoutes(
    app,
    new EnvironmentWeatherService(
      new OpenMeteoClient({ fetch: options.environmentFetch, now }),
      { now },
    ),
  );
  registerSystemRoutes(app, {
    agentStatus: async (profileId) => {
      const selection = agent.selection(profileId);
      if (selection.mode === "api" && selection.provider === "ollama") {
        const state = await stores.integrationStateStore.get(
          "ollama",
          profileId,
        );
        return {
          configured: state?.configured === true,
          status: state?.status ?? "not_configured",
          checkedAt: state?.checkedAt ?? null,
          provider: "ollama",
        };
      }
      const status = await agent.status(profileId);
      return {
        configured: status.available,
        status: status.available ? "connected" : "action_required",
        checkedAt: now().toISOString(),
        provider: selection.provider,
      };
    },
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    database,
    now,
    providerDescriptors,
  });
  registerContentRoutes(app, {
    core,
    ensureLocalLibrary: (profileId) =>
      localMediaLibrary.ensureProfileLibrary(profileId),
    onDeleteProfile: async (profileId) => {
      sourcePreferences.delete(profileId);
      await agent.deleteProfile(profileId);
      await Promise.all([
        stores.secretStore.delete(
          profileSecretKey(profileId, TMDB_READ_TOKEN_SECRET_KEY),
        ),
        stores.secretStore.delete(
          profileSecretKey(profileId, WEBSHARE_WST_SECRET_KEY),
        ),
        stores.secretStore.delete(
          profileSecretKey(profileId, HELLSPY_SESSION_SECRET_KEY),
        ),
        ...REMOTE_API_NAMES.map((provider) =>
          stores.secretStore.delete(remoteApiSecretKey(profileId, provider)),
        ),
      ]);
      database.settings.delete(manualAgentSettingKey(profileId));
      profileInferenceConfigs.delete(profileId);
    },
  });
  registerLocalFilesRoutes(
    app,
    localMediaLibrary,
    stores.integrationStateStore,
    now,
    offlineDownloads,
    options.localFolderPicker,
  );
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
          secretRef: database.integrations.getSecretRef(
            ticket.providerId,
            ticket.profileId,
          ),
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
      isEnabled: async (providerId, profileId) =>
        (await stores.integrationStateStore.get(providerId, profileId))
          ?.configured === true,
      secretRefForProvider: (providerId, ticket) =>
        database.integrations.getSecretRef(providerId, ticket.profileId),
      onProviderFailure: (providerId, phase) =>
        app.log.warn(
          { code: "PLAYBACK_SUBTITLE_PROVIDER_FAILED", providerId, phase },
          "Subtitle source unavailable",
        ),
    }),
  );
  registerInferenceRoutes(app, {
    agentRouter: agent,
    secretStore: stores.secretStore,
    fetch: inferenceFetcher,
    config: activeInferenceConfig,
    configForProfile,
    profileExists: (profileId) => database.profiles.get(profileId) !== null,
    integrationStateStore: stores.integrationStateStore,
    now,
    isManualAgent,
    saveManualAgent: (selection: ManualAgentConfig, profileId: string) => {
      database.settings.set(manualAgentSettingKey(profileId), selection);
      profileInferenceConfigs.delete(profileId);
      Object.assign(configForProfile(profileId), selection);
    },
  });
  registerTmdbRoutes(app, {
    fetch: options.fetch ?? defaultFetch(),
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    profileExists: (profileId) => database.profiles.get(profileId) !== null,
    timeoutMs: options.tmdbTimeoutMs ?? 8_000,
    now,
  });
  registerWebshareRoutes(app, {
    fetch: options.providerFetch ?? defaultProviderFetch(),
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    profileExists: (profileId) => database.profiles.get(profileId) !== null,
    timeoutMs: 8_000,
    now,
  });

  registerHellspyRoutes(app, {
    client: hellspyClient,
    secretStore: stores.secretStore,
    integrationStateStore: stores.integrationStateStore,
    profileExists: (profileId) => database.profiles.get(profileId) !== null,
    now,
  });

  registerMediaSourcePreferenceRoutes(app, {
    database,
    store: sourcePreferences,
    providerIds: () => media.list().map((provider) => provider.descriptor().id),
  });

  app.addHook("onClose", async () => {
    await agent.close();
    if (availabilityTimer) clearInterval(availabilityTimer);
    await offlineDownloads.close();
    await localMediaLibrary.close();
  });
  if (ownsDatabase) {
    app.addHook("onClose", async () => database.close());
  }

  return app;
}
