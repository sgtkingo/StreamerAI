import type {
  AgentCapabilities,
  AgentGenerationRequest,
  AgentGenerationResult,
  ProviderContext,
  ProviderHealth,
} from "@streamer-ai/contracts";
import type { SecretStore } from "../stores/secret-store.js";
import { profileSecretKey } from "../stores/secret-store.js";
import {
  fallbackCatalog,
  modelOption,
  recommendedModel,
  type AgentModelCatalog,
  type ReasoningEffort,
} from "./agent-model-catalog.js";

export type RemoteApiName =
  "openai" | "anthropic" | "gemini" | "grok" | "kimi" | "deepseek";
export const REMOTE_API_NAMES: readonly RemoteApiName[] = [
  "openai",
  "anthropic",
  "gemini",
  "grok",
  "kimi",
  "deepseek",
];
const endpoints: Record<RemoteApiName, string> = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  grok: "https://api.x.ai/v1/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
};
const MAX_BYTES = 2 * 1024 * 1024;
const modelEndpoints: Record<RemoteApiName, string> = {
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/models",
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  grok: "https://api.x.ai/v1/language-models",
  kimi: "https://api.moonshot.ai/v1/models",
  deepseek: "https://api.deepseek.com/models",
};

export function remoteApiSecretKey(
  profileId: string,
  provider: RemoteApiName,
): string {
  return profileSecretKey(profileId, `inference.api.${provider}`);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function supported(value: unknown): boolean {
  return object(value).supported === true;
}

type AnthropicFeatures = {
  disabled: boolean;
  adaptive: boolean;
  efforts: Set<ReasoningEffort>;
};

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((item) => {
        const part = object(item);
        return typeof part.text === "string" ? part.text : "";
      })
      .join("");
  return "";
}

export class RemoteApiAgent {
  private readonly modelCache = new Map<
    string,
    { expires: number; catalog: AgentModelCatalog }
  >();
  private readonly anthropicFeatures = new Map<string, AnthropicFeatures>();
  constructor(
    private readonly secrets: SecretStore,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}
  clearModelCache(provider: RemoteApiName, profileId: string): void {
    this.modelCache.delete(`${profileId}:${provider}`);
    if (provider === "anthropic")
      for (const key of this.anthropicFeatures.keys())
        if (key.startsWith(`${profileId}:`)) this.anthropicFeatures.delete(key);
  }
  cachedRecommendedModel(
    provider: RemoteApiName,
    profileId: string,
    effort: ReasoningEffort = "low",
  ): string | null {
    const cached = this.modelCache.get(`${profileId}:${provider}`);
    return cached && cached.expires > this.now().getTime()
      ? recommendedModel(provider, cached.catalog.models, effort)
      : null;
  }

