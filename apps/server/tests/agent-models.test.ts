import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { openStreamerDatabase } from "@streamer-ai/database";
import type {
  AgentProvider,
  AgentGenerationRequest,
  ProviderContext,
} from "@streamer-ai/contracts";
import { AgentRouter } from "../src/integrations/agent-router.js";
import { OllamaAgentProvider } from "../src/integrations/ollama-agent-provider.js";
import { discoverOllamaModels } from "../src/integrations/ollama-model-catalog.js";
import {
  RemoteApiAgent,
  remoteApiSecretKey,
} from "../src/integrations/remote-api-agent.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { StreamerToolService } from "../src/mcp/streamer-tools.js";
import {
  discoveryTierForAgent,
  recommendedModel,
  modelOption,
} from "../src/integrations/agent-model-catalog.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

describe("agent model discovery and preferences", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("shows an unverified cheap suggestion before credentials are saved", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=openai",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: "openai",
      recommendedModel: "gpt-6-luna",
      source: "fallback",
      status: "unverified",
    });
  });

  it("recommends an accessible lightweight model and rejects unsupported expert effort", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "gpt-6-astra" }, { id: "gpt-6-luna" }],
          }),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      remoteApiFetch: fetcher as typeof fetch,
    });
    apps.push(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/inference/api-credential",
      payload: { provider: "openai", apiKey: "test-secret-key" },
    });
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=openai",
    });
    expect(catalog.json()).toMatchObject({
      source: "provider",
      status: "available",
      recommendedModel: "gpt-6-luna",
    });
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "openai",
        model: "gpt-6-astra",
        reasoningEffort: "none",
      },
    });
    expect(invalid.statusCode).toBe(400);
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { mode: "api", provider: "openai", reasoningEffort: "none" },
    });
    expect(selected.json()).toMatchObject({
      mode: "api",
      provider: "openai",
      reasoningEffort: "none",
      effectiveModel: "gpt-6-luna",
      available: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("uses provider-reported Anthropic reasoning support", async () => {
    const capabilities = (disabled: boolean) => ({
      structured_outputs: { supported: true },
      effort: {
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
      },
      thinking: {
        types: {
          disabled: { supported: disabled },
          adaptive: { supported: true },
        },
      },
    });
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "claude-opus-5-5", capabilities: capabilities(false) },
              { id: "claude-haiku-5-5", capabilities: capabilities(true) },
            ],
          }),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      remoteApiFetch: fetcher as typeof fetch,
    });
    apps.push(app);
    await app.inject({
      method: "PUT",
      url: "/api/v1/inference/api-credential",
      payload: { provider: "anthropic", apiKey: "test-secret-key" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=anthropic",
    });
    const models = response.json().models as {
      id: string;
      reasoningEfforts: string[];
    }[];
    expect(
      models.find((item) => item.id === "claude-opus-5-5")?.reasoningEfforts,
    ).toEqual(["low", "medium", "high"]);
    expect(
      models.find((item) => item.id === "claude-haiku-5-5")?.reasoningEfforts,
    ).toEqual(["none", "low", "medium", "high"]);
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "anthropic",
        model: "claude-opus-5-5",
        reasoningEffort: "none",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("uses the recommended account model and selected reasoning for generation", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    const secrets = new NonPersistentMemorySecretStore();
    await secrets.set(
      remoteApiSecretKey("default", "openai"),
      "test-secret-key",
    );
    const fetcher = vi.fn(
      async (url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            url.endsWith("/models")
              ? { data: [{ id: "gpt-6-astra" }, { id: "gpt-6-luna" }] }
              : { output_text: '{"ok":true}' },
          ),
          { status: 200 },
        ),
    );
    const router = new AgentRouter(
      database,
      { mode: "api", provider: "openai", reasoningEffort: "none" },
      {} as AgentProvider,
      new RemoteApiAgent(secrets, fetcher as typeof fetch),
      {} as StreamerToolService,
    );
    const request: AgentGenerationRequest = {
      model: "placeholder",
      messages: [{ role: "user", content: "Return JSON." }],
      outputSchemaName: "result",
      outputJsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      allowedToolNames: [],
      temperature: 0,
      maxOutputTokens: 128,
    };
    const result = await router.generateStructured<{ ok: boolean }>(request, {
      profileId: "default",
    } as ProviderContext);
    expect(result.model).toBe("gpt-6-luna");
    expect(result.output.ok).toBe(true);
    const post = fetcher.mock.calls.find(
      ([, init]) => (init as RequestInit).method === "POST",
    ) as unknown as [string, RequestInit];
    expect(JSON.parse(post[1].body as string)).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
    });
    await router.close();
    database.close();
  });

  it("ranks installed local models by size when no default is configured", () => {
    expect(
      recommendedModel("ollama", [
        modelOption("ollama", "qwen3.5:32b"),
        modelOption("ollama", "qwen3.5:4b"),
      ]),
    ).toBe("qwen3.5:4b");
  });

  it("changes the automatic model when the requested thinking mode requires it", () => {
    const models = [
      modelOption("ollama", "qwen3.5:4b", undefined, ["none"]),
      modelOption("ollama", "qwen3.5:32b", undefined, ["high"]),
    ];
    expect(recommendedModel("ollama", models, "none")).toBe("qwen3.5:4b");
    expect(recommendedModel("ollama", models, "high")).toBe("qwen3.5:32b");
  });

  it("chooses search instruction depth by model independently of reasoning", () => {
    expect(discoveryTierForAgent("openai")).toBe("balanced");
    expect(discoveryTierForAgent("anthropic", "claude-haiku-5-5")).toBe(
      "balanced",
    );
    expect(discoveryTierForAgent("openai", "gpt-6-astra")).toBe("extended");
    expect(discoveryTierForAgent("deepseek", "deepseek-v4-pro")).toBe(
      "extended",
    );
  });

  it("reads installed Ollama models and their thinking controls", async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/tags")
              ? { models: [{ name: "qwen3.5:32b" }, { name: "qwen3.5:4b" }] }
              : { thinking: { values: [false, true] } },
          ),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as typeof fetch,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama",
    });
    expect(response.json()).toMatchObject({
      source: "local",
      status: "available",
      recommendedModel: "qwen3.5:4b",
      models: [
        {
          id: "qwen3.5:32b",
          reasoningEfforts: ["none", "high"],
        },
        {
          id: "qwen3.5:4b",
          reasoningEfforts: ["none", "high"],
        },
      ],
    });
    const unavailable = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "ollama",
        model: "not-installed:1b",
        reasoningEffort: "high",
      },
    });
    expect(unavailable.statusCode).toBe(400);
  });

  it("offers only the thinking modes reported by each local model", async () => {
    const details: Record<string, unknown> = {
      binary: { thinking: { values: [false, true] } },
      levels: { thinking: { values: ["low", "medium", "high"] } },
      always: { thinking: { values: [true] } },
      never: { thinking: { values: [false] } },
      legacy: { capabilities: ["completion", "thinking"] },
      unknown: {},
    };
    const config = {
      provider: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      model: "binary",
      minimumVersion: "0.5.0",
      contextTokens: 4096,
      maxOutputTokens: 128,
      timeoutMs: 1000,
    };
    const catalog = await discoverOllamaModels(async (url, init) => {
      const payload = url.endsWith("/api/tags")
        ? { models: Object.keys(details).map((name) => ({ name })) }
        : details[JSON.parse(String(init.body)).model];
      return new Response(JSON.stringify(payload), { status: 200 });
    }, config);
    expect(
      Object.fromEntries(
        catalog.models.map((item) => [item.id, item.reasoningEfforts]),
      ),
    ).toEqual({
      binary: ["none", "high"],
      levels: ["low", "medium", "high"],
      always: ["high"],
      never: ["none"],
      legacy: ["none", "high"],
      unknown: ["none"],
    });
  });

  it.each([
    { effort: "none", effective: "none", think: false },
    { effort: "low", effective: "high", think: true },
    { effort: "high", effective: "high", think: true },
  ] as const)(
    "uses the same automatic Ollama model and effective $effort control in status and chat",
    async ({ effort, effective, think }) => {
      const database = openStreamerDatabase({ filename: ":memory:" });
      const config = {
        provider: "ollama" as const,
        baseUrl: "http://127.0.0.1:11434",
        model: "configured-default:4b",
        minimumVersion: "0.5.0",
        contextTokens: 4096,
        maxOutputTokens: 128,
        timeoutMs: 1000,
      };
      let posted: Record<string, unknown> | undefined;
      let inspectedModel: string | undefined;
      const provider = new OllamaAgentProvider({
        config,
        fetch: async (url, init) => {
          if (url.endsWith("/api/show")) {
            inspectedModel = JSON.parse(String(init.body)).model;
            return {
              ok: true,
              status: 200,
              text: async () =>
                JSON.stringify({ thinking: { values: [false, true] } }),
            };
          }
          posted = JSON.parse(String(init.body));
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                done: true,
                message: { content: '{"ok":true}' },
              }),
          };
        },
      });
      const router = new AgentRouter(
        database,
        { mode: "api", provider: "ollama", reasoningEffort: effort },
        provider,
        {} as RemoteApiAgent,
        {} as StreamerToolService,
        () => new Date(),
        undefined,
        async () => true,
        async () => ({
          provider: "ollama",
          models: [
            modelOption("ollama", "installed:4b", undefined, ["none", "high"]),
          ],
          recommendedModel: "installed:4b",
          source: "local",
          status: "available",
          message: "Installed local model.",
        }),
      );
      try {
        expect(await router.status("default")).toMatchObject({
          available: true,
          effectiveModel: "installed:4b",
          effectiveReasoningEffort: effective,
        });
        await router.generateStructured(
          {
            model: "placeholder",
            messages: [{ role: "user", content: "Return JSON." }],
            outputSchemaName: "result",
            outputJsonSchema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
            },
            allowedToolNames: [],
            temperature: 0,
            maxOutputTokens: 64,
          },
          {
            requestId: "ollama-wire-test",
            profileId: "default",
            locale: "en",
            deadlineAt: "2099-01-01T00:00:00.000Z",
            secretRef: null,
          },
        );
        expect(inspectedModel).toBe("installed:4b");
        expect(posted).toMatchObject({ model: "installed:4b", think });
      } finally {
        await router.close();
        database.close();
      }
    },
  );

  it("discovers Ollama models beyond the former 30-model limit", async () => {
    const names = Array.from(
      { length: 35 },
      (_, index) => `local-model-${index}:1b`,
    );
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/tags")
              ? { models: names.map((name) => ({ name })) }
              : { capabilities: ["completion"] },
          ),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as typeof fetch,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama",
    });
    expect(response.json().models).toHaveLength(35);
    expect(response.json().models[34].id).toBe("local-model-34:1b");
  });

  it("recommends an installed model for the requested thinking level", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const payload = url.endsWith("/api/tags")
        ? { models: [{ name: "qwen3.5:4b" }, { name: "qwen3.5:32b" }] }
        : {
            thinking: {
              values:
                JSON.parse(String(init?.body)).model === "qwen3.5:4b"
                  ? [false]
                  : [true],
            },
          };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as typeof fetch,
    });
    apps.push(app);
    const speed = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama&reasoningEffort=none",
    });
    const quality = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama&reasoningEffort=high",
    });
    expect(speed.json().recommendedModel).toBe("qwen3.5:4b");
    expect(quality.json().recommendedModel).toBe("qwen3.5:32b");
  });

  it("reports the same automatically chosen Ollama model in selection status", async () => {
    const integrationStateStore =
      new NonPersistentMemoryIntegrationStateStore();
    await integrationStateStore.set({
      integrationId: "ollama",
      status: "connected",
      configured: true,
      updatedAt: new Date().toISOString(),
    });
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/tags")
              ? { models: [{ name: "qwen3.5:32b" }, { name: "qwen3.5:4b" }] }
              : { thinking: { values: [false, true] } },
          ),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as typeof fetch,
      integrationStateStore,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/inference/selection",
    });
    expect(response.json()).toMatchObject({
      available: true,
      effectiveModel: "qwen3.5:4b",
      effectiveReasoningEffort: "high",
    });
  });
});
