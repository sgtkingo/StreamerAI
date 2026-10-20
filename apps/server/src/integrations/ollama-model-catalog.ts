import type { RuntimeConfig } from "../runtime-config.js";
import type { InferenceFetch } from "./ollama-preflight.js";
import {
  fallbackCatalog,
  modelOption,
  recommendedModel,
  type AgentModel,
  type AgentModelCatalog,
  type ReasoningEffort,
} from "./agent-model-catalog.js";

/** Share Ollama model discovery across the picker, selection validation and status. */
export async function discoverOllamaModels(
  fetcher: InferenceFetch,
  config: RuntimeConfig["inference"],
): Promise<AgentModelCatalog> {
  const fallback: AgentModelCatalog = {
    ...fallbackCatalog(
      "ollama",
      "Ollama is offline or its installed models could not be read.",
    ),
    models: [modelOption("ollama", config.model, config.model, ["none"])],
    recommendedModel: config.model,
    status: "unavailable",
  };
  const signal = AbortSignal.timeout(5_000);
  try {
    const response = await fetcher(`${config.baseUrl}/api/tags`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal,
      redirect: "manual",
    });
    if (!response.ok) return fallback;
    const payload = (await response.json()) as { models?: unknown };
    const rows = Array.isArray(payload.models) ? payload.models : [];
    const entries = await Promise.all(
      rows.map(async (raw): Promise<AgentModel | null> => {
        if (!raw || typeof raw !== "object") return null;
        const row = raw as Record<string, unknown>;
        const id = typeof row.name === "string" ? row.name : row.model;
        if (
          typeof id !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)
        )
          return null;
        let efforts: ReasoningEffort[] = ["none"];
        try {
          const detail = await fetcher(`${config.baseUrl}/api/show`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: id }),
            signal,
            redirect: "manual",
          });
          if (detail.ok) {
            const info = (await detail.json()) as {
              thinking?: { values?: unknown };
              capabilities?: unknown;
            };
            const values = Array.isArray(info.thinking?.values)
              ? info.thinking.values
              : [];
            if (values.length) {
              efforts = [
                ...(values.includes(false) ? (["none"] as const) : []),
                ...(["low", "medium", "high"] as const).filter((effort) =>
                  values.includes(effort),
                ),
                ...(values.includes(true) && !values.includes("high")
                  ? (["high"] as const)
                  : []),
              ];
            } else if (
              Array.isArray(info.capabilities) &&
              info.capabilities.includes("thinking")
            ) {
              efforts = ["none", "high"];
            }
          }
        } catch {
          // The model remains selectable without thinking.
        }
        return modelOption("ollama", id, id, efforts);
      }),
    );
    const models = entries.filter((item): item is AgentModel => item !== null);
    if (!models.length) return fallback;
    return {
      provider: "ollama",
      models,
      recommendedModel: recommendedModel("ollama", models),
      source: "local",
      status: "available",
      message:
        "Installed Ollama models. Reasoning modes are read from each model when reported by Ollama.",
    };
  } catch {
    return fallback;
  }
}