  async listModels(
    provider: RemoteApiName,
    profileId: string,
  ): Promise<AgentModelCatalog> {
    const cacheKey = `${profileId}:${provider}`;
    const cached = this.modelCache.get(cacheKey);
    if (cached && cached.expires > this.now().getTime()) return cached.catalog;
    const key = await this.secrets.get(remoteApiSecretKey(profileId, provider));
    if (!key)
      return fallbackCatalog(
        provider,
        "Save an API key to verify which models this account can use.",
      );
    const headers: Record<string, string> = { accept: "application/json" };
    if (provider === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (provider === "gemini") headers["x-goog-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
    const models = new Map<string, ReturnType<typeof modelOption>>();
    let pageToken: string | null = null;
    try {
      for (let page = 0; page < 3; page++) {
        const url = new URL(modelEndpoints[provider]);
        if (pageToken && provider === "gemini")
          url.searchParams.set("pageToken", pageToken);
        if (pageToken && provider === "anthropic")
          url.searchParams.set("after_id", pageToken);
        const response = await this.fetcher(url.toString(), {
          method: "GET",
          headers,
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok)
          throw new Error(`Model discovery returned HTTP ${response.status}.`);
        const bodyText = await response.text();
        if (Buffer.byteLength(bodyText) > MAX_BYTES)
          throw new Error("Model catalog response is too large.");
        const body = object(JSON.parse(bodyText));
        const rows = Array.isArray(body.data)
          ? body.data
          : Array.isArray(body.models)
            ? body.models
            : [];
        for (const row of rows) {
          const info = object(row);
          const rawId = typeof info.id === "string" ? info.id : info.name;
          if (typeof rawId !== "string") continue;
          const id = rawId.replace(/^models\//, "");
          if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(id)) continue;
          const relevant =
            provider === "openai"
              ? /^(gpt-|o\d)/.test(id) &&
                !/audio|image|realtime|transcrib|search|embedding|tts/.test(id)
              : provider === "anthropic"
                ? id.startsWith("claude-") &&
                  info.lifecycle !== "retired" &&
                  !(
                    object(object(info.capabilities).structured_outputs)
                      .supported === false
                  )
                : provider === "gemini"
                  ? id.startsWith("gemini-") &&
                    (!Array.isArray(info.supportedGenerationMethods) ||
                      info.supportedGenerationMethods.includes(
                        "generateContent",
                      ))
                  : provider === "grok"
                    ? id.startsWith("grok-") &&
                      (!Array.isArray(info.output_modalities) ||
                        info.output_modalities.includes("text"))
                    : provider === "kimi"
                      ? id.startsWith("kimi-")
                      : id.startsWith("deepseek-") &&
                        (!Array.isArray(info.output_modalities) ||
                          info.output_modalities.includes("text"));
          if (!relevant) continue;
          const label =
            typeof info.display_name === "string"
              ? info.display_name
              : typeof info.displayName === "string"
                ? info.displayName
                : typeof info.name === "string"
                  ? info.name
                  : id;
          let efforts: ReasoningEffort[] | undefined;
          if (provider === "anthropic" && info.capabilities) {
            const capabilities = object(info.capabilities);
            const effort = object(capabilities.effort);
            const thinking = object(object(capabilities.thinking).types);
            const levels = (["low", "medium", "high"] as const).filter(
              (level) => supported(effort[level]),
            );
            const disabled = supported(thinking.disabled);
            efforts = [...(disabled ? (["none"] as const) : []), ...levels];
            this.anthropicFeatures.set(`${profileId}:${id}`, {
              disabled,
              adaptive: supported(thinking.adaptive),
              efforts: new Set(levels),
            });
          } else if (provider === "deepseek") {
            const levels = object(info.effort).supported_levels;
            if (Array.isArray(levels))
              efforts = [
                "none",
                ...(["low", "high"] as const).filter((level) =>
                  levels.includes(level),
                ),
              ];
          }
          if (efforts?.length === 0) continue;
          models.set(id, modelOption(provider, id, label, efforts));
          if (models.size >= 100) break;
        }
        if (models.size >= 100) break;
        pageToken =
          provider === "gemini" && typeof body.nextPageToken === "string"
            ? body.nextPageToken
            : provider === "anthropic" &&
                body.has_more === true &&
                typeof body.last_id === "string"
              ? body.last_id
              : null;
        if (!pageToken) break;
      }
      if (!models.size)
        throw new Error("No supported text models were listed.");
      const catalog: AgentModelCatalog = {
        provider,
        models: [...models.values()],
        recommendedModel: recommendedModel(provider, [...models.values()]),
        source: "provider",
        status: "available",
        message:
          "Model IDs were returned for this API key. Reasoning modes use provider capabilities where available and documented family defaults otherwise; generation access and quota are checked on use.",
      };
      this.modelCache.set(cacheKey, {
        expires: this.now().getTime() + 300_000,
        catalog,
      });
      return catalog;
    } catch {
      return fallbackCatalog(
        provider,
        "Could not verify models with this API key; the suggested model may be unavailable.",
      );
    }
  }

  async status(
    provider: RemoteApiName,
    profileId: string,
  ): Promise<{ available: boolean; code: string; message: string }> {
    const hasKey = await this.secrets.has(
      remoteApiSecretKey(profileId, provider),
    );
    return hasKey
      ? {
          available: true,
          code: "CONFIGURED",
          message: `${provider} API key is stored; model access is checked on the first request.`,
        }
      : {
          available: false,
          code: "CREDENTIAL_REQUIRED",
          message: `Configure a ${provider} API key for this profile.`,
        };
  }

  async health(
    provider: RemoteApiName,
    profileId: string,
  ): Promise<ProviderHealth> {
    const status = await this.status(provider, profileId);
    return {
      status: status.available ? "healthy" : "unavailable",
      checkedAt: this.now().toISOString(),
      latencyMs: 0,
      code: status.available ? null : "INVALID_CREDENTIALS",
      connectorVersion: "0.1.0",
    };
  }

  capabilities(provider: RemoteApiName, model: string): AgentCapabilities {
    return {
      models: [model],
      structuredOutput: true,
      toolCalling: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
      checkedAt: this.now().toISOString(),
    };
  }

  async generateStructured<TOutput>(
    provider: RemoteApiName,
    request: AgentGenerationRequest,
    context: ProviderContext,
    reasoningEffort: ReasoningEffort = "low",
  ): Promise<AgentGenerationResult<TOutput>> {
    const key = await this.secrets.get(
      remoteApiSecretKey(context.profileId ?? "default", provider),
    );
    if (!key) throw new Error(`${provider} API key is not configured.`);
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    let url = endpoints[provider];
    let body: Record<string, unknown>;
    if (provider === "openai") {
      headers.authorization = `Bearer ${key}`;
      body = {
        model: request.model,
        input: [
          {
            role: "developer",
            content: `Return only JSON matching this schema: ${JSON.stringify(request.outputJsonSchema)}`,
          },
          ...request.messages.map(({ role, content }) => ({
            role:
              role === "tool" ? "user" : role === "system" ? "developer" : role,
            content,
          })),
        ],
        text: { format: { type: "json_object" } },
        ...(request.model.startsWith("gpt-6") ||
        request.model.startsWith("gpt-5")
          ? { reasoning: { effort: reasoningEffort } }
          : {}),
        max_output_tokens: request.maxOutputTokens,
        store: false,
      };
    } else if (provider === "anthropic") {
      headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
      const feature = this.anthropicFeatures.get(
        `${context.profileId ?? "default"}:${request.model}`,
      );
      const knownHaiku = request.model.includes("haiku-5-5");
      const knownModern = /-(?:haiku|sonnet|opus)-5-5/.test(request.model);
      const supportsEffort = feature
        ? feature.efforts.has(reasoningEffort)
        : knownModern && reasoningEffort !== "none";
      const thinking =
        reasoningEffort === "none"
          ? feature?.disabled || (!feature && knownHaiku)
            ? { type: "disabled" }
            : undefined
          : feature?.adaptive || (!feature && knownModern)
            ? { type: "adaptive" }
            : undefined;
      body = {
        model: request.model,
        system: request.messages
          .filter((item) => item.role === "system")
          .map((item) => item.content)
          .join("\n\n"),
        messages: request.messages
          .filter((item) => item.role !== "system")
          .map((item) => ({
            role: item.role === "assistant" ? "assistant" : "user",
            content: item.content,
          })),
        max_tokens: request.maxOutputTokens,
        output_config: {
          format: { type: "json_schema", schema: request.outputJsonSchema },
          ...(supportsEffort ? { effort: reasoningEffort } : {}),
        },
        ...(thinking ? { thinking } : {}),
      };
    } else if (provider === "gemini") {
      headers["x-goog-api-key"] = key;
      url = `${url}/models/${encodeURIComponent(request.model)}:generateContent`;
      body = {
        systemInstruction: {
          parts: [
            {
              text: request.messages
                .filter((item) => item.role === "system")
                .map((item) => item.content)
                .join("\n\n"),
            },
          ],
        },
        contents: request.messages
          .filter((item) => item.role !== "system")
          .map((item) => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }],
          })),
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: request.outputJsonSchema,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          ...(request.model.startsWith("gemini-3")
            ? {
                thinkingConfig: {
                  thinkingLevel:
                    reasoningEffort === "none" ? "minimal" : reasoningEffort,
                },
              }
            : {}),
        },
      };
    } else {
      headers.authorization = `Bearer ${key}`;
      body = {
        model: request.model,
        messages: [
          {
            role: "system",
            content: `Return only JSON matching this schema: ${JSON.stringify(request.outputJsonSchema)}`,
          },
          ...request.messages.map(({ role, content }) => ({
            role: role === "tool" ? "user" : role,
            content,
          })),
        ],
        max_tokens: request.maxOutputTokens,
        ...(provider === "kimi"
          ? {}
          : { response_format: { type: "json_object" } }),
        ...(provider === "grok" && request.model.startsWith("grok-4.3")
          ? { reasoning_effort: reasoningEffort }
          : {}),
        ...(provider === "kimi"
          ? request.model.includes("k2.6")
            ? {
                thinking: {
                  type: reasoningEffort === "none" ? "disabled" : "enabled",
                },
              }
            : {
                reasoning_effort:
                  reasoningEffort === "none"
                    ? "low"
                    : reasoningEffort === "medium"
                      ? "high"
                      : reasoningEffort,
              }
          : {}),
        ...(provider === "deepseek"
          ? {
              thinking: {
                type: reasoningEffort === "none" ? "disabled" : "enabled",
              },
              ...(reasoningEffort === "none"
                ? {}
                : {
                    reasoning_effort:
                      reasoningEffort === "medium" ? "high" : reasoningEffort,
                  }),
            }
          : {}),
      };
    }
    const response = await this.fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.any([
        context.signal ?? new AbortController().signal,
        AbortSignal.timeout(120_000),
      ]),
    });
    if (!response.ok)
      throw new Error(
        `${provider} API request failed (HTTP ${response.status}).`,
      );
    const responseText = await response.text();
    if (Buffer.byteLength(responseText) > MAX_BYTES)
      throw new Error(`${provider} API response is too large.`);
    let payload: Record<string, unknown>;
    try {
      payload = object(JSON.parse(responseText));
    } catch {
      throw new Error(`${provider} API returned invalid JSON.`);
    }
    let outputText = "";
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    const usage = object(payload.usage);
    if (provider === "openai") {
      outputText = textContent(payload.output_text);
      if (!outputText && Array.isArray(payload.output))
        outputText = payload.output
          .map((item) => textContent(object(item).content))
          .join("");
      inputTokens =
        typeof usage.input_tokens === "number" ? usage.input_tokens : null;
      outputTokens =
        typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    } else if (provider === "anthropic") {
      outputText = textContent(payload.content);
      inputTokens =
        typeof usage.input_tokens === "number" ? usage.input_tokens : null;
      outputTokens =
        typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    } else if (provider === "gemini") {
      const candidate = Array.isArray(payload.candidates)
        ? object(payload.candidates[0])
        : {};
      outputText = textContent(object(candidate.content).parts);
      const metadata = object(payload.usageMetadata);
      inputTokens =
        typeof metadata.promptTokenCount === "number"
          ? metadata.promptTokenCount
          : null;
      outputTokens =
        typeof metadata.candidatesTokenCount === "number"
          ? metadata.candidatesTokenCount
          : null;
    } else {
      const choice = Array.isArray(payload.choices)
        ? object(payload.choices[0])
        : {};
      outputText = textContent(object(choice.message).content);
      inputTokens =
        typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null;
      outputTokens =
        typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : null;
    }
    let output: TOutput;
    try {
      output = JSON.parse(outputText) as TOutput;
    } catch {
      throw new Error(`${provider} API returned no valid structured result.`);
    }
    return {
      output,
      model: request.model,
      finishReason: "completed",
      inputTokens,
      outputTokens,
      provenance: {
        providerId: provider,
        retrievedAt: this.now().toISOString(),
        connectorVersion: "0.1.0",
        confidence: 1,
        validationState: "unverified",
        expiresAt: null,
      },
    };
  }
}
