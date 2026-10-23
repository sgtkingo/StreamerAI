import type {
  AgentCapabilities,
  AgentGenerationRequest,
  AgentGenerationResult,
  AgentProvider,
  AgentProviderDescriptor,
  ProviderContext,
  ProviderHealth,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { RuntimeConfig } from "../runtime-config.js";
import { LocalAgentHost, type LocalAgentName } from "./local-agent-host.js";
import type { OllamaAgentProvider } from "./ollama-agent-provider.js";
import { effectiveOllamaEffort } from "./ollama-thinking.js";
import {
  CustomLocalAgent,
  parseCustomLocalAgentConfig,
  type CustomLocalAgentConfig,
} from "./custom-local-agent.js";
import {
  RemoteApiAgent,
  REMOTE_API_NAMES,
  type RemoteApiName,
} from "./remote-api-agent.js";
import { STREAMER_TOOLS, StreamerToolService } from "../mcp/streamer-tools.js";
import {
  effectiveEffort,
  FALLBACK_MODEL,
  fallbackCatalog,
  modelOption,
  recommendedModel,
  REASONING_EFFORTS,
  type AgentModelCatalog,
  type AgentName,
  type ReasoningEffort,
} from "./agent-model-catalog.js";

export type AgentSelection = RuntimeConfig["agent"];

export function agentSelectionKey(profileId: string): string {
  return `inference.agent-selection.${Buffer.from(profileId, "utf8").toString("base64url")}`;
}

function agentSessionKey(key: string): string {
  return `inference.agent-session.${Buffer.from(key, "utf8").toString("base64url")}`;
}

export function parseAgentSelection(value: unknown): AgentSelection {
  if (!value || typeof value !== "object")
    throw new Error("Invalid agent selection.");
  const input = value as Record<string, unknown>;
  const contextTokens = input.contextTokens;
  if (
    contextTokens !== undefined &&
    (typeof contextTokens !== "number" ||
      !Number.isInteger(contextTokens) ||
      contextTokens < 2048 ||
      contextTokens > 131072)
  )
    throw new Error(
      "Context size must be an integer between 2048 and 131072 tokens.",
    );
  const reasoningEffort =
    input.reasoningEffort === undefined ? "low" : input.reasoningEffort;
  if (!REASONING_EFFORTS.includes(reasoningEffort as ReasoningEffort))
    throw new Error("Unsupported reasoning effort.");
  const model = input.model;
  if (
    model !== undefined &&
    (typeof model !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(model))
  )
    throw new Error("Invalid model ID.");
  const options = {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(model ? { model } : {}),
    reasoningEffort: reasoningEffort as ReasoningEffort,
  };
  if (input.mode === "disabled")
    return { mode: "disabled", provider: "ollama", ...options };
  if (input.mode === "mcp")
    return {
      mode: "mcp",
      provider: "ollama",
      reasoningEffort: reasoningEffort as ReasoningEffort,
    };
  if (
    input.mode === "api" &&
    (input.provider === "ollama" || input.provider === "custom")
  )
    return { mode: "api", provider: input.provider, ...options };
  if (
    input.mode === "api" &&
    REMOTE_API_NAMES.includes(input.provider as RemoteApiName)
  )
    return {
      mode: "api",
      provider: input.provider as RemoteApiName,
      ...options,
    };
  if (
    input.mode === "local" &&
    (input.provider === "codex" || input.provider === "claude")
  )
    return { mode: "local", provider: input.provider, ...options };
  throw new Error("This agent mode and provider combination is unavailable.");
}

/** Keeps discovery independent of each CLI protocol and enforces one active backend. */
export class AgentRouter implements AgentProvider {
  private readonly ollamaCatalogCache = new Map<
    string,
    { expires: number; catalog: AgentModelCatalog }
  >();
  constructor(
    private readonly database: StreamerDatabase,
    private readonly defaults: AgentSelection,
    private readonly ollama: AgentProvider,
    private readonly remoteApi: RemoteApiAgent,
    private readonly tools: StreamerToolService,
    private readonly now: () => Date = () => new Date(),
    private readonly host: LocalAgentHost = new LocalAgentHost(),
    private readonly ollamaReady: (
      profileId: string,
    ) => Promise<boolean> = async () => false,
    private readonly ollamaCatalog: (
      profileId: string,
    ) => Promise<AgentModelCatalog> = async () =>
      fallbackCatalog("ollama", "Ollama model discovery is unavailable."),
    private readonly custom: CustomLocalAgent = new CustomLocalAgent(database),
  ) {}
  customConfig(profileId: string): CustomLocalAgentConfig | null {
    return this.custom.config(profileId);
  }
  saveCustomConfig(profileId: string, value: unknown): CustomLocalAgentConfig {
    return this.custom.save(profileId, value);
  }
  async verifyCustom(profileId: string, candidate?: unknown): Promise<boolean> {
    const config = candidate
      ? parseCustomLocalAgentConfig(candidate)
      : this.custom.config(profileId);
    if (!config) return false;
    const catalog = await this.custom.listModels(profileId, config);
    if (
      catalog.status !== "available" ||
      !catalog.models.some((item) => item.id === config.model)
    )
      return false;
    try {
      const result = await this.custom.generateStructured<{ ready: boolean }>(
        {
          model: config.model,
          messages: [{ role: "user", content: 'Return {"ready":true}.' }],
          outputSchemaName: "agent_ready",
          outputJsonSchema: {
            type: "object",
            properties: { ready: { type: "boolean" } },
            required: ["ready"],
          },
          allowedToolNames: [],
          temperature: 0,
          maxOutputTokens: 32,
        },
        {
          requestId: `custom-verify-${Date.now()}`,
          profileId,
          locale: "en",
          deadlineAt: new Date(Date.now() + 15_000).toISOString(),
          secretRef: null,
          signal: AbortSignal.timeout(15_000),
        },
        config,
      );
      return result.output.ready === true;
    } catch {
      return false;
    }
  }
  clearLocalModelCache(profileId: string): void {
    this.ollamaCatalogCache.delete(profileId);
  }
  selection(profileId: string): AgentSelection {
    const saved = this.database.settings.get<unknown>(
      agentSelectionKey(profileId),
    );
    if (saved === null) return this.defaults;
    try {
      return parseAgentSelection(saved);
    } catch {
      return this.defaults;
    }
  }
  contextTokens(profileId: string, fallback: number): number {
    const selection = this.selection(profileId);
    const requested = selection.contextTokens ?? fallback;
    if (selection.mode !== "api" || selection.provider !== "ollama")
      return requested;
    const models = this.ollamaCatalogCache.get(profileId)?.catalog.models ?? [];
    const id =
      selection.model ??
      recommendedModel("ollama", models, selection.reasoningEffort ?? "low");
    return Math.min(
      requested,
      models.find((item) => item.id === id)?.maxContextTokens ?? requested,
    );
  }
  async select(profileId: string, selection: AgentSelection): Promise<void> {
    const parsed = parseAgentSelection(selection);
    if (
      parsed.mode === "api" &&
      parsed.provider === "ollama" &&
      parsed.contextTokens !== undefined
    ) {
      const catalog = await this.models("ollama", profileId);
      const id =
        parsed.model ??
        recommendedModel(
          "ollama",
          catalog.models,
          parsed.reasoningEffort ?? "low",
        );
      const maximum = catalog.models.find(
        (item) => item.id === id,
      )?.maxContextTokens;
      if (maximum && parsed.contextTokens > maximum)
        throw new Error(
          `The selected model supports at most ${maximum} context tokens.`,
        );
    }
    if (parsed.mode !== "disabled" && parsed.mode !== "mcp" && parsed.model) {
      const catalog = await this.models(parsed.provider, profileId);
      if (catalog.status === "available") {
        const option = catalog.models.find((item) => item.id === parsed.model);
        if (!option) throw new Error("The selected model is not available.");
        if (!option.reasoningEfforts.includes(parsed.reasoningEffort ?? "low"))
          throw new Error(
            "This model does not support the selected reasoning effort.",
          );
      }
    }
    await this.host.close();
    this.database.settings.set(agentSelectionKey(profileId), parsed);
  }
  async models(
    provider: AgentName,
    profileId: string,
  ): Promise<AgentModelCatalog> {
    if (provider === "custom") return this.custom.listModels(profileId);
    if (provider === "ollama") {
      const cached = this.ollamaCatalogCache.get(profileId);
      if (cached && cached.expires > this.now().getTime())
        return cached.catalog;
      const catalog = await this.ollamaCatalog(profileId);
      if (catalog.status === "available")
        this.ollamaCatalogCache.set(profileId, {
          expires: this.now().getTime() + 60_000,
          catalog,
        });
      return catalog;
    }
    if (provider === "codex" || provider === "claude")
      return this.host.listModels(provider);
    return this.remoteApi.listModels(provider, profileId);
  }
  async localProviderStatus(profileId: string) {
    const [ollamaCatalog, ollamaConfigured, customCatalog, codex, claude] =
      await Promise.all([
        this.models("ollama", profileId),
        this.ollamaReady(profileId),
        this.models("custom", profileId),
        this.host.status("codex"),
        this.host.status("claude"),
      ]);
    const ollamaDetected = ollamaCatalog.status === "available";
    const customConfig = this.custom.config(profileId);
    const customReady =
      customCatalog.status === "available" &&
      customCatalog.models.some((item) => item.id === customConfig?.model);
    return [
      {
        provider: "ollama" as const,
        detected: ollamaDetected,
        ready: ollamaDetected && ollamaConfigured,
        code: ollamaDetected
          ? ollamaConfigured
            ? "READY"
            : "SETUP_REQUIRED"
          : "NOT_FOUND",
        message: ollamaDetected
          ? ollamaConfigured
            ? "Ollama is connected and has an installed model."
            : "Ollama models were found. Connect the runtime to finish setup."
          : ollamaCatalog.message,
        recommendedModel: ollamaCatalog.recommendedModel,
      },
      {
        provider: "custom" as const,
        detected: customConfig !== null,
        ready: customReady,
        code: customReady
          ? "READY"
          : customConfig
            ? "MODEL_UNAVAILABLE"
            : "SETUP_REQUIRED",
        message: customReady
          ? "Custom local agent is ready."
          : customCatalog.message,
        recommendedModel: customCatalog.recommendedModel,
      },
      ...(["codex", "claude"] as const).map((provider) => {
        const status = provider === "codex" ? codex : claude;
        return {
          provider,
          detected: status.code !== "NOT_INSTALLED",
          ready: status.available,
          code: status.code,
          message: status.message,
          recommendedModel: FALLBACK_MODEL[provider] ?? null,
        };
      }),
    ];
  }
  clearModelCache(provider: RemoteApiName, profileId: string): void {
    this.remoteApi.clearModelCache(provider, profileId);
  }
  cachedRecommendedModel(
    profileId: string,
    provider: AgentName,
    effort: ReasoningEffort = "low",
  ): string | null {
    if (provider === "custom")
      return this.custom.config(profileId)?.model ?? null;
    if (provider === "ollama")
      return recommendedModel(
        provider,
        this.ollamaCatalogCache.get(profileId)?.catalog.models ?? [],
        effort,
      );
    if (provider === "codex" || provider === "claude")
      return (
        this.host.cachedRecommendedModel(provider, effort) ??
        FALLBACK_MODEL[provider] ??
        null
      );
    return (
      this.remoteApi.cachedRecommendedModel(provider, profileId, effort) ??
      FALLBACK_MODEL[provider] ??
      null
    );
  }
  async deleteProfile(profileId: string): Promise<void> {
    await this.host.close();
    this.database.settings.delete(agentSelectionKey(profileId));
    for (const schema of [
      "streamer_ai_discovery_candidates",
      "streamer_ai_discovery_expansion",
      "streamer_ai_grounded_rank",
    ]) {
      for (const provider of ["codex", "claude"]) {
        this.database.settings.delete(
          agentSessionKey(`${provider}:${profileId}:${schema}`),
        );
      }
    }
  }
  async status(profileId: string) {
    const selection = this.selection(profileId);
    if (selection.mode === "disabled")
      return {
        ...selection,
        available: false,
        code: "DISABLED",
        message: "The agent is disabled.",
      };
    if (selection.mode === "mcp")
      return {
        ...selection,
        available: false,
        code: "MCP_HOST_REQUIRED",
        message:
          "MCP is selected. Connect an external host to use StreamerAI tools; no embedded agent will run.",
      };
    if (selection.mode === "api" && selection.provider === "ollama") {
      const configured = await this.ollamaReady(profileId);
      if (!configured)
        return {
          ...selection,
          available: false,
          code: "SETUP_REQUIRED",
          message:
            "Ollama must be connected and pass preflight for this profile.",
        };
      const catalog = await this.models("ollama", profileId);
      const effectiveModel =
        selection.model ??
        recommendedModel(
          "ollama",
          catalog.models,
          selection.reasoningEffort ?? "low",
        );
      const option = catalog.models.find((item) => item.id === effectiveModel);
      const available =
        catalog.status === "available" &&
        !!option &&
        (!selection.model ||
          option.reasoningEfforts.includes(selection.reasoningEffort ?? "low"));
      return {
        ...selection,
        available,
        code: available ? "CONFIGURED" : "MODEL_UNAVAILABLE",
        message: available
          ? "The selected Ollama model is installed."
          : catalog.message,
        effectiveModel,
        effectiveReasoningEffort: option
          ? effectiveOllamaEffort(selection.reasoningEffort ?? "low", option)
          : (selection.reasoningEffort ?? "low"),
      };
    }
    if (selection.mode === "api" && selection.provider === "custom") {
      const config = this.custom.config(profileId);
      const catalog = await this.custom.listModels(profileId);
      const effectiveModel = selection.model ?? config?.model ?? null;
      const available =
        catalog.status === "available" &&
        catalog.models.some((item) => item.id === effectiveModel);
      return {
        ...selection,
        available,
        code: available ? "CONFIGURED" : "SETUP_REQUIRED",
        message: available ? "Custom local agent is ready." : catalog.message,
        effectiveModel,
        effectiveReasoningEffort: "none" as const,
      };
    }
    if (selection.mode === "api") {
      const credential = await this.remoteApi.status(
        selection.provider as RemoteApiName,
        profileId,
      );
      if (!credential.available) return { ...selection, ...credential };
      const catalog = await this.models(selection.provider, profileId);
      const effectiveModel = selection.model ?? catalog.recommendedModel;
      const option = catalog.models.find((item) => item.id === effectiveModel);
      const available =
        catalog.status === "available" &&
        !!option &&
        (!selection.model ||
          option.reasoningEfforts.includes(selection.reasoningEffort ?? "low"));
      const effectiveReasoningEffort = option
        ? effectiveEffort(selection.reasoningEffort ?? "low", option)
        : (selection.reasoningEffort ?? "low");
      return {
        ...selection,
        available,
        code: available
          ? "CONFIGURED"
          : catalog.status === "available"
            ? "MODEL_UNAVAILABLE"
            : "MODEL_ACCESS_UNVERIFIED",
        message: available
          ? `The ${selection.provider} API key returned a model list; generation access and quota are checked on use.`
          : catalog.status === "available"
            ? "The selected model or reasoning effort is not available for this API key."
            : catalog.message,
        effectiveModel,
        effectiveReasoningEffort:
          selection.provider === "gemini" &&
          effectiveModel?.startsWith("gemini-3") &&
          selection.reasoningEffort === "none"
            ? "minimal"
            : effectiveReasoningEffort,
        ...(selection.provider === "gemini" &&
        effectiveModel?.startsWith("gemini-3") &&
        selection.reasoningEffort === "none"
          ? {
              reasoningNote: "Gemini minimal thinking may still use reasoning.",
            }
          : {}),
      };
    }
    const localStatus = await this.host.status(
      selection.provider as LocalAgentName,
    );
    if (!localStatus.available) return { ...selection, ...localStatus };
    const catalog = await this.models(selection.provider, profileId);
    const effectiveModel =
      selection.model ??
      recommendedModel(
        selection.provider,
        catalog.models,
        selection.reasoningEffort ?? "low",
      );
    const option = catalog.models.find((item) => item.id === effectiveModel);
    return {
      ...selection,
      ...localStatus,
      effectiveModel,
      effectiveReasoningEffort: option
        ? effectiveEffort(selection.reasoningEffort ?? "low", option)
        : (selection.reasoningEffort ?? "low"),
      ...(selection.provider === "claude" &&
      selection.reasoningEffort === "none"
        ? {
            reasoningNote:
              "Claude Code uses low effort; its CLI cannot guarantee thinking is disabled.",
          }
        : {}),
    };
  }
  descriptor(): AgentProviderDescriptor {
    return {
      id: "agent-router",
      family: "agent" as const,
      displayName: "Selected AI agent",
      connectorVersion: "0.1.0",
      capabilities: ["structured-output", "streaming", "local-agent"],
      supportedLocales: ["cs", "en", "de"],
      setupMode: "local-runtime" as const,
      credentialFields: [],
      canAutoDetect: true,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: null,
      privacySummary:
        "Only bounded discovery prompts reach the selected agent; CLI sign-in remains in the CLI.",
    };
  }
  async health(context: ProviderContext): Promise<ProviderHealth> {
    const selection = this.selection(context.profileId ?? "default");
    if (selection.mode === "api" && selection.provider === "ollama")
      return this.ollama.health(context);
    if (selection.mode === "api" && selection.provider !== "custom")
      return this.remoteApi.health(
        selection.provider as RemoteApiName,
        context.profileId ?? "default",
      );
    const status = await this.status(context.profileId ?? "default");
    return {
      status: status.available ? "healthy" : "unavailable",
      checkedAt: this.now().toISOString(),
      latencyMs: 0,
      code: status.available ? null : "PROVIDER_UNAVAILABLE",
      connectorVersion: "0.1.0",
    };
  }
  async capabilities(context: ProviderContext): Promise<AgentCapabilities> {
    const selection = this.selection(context.profileId ?? "default");
    if (selection.mode === "mcp" || selection.mode === "disabled")
      return {
        models: [],
        structuredOutput: false,
        toolCalling: false,
        maxContextTokens: 0,
        maxOutputTokens: 0,
        checkedAt: this.now().toISOString(),
      };
    if (selection.mode === "api" && selection.provider === "ollama")
      return this.ollama.capabilities(context);
    if (selection.mode === "api" && selection.provider === "custom")
      return {
        models: [
          selection.model ??
            this.custom.config(context.profileId ?? "default")?.model ??
            "",
        ].filter(Boolean),
        structuredOutput: true,
        toolCalling: false,
        maxContextTokens: 8192,
        maxOutputTokens: 4096,
        checkedAt: this.now().toISOString(),
      };
    if (selection.mode === "api")
      return this.remoteApi.capabilities(
        selection.provider as RemoteApiName,
        selection.model ??
          (
            await this.models(
              selection.provider,
              context.profileId ?? "default",
            )
          ).recommendedModel ??
          selection.provider,
      );
    return {
      models: [selection.provider],
      structuredOutput: true,
      toolCalling: false,
      maxContextTokens: 8192,
      maxOutputTokens: 4096,
      checkedAt: this.now().toISOString(),
    };
  }
  async generateStructured<TOutput>(
    request: AgentGenerationRequest,
    context: ProviderContext,
  ): Promise<AgentGenerationResult<TOutput>> {
    const selection = this.selection(context.profileId ?? "default");
    if (selection.mode === "disabled" || selection.mode === "mcp")
      throw new Error("No embedded agent is selected.");
    if (selection.mode === "api") {
      await this.host.close();
      const effort = selection.reasoningEffort ?? "low";
      if (selection.provider === "ollama") {
        const catalog = await this.models(
          "ollama",
          context.profileId ?? "default",
        );
        const id =
          selection.model ??
          recommendedModel("ollama", catalog.models, effort) ??
          request.model;
        const option =
          catalog.models.find((item) => item.id === id) ??
          modelOption("ollama", id);
        return (this.ollama as OllamaAgentProvider).generateStructured<TOutput>(
          { ...request, model: id },
          context,
          effectiveOllamaEffort(effort, option),
        );
      }
      if (selection.provider === "custom") {
        const id =
          selection.model ??
          this.custom.config(context.profileId ?? "default")?.model;
        if (!id) throw new Error("Custom local agent is not configured.");
        return this.custom.generateStructured<TOutput>(
          { ...request, model: id },
          context,
        );
      }
      const catalog = await this.models(
        selection.provider,
        context.profileId ?? "default",
      );
      const id =
        selection.model ??
        recommendedModel(selection.provider, catalog.models, effort);
      if (!id) throw new Error(`No ${selection.provider} model is available.`);
      const option =
        catalog.models.find((item) => item.id === id) ??
        modelOption(selection.provider, id);
      return this.remoteApi.generateStructured<TOutput>(
        selection.provider as RemoteApiName,
        { ...request, model: id },
        context,
        effectiveEffort(effort, option),
      );
    }
    const key = `${selection.provider}:${context.profileId ?? "default"}:${request.outputSchemaName}`;
    const storedId =
      this.database.settings.get<string>(agentSessionKey(key)) ?? undefined;
    const session = await this.host.startSession(
      selection.provider as LocalAgentName,
      key,
      storedId,
    );
    const catalog = await this.models(
      selection.provider,
      context.profileId ?? "default",
    );
    const effort = selection.reasoningEffort ?? "low";
    const model =
      selection.model ??
      recommendedModel(selection.provider, catalog.models, effort) ??
      undefined;
    const option = model
      ? (catalog.models.find((item) => item.id === model) ??
        modelOption(selection.provider, model))
      : null;
    const agentOptions = {
      ...(model ? { model } : {}),
      reasoningEffort: option ? effectiveEffort(effort, option) : effort,
    };
    if (session.id)
      this.database.settings.set(agentSessionKey(key), session.id);
    const prompt = [
      "You are the StreamerAI discovery reasoning backend. Use only the supplied text. Do not inspect files, run commands, or use other tools. Return only a JSON object matching the provided schema.",
      `JSON schema: ${JSON.stringify(request.outputJsonSchema)}`,
      ...request.messages.map(
        (item) => `${item.role.toUpperCase()}: ${item.content}`,
      ),
    ].join("\n\n");
    const allowed = STREAMER_TOOLS.filter((tool) =>
      request.allowedToolNames.includes(tool.name),
    );
    let response: string;
    if (allowed.length === 0) {
      response = await session.sendMessage(
        prompt,
        request.outputJsonSchema,
        context.signal,
        agentOptions,
      );
    } else {
      const choiceSchema = {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["final", "tool"] },
          result: { type: "object" },
          tool: {
            type: "object",
            properties: {
              name: { type: "string" },
              arguments: { type: "object" },
            },
          },
        },
      };
      let next = `${prompt}\n\nYou may call one of these StreamerAI tools if needed: ${JSON.stringify(allowed)}. Return JSON {"kind":"tool","tool":{"name":"...","arguments":{...}}} to call a tool, or {"kind":"final","result":<requested JSON>} to finish. Do not call a tool unless the supplied candidate facts are insufficient.`;
      response = "";
      for (let turn = 0; turn < 3; turn++) {
        const raw = await session.sendMessage(
          next,
          choiceSchema,
          context.signal,
          agentOptions,
        );
        let choice: Record<string, unknown>;
        try {
          choice = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          throw new Error(
            `${selection.provider} returned an invalid tool decision.`,
          );
        }
        if (choice.kind === "final") {
          response = JSON.stringify(choice.result);
          break;
        }
        const call =
          choice.tool && typeof choice.tool === "object"
            ? (choice.tool as Record<string, unknown>)
            : {};
        const name = call.name;
        if (
          choice.kind !== "tool" ||
          typeof name !== "string" ||
          !allowed.some((tool) => tool.name === name)
        )
          throw new Error(
            `${selection.provider} requested an unauthorized tool.`,
          );
        const args =
          call.arguments && typeof call.arguments === "object"
            ? (call.arguments as Record<string, unknown>)
            : {};
        const result = await this.tools.call(
          name,
          { ...args, profileId: context.profileId ?? "default" },
          context.signal,
        );
        next = `StreamerAI tool ${name} returned: ${JSON.stringify(result)}\n\nNow return {"kind":"final","result":<requested JSON>} matching ${JSON.stringify(request.outputJsonSchema)}. You may call another allowed tool only if needed.`;
      }
      if (!response)
        throw new Error(`${selection.provider} exceeded the tool call limit.`);
    }
    if (session.id)
      this.database.settings.set(agentSessionKey(key), session.id);
    let output: TOutput;
    try {
      output = JSON.parse(
        response
          .trim()
          .replace(/^```(?:json)?\s*/i, "")
          .replace(/\s*```$/, ""),
      ) as TOutput;
    } catch {
      throw new Error(`${selection.provider} returned invalid JSON.`);
    }
    return {
      output,
      model: model ?? selection.provider,
      finishReason: "completed",
      inputTokens: null,
      outputTokens: null,
      provenance: {
        providerId: selection.provider,
        retrievedAt: this.now().toISOString(),
        connectorVersion: "0.1.0",
        confidence: 1,
        validationState: "unverified",
        expiresAt: null,
      },
    };
  }
  async close(): Promise<void> {
    await this.host.close();
  }
}
