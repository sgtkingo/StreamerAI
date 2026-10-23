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
  discoveryFailure,
  traceDiscovery,
  type DiscoveryDiagnosticSink,
} from "../services/discovery-diagnostics.js";
import {
  ollamaThinkingValue,
  ollamaThinkingValues,
  type OllamaThinkingValue,
} from "./ollama-thinking.js";
import {
  isAbortFailure,
  ProviderRequestError,
  providerFailureForStatus,
} from "./provider-http.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const CONNECTOR_VERSION = "0.1.0";
const MAX_REASONING_TOKENS = 3_072;

function predictionBudget(
  request: AgentGenerationRequest,
  config: RuntimeConfig["inference"],
  think: OllamaThinkingValue | null,
): number {
  const finalTokens = Math.min(request.maxOutputTokens, config.maxOutputTokens);
  if (think === false) return finalTokens;
  // Ollama counts hidden thinking and final JSON against the same num_predict.
  // Keep the configured answer allowance, reserving room for thinking separately.
  // The estimate deliberately leaves headroom for chat-template and schema tokens.
  const inputBytes = Buffer.byteLength(
    JSON.stringify(request.messages) + JSON.stringify(request.outputJsonSchema),
    "utf8",
  );
  const estimatedInputTokens = Math.ceil(inputBytes / 3) + 128;
  const contextRoom = Math.max(1, config.contextTokens - estimatedInputTokens);
  return Math.min(finalTokens + MAX_REASONING_TOKENS, contextRoom);
}

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
  diagnostic?: DiscoveryDiagnosticSink;
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
  readonly #diagnostic: DiscoveryDiagnosticSink | undefined;
  readonly #thinkingValues = new Map<
    string,
    { expires: number; values: OllamaThinkingValue[] }
  >();

  constructor(options: OllamaAgentProviderOptions) {
    this.#config = options.config;
    this.#configForProfile = options.configForProfile ?? (() => this.#config);
    this.#fetch = options.fetch ?? defaultFetch;
    this.#now = options.now ?? (() => new Date());
    this.#diagnostic = options.diagnostic;
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
    const started = this.#now().getTime();
    traceDiscovery(this.#diagnostic, context, "DISCOVERY_AGENT_STARTED", {
      providerId: "ollama",
      model: request.model,
      schema: request.outputSchemaName,
      reasoningEffort,
    });
    try {
      const think = await this.thinkingValue(
        request.model,
        reasoningEffort,
        context,
      );
      const finalTokens = Math.min(
        request.maxOutputTokens,
        config.maxOutputTokens,
      );
      const call = async (
        wireThink: OllamaThinkingValue | null,
        phase: "initial" | "schema-repair",
        numPredict: number,
      ) => {
        const callStarted = this.#now().getTime();
        traceDiscovery(this.#diagnostic, context, "DISCOVERY_AGENT_OPTIONS", {
          providerId: "ollama",
          model: request.model,
          schema: request.outputSchemaName,
          phase,
          reasoningEffort,
          think: wireThink,
          contextTokens: config.contextTokens,
          answerTokens: finalTokens,
          numPredict,
        });
        const body = record(
          await this.request(
            "/api/chat",
            {
              model: request.model,
              messages: request.messages,
              stream: false,
              think: wireThink,
              format: request.outputJsonSchema,
              keep_alive: "5m",
              options: {
                num_ctx: config.contextTokens,
                num_predict: numPredict,
                temperature: request.temperature,
              },
            },
            context,
          ),
        );
        traceDiscovery(this.#diagnostic, context, "DISCOVERY_AGENT_RESPONSE", {
          providerId: "ollama",
          model: typeof body?.model === "string" ? body.model : request.model,
          schema: request.outputSchemaName,
          phase,
          durationMs: Math.max(0, this.#now().getTime() - callStarted),
          done: body?.done === true,
          doneReason:
            typeof body?.done_reason === "string" ? body.done_reason : null,
          inputTokens:
            typeof body?.prompt_eval_count === "number"
              ? body.prompt_eval_count
              : null,
          outputTokens:
            typeof body?.eval_count === "number" ? body.eval_count : null,
        });
        return body;
      };
      const parse = (body: Record<string, unknown> | null): TOutput => {
        const message = record(body?.message);
        if (typeof message?.content !== "string")
          throw new Error("Invalid structured response.");
        return JSON.parse(message.content) as TOutput;
      };
      let body = await call(
        think,
        "initial",
        predictionBudget(request, config, think),
      );
      let inputTokens =
        typeof body?.prompt_eval_count === "number"
          ? body.prompt_eval_count
          : null;
      let outputTokens =
        typeof body?.eval_count === "number" ? body.eval_count : null;
      let output: TOutput;
      try {
        output = parse(body);
      } catch {
        // A truncated hidden-thinking stream contains no usable final JSON.
        // One format repair can still answer from the original request, without
        // exposing or replaying hidden thinking or changing the saved effort.
        const remainingMs =
          Date.parse(context.deadlineAt) - this.#now().getTime();
        if (
          body?.done_reason !== "length" ||
          think === false ||
          remainingMs < 1_000 ||
          (await this.thinkingValue(request.model, "none", context)) !== false
        )
          throw new ProviderRequestError("ollama", "invalid-response", true);
        traceDiscovery(
          this.#diagnostic,
          context,
          "DISCOVERY_AGENT_REPAIR_STARTED",
          {
            providerId: "ollama",
            model: request.model,
            schema: request.outputSchemaName,
            reason: "thinking-exhausted-before-json",
            think: false,
            remainingMs,
          },
        );
        body = await call(false, "schema-repair", finalTokens);
        inputTokens =
          inputTokens === null || typeof body?.prompt_eval_count !== "number"
            ? null
            : inputTokens + body.prompt_eval_count;
        outputTokens =
          outputTokens === null || typeof body?.eval_count !== "number"
            ? null
            : outputTokens + body.eval_count;
        try {
          output = parse(body);
        } catch {
          throw new ProviderRequestError("ollama", "invalid-response", true);
        }
      }
      return {
        output,
        model: typeof body?.model === "string" ? body.model : request.model,
        finishReason:
          body?.done === false || body?.done_reason === "length"
            ? "length"
            : body?.done_reason === "load"
              ? "failed"
              : "completed",
        inputTokens,
        outputTokens,
        provenance: {
          providerId: "ollama",
          retrievedAt: this.#now().toISOString(),
          connectorVersion: CONNECTOR_VERSION,
          confidence: 1,
          validationState: "unverified",
          expiresAt: null,
        },
      };
    } catch (error) {
      traceDiscovery(this.#diagnostic, context, "DISCOVERY_AGENT_FAILED", {
        providerId: "ollama",
        model: request.model,
        schema: request.outputSchemaName,
        durationMs: Math.max(0, this.#now().getTime() - started),
        failure: discoveryFailure(error),
      });
      throw error;
    }
  }

  private async thinkingValue(
    model: string,
    effort: ReasoningEffort,
    context: ProviderContext,
  ): Promise<OllamaThinkingValue | null> {
    const config = this.#configForProfile(context.profileId ?? "default");
    const cacheKey = JSON.stringify([config.baseUrl, model]);
    const cached = this.#thinkingValues.get(cacheKey);
    let values =
      cached && cached.expires > this.#now().getTime() ? cached.values : null;
    if (!values) {
      values = ollamaThinkingValues(
        await this.request("/api/show", { model }, context),
      );
      this.#thinkingValues.set(cacheKey, {
        expires: this.#now().getTime() + 300_000,
        values,
      });
    }
    return ollamaThinkingValue(values, effort);
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
