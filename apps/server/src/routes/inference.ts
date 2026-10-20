import type { FastifyInstance } from "fastify";
import {
  preflightOllama,
  type InferenceFetch,
} from "../integrations/ollama-preflight.js";
import type { RuntimeConfig } from "../runtime-config.js";
import {
  parseManualAgentConfig,
  type ManualAgentConfig,
} from "../integrations/manual-agent-config.js";
import type { IntegrationStateStore } from "../stores/integration-state-store.js";
import {
  parseAgentSelection,
  type AgentRouter,
} from "../integrations/agent-router.js";
import {
  REMOTE_API_NAMES,
  remoteApiSecretKey,
  type RemoteApiName,
} from "../integrations/remote-api-agent.js";
import type { SecretStore } from "../stores/secret-store.js";
import {
  fallbackCatalog,
  recommendedModel,
  REASONING_EFFORTS,
  type AgentName,
  type ReasoningEffort,
} from "../integrations/agent-model-catalog.js";

export interface InferenceRouteDependencies {
  agentRouter?: AgentRouter;
  secretStore?: SecretStore;
  fetch: InferenceFetch;
  config: RuntimeConfig["inference"];
  configForProfile?: (profileId: string) => RuntimeConfig["inference"];
  profileExists?: (profileId: string) => boolean;
  integrationStateStore: IntegrationStateStore;
  now: () => Date;
  isManualAgent: (profileId: string) => boolean;
  saveManualAgent: (selection: ManualAgentConfig, profileId: string) => void;
}

function requestProfileId(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= 120
    ? value
    : "default";
}

