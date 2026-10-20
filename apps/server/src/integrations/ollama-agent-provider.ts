import {
  AgentCapabilitiesSchema,
  AgentGenerationRequestSchema,
  ProviderHealthSchema,
  type AgentGenerationRequest,
  type AgentGenerationResult,
  type AgentProvider,
  type ProviderContext,
  type ProviderDescriptor,
  type ProviderHealth,
} from "@streamer-ai/contracts";
import type { RuntimeConfig } from "../runtime-config.js";
import type { ReasoningEffort } from "./agent-model-catalog.js";
import {
  isAbortFailure,
  ProviderRequestError,
  providerFailureForStatus,
} from "./provider-http.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONNECTOR_VERSION = "0.1.0";

export interface OllamaFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type OllamaFetch = (
  input: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect?: "manual";
  },
) => Promise<OllamaFetchResponse>;

export interface OllamaAgentProviderOptions {
  config: RuntimeConfig["inference"];
  configForProfile?: (profileId: string) => RuntimeConfig["inference"];
  fetch?: OllamaFetch;
  now?: () => Date;
}

function defaultFetch(
  input: string,
  init: Parameters<OllamaFetch>[1],
): Promise<OllamaFetchResponse> {
  return fetch(input, init);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Ollama implementation of the provider-neutral structured agent boundary. */
export class OllamaAgentProvider implements AgentProvider {
  readonly #config: RuntimeConfig["inference"];
  readonly #configForProfile: (profileId: string) => RuntimeConfig["inference"];
  readonly #fetch: OllamaFetch;
  readonly #now: () => Date;
  readonly #thinkingValues = new Map<
    string,
    { expires: number; values: unknown[] }
  >();

  constructor(options: OllamaAgentProviderOptions) {
    this.#config = options.config;
    this.#configForProfile = options.configForProfile ?? (() => this.#config);
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? (() => new Date());
  }

  descriptor(): ProviderDescriptor & { family: "agent" } {
    return {
      id: "ollama",
      family: "agent",
      displayName: "Local AI (Ollama)",
      connectorVersion: CONNECTOR_VERSION,
      capabilities: ["structured-output", "tool-calling", "local-inference"],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "local-runtime",
      credentialFields: [],
      canAutoDetect: true,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: "https://docs.ollama.com/",
      privacySummary:
        "Prompts remain on the configured Ollama host; remote hosts require explicit configuration.",
    };
  }

  async health(context: ProviderContext): Promise<ProviderHealth> {
    const config = this.#configForProfile(context.profileId ?? "default");
    const started = this.#now().getTime();
    try {
      const body = record(await this.request("/api/tags", undefined, context));
      const models = Array.isArray(body?.models) ? body.models : [];
      const installed = models.some((value) => {
        const item = record(value);
        return item?.name === config.model || item?.model === config.model;
      });
      return ProviderHealthSchema.parse({
        status: installed ? "healthy" : "degraded",
        checkedAt: this.#now().toISOString(),
        latencyMs: Math.max(0, this.#now().getTime() - started),
        code: installed ? null : "UNSUPPORTED_CAPABILITY",
        connectorVersion: CONNECTOR_VERSION,
      });
    } catch (error) {
      return ProviderHealthSchema.parse({
        status: "unavailable",
        checkedAt: this.#now().toISOString(),
        latencyMs: Math.max(0, this.#now().getTime() - started),
        code:
          error instanceof ProviderRequestError && error.kind === "timeout"
            ? "NETWORK_UNREACHABLE"
            : "PROVIDER_UNAVAILABLE",
        connectorVersion: CONNECTOR_VERSION,
      });
    }
  }

  async capabilities(context: ProviderContext) {
    const config = this.#configForProfile(context.profileId ?? "default");
    const body = record(
      await this.request(
        "/api/show",
        { model: config.model, verbose: false },
        context,
      ),
    );
    const capabilities = Array.isArray(body?.capabilities)
      ? body.capabilities.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return AgentCapabilitiesSchema.parse({
      models: [config.model],
      structuredOutput: capabilities.includes("completion"),
      toolCalling: capabilities.includes("tools"),
      maxContextTokens: config.contextTokens,
      maxOutputTokens: config.maxOutputTokens,
      checkedAt: this.#now().toISOString(),
    });
  }

  async generateStructured<TOutput>(
    rawRequest: AgentGenerationRequest,
    context: ProviderContext,
    reasoningEffort: ReasoningEffort = "none",
  ): Promise<AgentGenerationResult<TOutput>> {
    const request = AgentGenerationRequestSchema.parse(rawRequest);
    const config = this.#configForProfile(context.profileId ?? "default");
    const think = await this.thinkingValue(
      request.model,
      reasoningEffort,
      context,
    );
    const body = record(
      await this.request(
        "/api/chat",
        {
          model: request.model,
          messages: request.messages,
          stream: false,
          think,
          format: request.outputJsonSchema,
          keep_alive: "5m",
          options: {
            num_ctx: config.contextTokens,
            num_predict: Math.min(
              request.maxOutputTokens,
              config.maxOutputTokens,
            ),
            temperature: request.temperature,
          },
        },
        context,
      ),
    );
    const message = record(body?.message);
    if (typeof message?.content !== "string") {
      throw new ProviderRequestError("ollama", "invalid-response", true);
    }
    let output: TOutput;
    try {
      output = JSON.parse(message.content) as TOutput;
    } catch {
      throw new ProviderRequestError("ollama", "invalid-response", true);
    }
    return {
      output,
      model: typeof body?.model === "string" ? body.model : request.model,
      finishReason:
        body?.done === false
          ? "length"
          : body?.done_reason === "load"
            ? "failed"
            : "completed",
      inputTokens:
        typeof body?.prompt_eval_count === "number"
          ? body.prompt_eval_count
          : null,
      outputTokens:
        typeof body?.eval_count === "number" ? body.eval_count : null,
      provenance: {
        providerId: "ollama",
        retrievedAt: this.#now().toISOString(),
        connectorVersion: CONNECTOR_VERSION,
        confidence: 1,
        validationState: "unverified",
        expiresAt: null,
      },
    };
  }

  private async thinkingValue(
    model: string,
    effort: ReasoningEffort,
    context: ProviderContext,
  ): Promise<boolean | string> {
    if (effort === "none") return false;
    const cached = this.#thinkingValues.get(model);
    let values =
      cached && cached.expires > this.#now().getTime() ? cached.values : null;
    if (!values) {
      try {
        const details = record(
          await this.request("/api/show", { model }, context),
        );
        const thinking = record(details?.thinking);
        values = Array.isArray(thinking?.values) ? thinking.values : [];
        if (
          !values.length &&
          Array.isArray(details?.capabilities) &&
          details.capabilities.includes("thinking")
        )
          values = [false, true];
      } catch {
        values = [];
      }
      this.#thinkingValues.set(model, {
        expires: this.#now().getTime() + 300_000,
        values,
      });
    }
    if (values.includes(effort)) return effort;
    if (effort !== "low" && values.includes(true)) return true;
    return false;
  }

  private async request(
    path: string,
    body: unknown,
    context: ProviderContext,
  ): Promise<unknown> {
    const config = this.#configForProfile(context.profileId ?? "default");
    const controller = new AbortController();
    const deadlineMs = Math.max(
      1,
      Date.parse(context.deadlineAt) - this.#now().getTime(),
    );
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(config.timeoutMs, deadlineMs),
    );
    const signal = context.signal
      ? AbortSignal.any([controller.signal, context.signal])
      : controller.signal;
    try {
      signal.throwIfAborted();
      const response = await this.#fetch(`${config.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
        redirect: "manual",
      });
      if (!response.ok)
        throw providerFailureForStatus("ollama", response.status);
      const text = await response.text();
      signal.throwIfAborted();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
        throw new ProviderRequestError("ollama", "invalid-response", true);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ProviderRequestError("ollama", "invalid-response", true);
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (signal.aborted || isAbortFailure(error)) {
        throw new ProviderRequestError("ollama", "timeout", true);
      }
      throw new ProviderRequestError("ollama", "network", true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
