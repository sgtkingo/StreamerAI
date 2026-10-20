import type {
  AgentGenerationRequest,
  AgentGenerationResult,
  ProviderContext,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import {
  modelOption,
  recommendedModel,
  type AgentModelCatalog,
} from "./agent-model-catalog.js";
import { localHost } from "./manual-agent-config.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export interface CustomLocalAgentConfig {
  baseUrl: string;
  model: string;
}

function settingKey(profileId: string): string {
  return `inference.custom-agent.${Buffer.from(profileId, "utf8").toString("base64url")}`;
}

/** Accept only local or private OpenAI-compatible /v1 endpoints. */
export function parseCustomLocalAgentConfig(
  value: unknown,
): CustomLocalAgentConfig {
  if (!value || typeof value !== "object")
    throw new Error("Enter a local API address and model name.");
  const input = value as Record<string, unknown>;
  if (typeof input.baseUrl !== "string" || typeof input.model !== "string")
    throw new Error("Enter a local API address and model name.");
  const raw = input.baseUrl.trim();
  const model = input.model.trim();
  if (!raw || raw.length > 512 || !MODEL_ID.test(model))
    throw new Error("Enter a valid local API address and model name.");
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error("Enter a valid local API address.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !localHost(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/v1", "/v1/"].includes(url.pathname)
  )
    throw new Error(
      "Use a local or private HTTP(S) address ending in /v1, without credentials.",
    );
  return { baseUrl: `${url.origin}/v1`, model };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

async function responseBody(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw new Error("The local agent response is too large.");
  try {
    return object(JSON.parse(text));
  } catch {
    throw new Error("The local agent returned invalid JSON.");
  }
}

export class CustomLocalAgent {
  constructor(
    private readonly database: StreamerDatabase,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  config(profileId: string): CustomLocalAgentConfig | null {
    const saved = this.database.settings.get<unknown>(settingKey(profileId));
    if (saved === null) return null;
    try {
      return parseCustomLocalAgentConfig(saved);
    } catch {
      return null;
    }
  }

  save(profileId: string, value: unknown): CustomLocalAgentConfig {
    const config = parseCustomLocalAgentConfig(value);
    this.database.settings.set(settingKey(profileId), config);
    return config;
  }

  async listModels(
    profileId: string,
    candidate?: CustomLocalAgentConfig,
  ): Promise<AgentModelCatalog> {
    const config = candidate ?? this.config(profileId);
    if (!config)
      return {
        provider: "custom",
        models: [],
        recommendedModel: null,
        source: "local",
        status: "unavailable",
        message:
          "Set a local OpenAI-compatible API address and model in Custom settings.",
      };
    try {
      const response = await this.fetcher(`${config.baseUrl}/models`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error("Model list unavailable.");
      const body = await responseBody(response);
      const rows = Array.isArray(body.data) ? body.data : [];
      const models = [
        ...new Set(
          rows
            .map((row) => object(row).id)
            .filter(
              (id): id is string => typeof id === "string" && MODEL_ID.test(id),
            ),
        ),
      ].map((id) => modelOption("custom", id, id, ["none"]));
      return {
        provider: "custom",
        models,
        recommendedModel: models.some((item) => item.id === config.model)
          ? config.model
          : recommendedModel("custom", models),
        source: "local",
        status: models.length ? "available" : "unavailable",
        message: models.length
          ? "Local models found."
          : "No local models were listed.",
      };
    } catch {
      return {
        provider: "custom",
        models: [],
        recommendedModel: config.model,
        source: "local",
        status: "unavailable",
        message: "The local OpenAI-compatible model list is unavailable.",
      };
    }
  }

  async generateStructured<TOutput>(
    request: AgentGenerationRequest,
    context: ProviderContext,
    candidate?: CustomLocalAgentConfig,
  ): Promise<AgentGenerationResult<TOutput>> {
    const config = candidate ?? this.config(context.profileId ?? "default");
    if (!config) throw new Error("Custom local agent is not configured.");
    const response = await this.fetcher(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.any([
        context.signal ?? new AbortController().signal,
        AbortSignal.timeout(120_000),
      ]),
      body: JSON.stringify({
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
        response_format: { type: "json_object" },
        max_tokens: request.maxOutputTokens,
        temperature: request.temperature,
        stream: false,
      }),
    });
    if (!response.ok)
      throw new Error(
        `Custom local agent request failed (HTTP ${response.status}).`,
      );
    const body = await responseBody(response);
    const choice = Array.isArray(body.choices) ? object(body.choices[0]) : {};
    const content = object(choice.message).content;
    if (typeof content !== "string")
      throw new Error("Custom local agent returned no structured result.");
    let output: TOutput;
    try {
      output = JSON.parse(content) as TOutput;
    } catch {
      throw new Error("Custom local agent returned invalid structured JSON.");
    }
    const usage = object(body.usage);
    return {
      output,
      model: request.model,
      finishReason: "completed",
      inputTokens:
        typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : null,
      outputTokens:
        typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : null,
      provenance: {
        providerId: "custom",
        retrievedAt: this.now().toISOString(),
        connectorVersion: "0.1.0",
        confidence: 1,
        validationState: "unverified",
        expiresAt: null,
      },
    };
  }
}