export function registerInferenceRoutes(
  app: FastifyInstance,
  dependencies: InferenceRouteDependencies,
): void {
  app.get("/api/v1/inference/models", async (request, reply) => {
    const query = request.query as {
      profileId?: unknown;
      provider?: unknown;
      reasoningEffort?: unknown;
    };
    const profileId = requestProfileId(query.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const provider = query.provider;
    if (
      typeof provider !== "string" ||
      !["ollama", "custom", "codex", "claude", ...REMOTE_API_NAMES].includes(
        provider,
      )
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_AGENT_PROVIDER",
          message: "Choose a supported agent provider.",
        },
      });
    const effort = query.reasoningEffort ?? "low";
    if (!REASONING_EFFORTS.includes(effort as ReasoningEffort))
      return reply.code(400).send({
        error: {
          code: "INVALID_REASONING_EFFORT",
          message: "Choose a supported thinking level.",
        },
      });
    const catalog =
      (await dependencies.agentRouter?.models(
        provider as AgentName,
        profileId,
      )) ??
      fallbackCatalog(provider as AgentName, "Agent router is unavailable.");
    return {
      ...catalog,
      recommendedModel:
        recommendedModel(
          provider as AgentName,
          catalog.models,
          effort as ReasoningEffort,
        ) ?? catalog.recommendedModel,
    };
  });

  app.get("/api/v1/inference/local-providers", async (request, reply) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (!dependencies.agentRouter)
      return reply.code(503).send({
        error: {
          code: "AGENT_ROUTER_UNAVAILABLE",
          message: "Local agent discovery is unavailable.",
        },
      });
    dependencies.agentRouter.clearLocalModelCache(profileId);
    return {
      providers: await dependencies.agentRouter.localProviderStatus(profileId),
    };
  });

  app.get("/api/v1/inference/custom", async (request, reply) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const config = dependencies.agentRouter?.customConfig(profileId) ?? null;
    return {
      configured: config !== null,
      baseUrl: config?.baseUrl ?? "",
      model: config?.model ?? "",
    };
  });

  app.put("/api/v1/inference/custom", async (request, reply) => {
    const input = request.body as Record<string, unknown> | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (!dependencies.agentRouter)
      return reply.code(503).send({
        error: {
          code: "AGENT_ROUTER_UNAVAILABLE",
          message: "Custom local agent is unavailable.",
        },
      });
    try {
      const config = dependencies.agentRouter.saveCustomConfig(
        profileId,
        input,
      );
      return { configured: true, ...config };
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: "CUSTOM_AGENT_ADDRESS_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "Enter a valid local API address and model.",
        },
      });
    }
  });

  app.post("/api/v1/inference/custom/verify", async (request, reply) => {
    const input = request.body as Record<string, unknown> | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    try {
      const candidate =
        input && ("baseUrl" in input || "model" in input) ? input : undefined;
      return {
        ok:
          (await dependencies.agentRouter?.verifyCustom(
            profileId,
            candidate,
          )) ?? false,
      };
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: "CUSTOM_AGENT_ADDRESS_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "Enter a valid local API address and model.",
        },
      });
    }
  });

  app.get("/api/v1/inference/agent", async (request, reply) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    const selection = dependencies.agentRouter?.selection(profileId);
    const ollamaSelected =
      !selection ||
      (selection.mode === "api" && selection.provider === "ollama");
    return {
      runtime: ollamaSelected ? "Ollama" : selection.provider,
      model: ollamaSelected
        ? config.model
        : (selection.model ?? selection.provider),
      baseUrl: ollamaSelected ? config.baseUrl : null,
      manual: ollamaSelected && dependencies.isManualAgent(profileId),
      selection,
    };
  });

  app.get("/api/v1/inference/agent/ollama-config", async (request, reply) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    return { model: config.model, baseUrl: config.baseUrl };
  });

  app.get("/api/v1/inference/selection", async (request, reply) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    return (
      dependencies.agentRouter?.status(profileId) ?? {
        mode: "api",
        provider: "ollama",
        available: true,
        code: "CONFIGURED",
      }
    );
  });

  app.put("/api/v1/inference/selection", async (request, reply) => {
    const input = request.body as
      | {
          profileId?: unknown;
          mode?: unknown;
          provider?: unknown;
          model?: unknown;
          reasoningEffort?: unknown;
        }
      | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (!dependencies.agentRouter)
      return reply.code(503).send({
        error: {
          code: "AGENT_ROUTER_UNAVAILABLE",
          message: "Agent selection is unavailable.",
        },
      });
    let selection;
    try {
      selection = parseAgentSelection(input);
      await dependencies.agentRouter.select(profileId, selection);
    } catch (error) {
      return reply.code(400).send({
        error: {
          code: "INVALID_AGENT_SELECTION",
          message:
            error instanceof Error
              ? error.message
              : "Choose a valid agent and model.",
        },
      });
    }
    request.log.info(
      {
        code: "AGENT_SELECTION_CHANGED",
        profileId,
        mode: selection.mode,
        provider: selection.provider,
      },
      "Selected agent backend changed",
    );
    return dependencies.agentRouter.status(profileId);
  });

  app.put("/api/v1/inference/api-credential", async (request, reply) => {
    const input = request.body as
      { profileId?: unknown; provider?: unknown; apiKey?: unknown } | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (!dependencies.secretStore)
      return reply.code(503).send({
        error: {
          code: "SECRET_STORE_UNAVAILABLE",
          message: "Credential storage is unavailable.",
        },
      });
    if (
      !REMOTE_API_NAMES.includes(input?.provider as RemoteApiName) ||
      typeof input?.apiKey !== "string" ||
      input.apiKey.trim().length < 8 ||
      input.apiKey.length > 2048
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_API_CREDENTIAL",
          message: "Choose a supported API provider and enter a valid API key.",
        },
      });
    await dependencies.secretStore.set(
      remoteApiSecretKey(profileId, input.provider as RemoteApiName),
      input.apiKey.trim(),
    );
    dependencies.agentRouter?.clearModelCache(
      input.provider as RemoteApiName,
      profileId,
    );
    request.log.info(
      {
        code: "AGENT_API_CREDENTIAL_SAVED",
        profileId,
        provider: input.provider,
      },
      "Agent API credential saved",
    );
    return { provider: input.provider, configured: true };
  });

  app.get("/api/v1/inference/api-credential", async (request, reply) => {
    const query = request.query as { profileId?: unknown; provider?: unknown };
    const profileId = requestProfileId(query.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (
      !dependencies.secretStore ||
      !REMOTE_API_NAMES.includes(query.provider as RemoteApiName)
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_API_PROVIDER",
          message: "Choose a supported API provider.",
        },
      });
    return {
      provider: query.provider,
      configured: await dependencies.secretStore.has(
        remoteApiSecretKey(profileId, query.provider as RemoteApiName),
      ),
    };
  });

  app.delete("/api/v1/inference/api-credential", async (request, reply) => {
    const input = request.body as
      { profileId?: unknown; provider?: unknown } | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (
      !dependencies.secretStore ||
      !REMOTE_API_NAMES.includes(input?.provider as RemoteApiName)
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_API_PROVIDER",
          message: "Choose a supported API provider.",
        },
      });
    await dependencies.secretStore.delete(
      remoteApiSecretKey(profileId, input!.provider as RemoteApiName),
    );
    dependencies.agentRouter?.clearModelCache(
      input!.provider as RemoteApiName,
      profileId,
    );
    return { provider: input!.provider, configured: false };
  });

  app.post("/api/v1/inference/agent/verify", async (request, reply) => {
    const input = request.body as
      { profileId?: unknown; model?: unknown } | undefined;
    const profileId = requestProfileId(input?.profileId);
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    if (
      typeof input?.model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(input.model)
    )
      return reply.code(400).send({
        error: {
          code: "INVALID_AGENT_MODEL",
          message: "Choose a valid installed Ollama model.",
        },
      });
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    const result = await preflightOllama({
      fetch: dependencies.fetch,
      config: { ...config, model: input.model },
      now: dependencies.now,
    });
    return { ok: result.ok, model: input.model, message: result.message };
  });

  app.post("/api/v1/inference/agent/connect", async (request, reply) => {
    const profileId = requestProfileId(
      (request.body as { profileId?: unknown } | undefined)?.profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    let selection: ManualAgentConfig;
    try {
      selection = parseManualAgentConfig(request.body);
    } catch {
      return reply.code(400).send({
        error: {
          code: "LOCAL_AGENT_ADDRESS_INVALID",
          message:
            "Enter a valid local or private Ollama API address and model.",
        },
      });
    }
    const result = await preflightOllama({
      fetch: dependencies.fetch,
      config: {
        ...(dependencies.configForProfile?.(profileId) ?? dependencies.config),
        ...selection,
      },
      now: dependencies.now,
    });
    if (!result.ok) return result;
    dependencies.saveManualAgent(selection, profileId);
    await dependencies.integrationStateStore.set(
      {
        integrationId: "ollama",
        status: "connected",
        configured: true,
        checkedAt: result.checkedAt,
        updatedAt: result.checkedAt,
      },
      profileId,
    );
    return {
      ...result,
      baseUrl: selection.baseUrl,
      manual: true,
    };
  });

  app.post("/api/v1/inference/agent/pull", async (request, reply) => {
    const profileId = requestProfileId(
      (request.body as { profileId?: unknown } | undefined)?.profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });

    // The model and endpoint come only from the profile's validated Ollama
    // configuration. The browser cannot use this route to pull arbitrary IDs
    // or make the server send a request to an arbitrary address.
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      const response = await dependencies.fetch(`${config.baseUrl}/api/pull`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: config.model, stream: false }),
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok)
        return reply.code(502).send({
          error: {
            code: "OLLAMA_PULL_FAILED",
            message: "Ollama could not download the model.",
          },
        });
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("status" in body) ||
        body.status !== "success"
      )
        return reply.code(502).send({
          error: {
            code: "OLLAMA_PULL_FAILED",
            message: "Ollama did not confirm the model download.",
          },
        });
      dependencies.agentRouter?.clearLocalModelCache(profileId);
      request.log.info(
        { code: "OLLAMA_MODEL_PULLED", profileId, model: config.model },
        "Ollama model downloaded",
      );
      return { ok: true, model: config.model };
    } catch (cause) {
      request.log.warn(
        { code: "OLLAMA_PULL_FAILED", profileId, cause },
        "Ollama model download failed",
      );
      return reply.code(controller.signal.aborted ? 504 : 502).send({
        error: {
          code: "OLLAMA_PULL_FAILED",
          message: controller.signal.aborted
            ? "Ollama model download timed out."
            : "Ollama model download failed.",
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post("/api/v1/inference/discover", async (request, reply) => {
    const profileId = requestProfileId(
      (request.body as { profileId?: unknown } | undefined)?.profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await dependencies.fetch(`${config.baseUrl}/api/tags`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok) return { availableIds: [], runtimeAvailable: false };
      const body: unknown = await response.json();
      if (
        typeof body !== "object" ||
        body === null ||
        !("models" in body) ||
        !Array.isArray(body.models)
      ) {
        return { availableIds: [], runtimeAvailable: false };
      }
      const available = body.models.some(
        (model: unknown) =>
          typeof model === "object" &&
          model !== null &&
          (("name" in model && model.name === config.model) ||
            ("model" in model && model.model === config.model)),
      );
      return {
        availableIds: available ? ["ollama"] : [],
        runtimeAvailable: true,
      };
    } catch {
      return { availableIds: [], runtimeAvailable: false };
    } finally {
      clearTimeout(timeout);
    }
  });

  app.get("/api/v1/inference/residency", async (request) => {
    const profileId = requestProfileId(
      (request.query as { profileId?: unknown }).profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return { state: "unknown", checkedAt: dependencies.now().toISOString() };
    const config =
      dependencies.configForProfile?.(profileId) ?? dependencies.config;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    let state: "loaded" | "unloaded" | "unknown" = "unknown";
    try {
      const response = await dependencies.fetch(`${config.baseUrl}/api/ps`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
        redirect: "manual",
      });
      if (response.ok) {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          "models" in body &&
          Array.isArray(body.models)
        ) {
          state = body.models.some(
            (model: unknown) =>
              typeof model === "object" &&
              model !== null &&
              (("name" in model && model.name === config.model) ||
                ("model" in model && model.model === config.model)),
          )
            ? "loaded"
            : "unloaded";
        }
      }
    } catch {
      // An unavailable runtime is not proof that the model is cold.
    } finally {
      clearTimeout(timeout);
    }
    if (
      state === "unloaded" &&
      (request.query as { record?: string }).record === "true"
    ) {
      request.log.info(
        { model: config.model },
        "Local agent is not resident; waiting for Ollama to load it",
      );
    }
    return { state, checkedAt: dependencies.now().toISOString() };
  });

  app.post("/api/v1/inference/detect", async (request, reply) => {
    const profileId = requestProfileId(
      (request.body as { profileId?: unknown } | undefined)?.profileId,
    );
    if (dependencies.profileExists && !dependencies.profileExists(profileId))
      return reply.code(404).send({
        error: {
          code: "PROFILE_NOT_FOUND",
          message: "This profile is not available.",
        },
      });
    const result = await preflightOllama({
      fetch: dependencies.fetch,
      config: dependencies.configForProfile?.(profileId) ?? dependencies.config,
      now: dependencies.now,
    });
    await dependencies.integrationStateStore.set(
      {
        integrationId: "ollama",
        status:
          result.state === "READY" || result.state === "DEGRADED"
            ? "connected"
            : result.state === "OFFLINE" || result.state === "OOM"
              ? "unavailable"
              : "action_required",
        configured: result.ok,
        checkedAt: result.checkedAt,
        updatedAt: result.checkedAt,
      },
      profileId,
    );
    return result;
  });
}
