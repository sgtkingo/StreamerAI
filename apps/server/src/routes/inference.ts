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

export interface InferenceRouteDependencies {
  fetch: InferenceFetch;
  config: RuntimeConfig["inference"];
  integrationStateStore: IntegrationStateStore;
  now: () => Date;
  isManualAgent: () => boolean;
  saveManualAgent: (selection: ManualAgentConfig) => void;
}

export function registerInferenceRoutes(
  app: FastifyInstance,
  dependencies: InferenceRouteDependencies,
): void {
  app.get("/api/v1/inference/agent", async () => ({
    runtime: "Ollama",
    model: dependencies.config.model,
    baseUrl: dependencies.config.baseUrl,
    manual: dependencies.isManualAgent(),
  }));

  app.post("/api/v1/inference/agent/connect", async (request, reply) => {
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
      config: { ...dependencies.config, ...selection },
      now: dependencies.now,
    });
    if (!result.ok) return result;
    dependencies.saveManualAgent(selection);
    await dependencies.integrationStateStore.set({
      integrationId: "ollama",
      status: "connected",
      configured: true,
      checkedAt: result.checkedAt,
      updatedAt: result.checkedAt,
    });
    return {
      ...result,
      baseUrl: selection.baseUrl,
      manual: true,
    };
  });

  app.post("/api/v1/inference/discover", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await dependencies.fetch(
        `${dependencies.config.baseUrl}/api/tags`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
          redirect: "manual",
        },
      );
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
          (("name" in model && model.name === dependencies.config.model) ||
            ("model" in model && model.model === dependencies.config.model)),
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_500);
    let state: "loaded" | "unloaded" | "unknown" = "unknown";
    try {
      const response = await dependencies.fetch(
        `${dependencies.config.baseUrl}/api/ps`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal,
          redirect: "manual",
        },
      );
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
              (("name" in model && model.name === dependencies.config.model) ||
                ("model" in model &&
                  model.model === dependencies.config.model)),
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
        { model: dependencies.config.model },
        "Local agent is not resident; waiting for Ollama to load it",
      );
    }
    return { state, checkedAt: dependencies.now().toISOString() };
  });

  app.post("/api/v1/inference/detect", async () => {
    const result = await preflightOllama(dependencies);
    await dependencies.integrationStateStore.set({
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
    });
    return result;
  });
}
