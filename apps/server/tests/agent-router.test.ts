import { afterEach, describe, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { discoveryInstructionPolicy } from "../src/services/discovery-instruction-policy.js";

describe("agent selection", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("persists one selected backend per profile and rejects unsupported combinations", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    const app = createApp({ environment: "test", logger: false, database });
    apps.push(app);
    const initial = await app.inject({
      method: "GET",
      url: "/api/v1/inference/selection",
    });
    expect(initial.json()).toMatchObject({
      mode: "api",
      provider: "ollama",
      code: "SETUP_REQUIRED",
    });
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { mode: "api", provider: "claude" },
    });
    expect(invalid.statusCode).toBe(400);
    const disabled = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { mode: "disabled", provider: "ollama" },
    });
    expect(disabled.json()).toMatchObject({
      mode: "disabled",
      code: "DISABLED",
    });
    expect(
      database.settings.get("inference.agent-selection.ZGVmYXVsdA"),
    ).toMatchObject({ mode: "disabled" });
    const restored = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { mode: "api", provider: "ollama" },
    });
    expect(restored.json()).toMatchObject({ mode: "api", provider: "ollama" });
    await app.close();
    database.close();
    apps.length = 0;
  });

  it("keeps MCP as a persistent external mode without starting embedded inference", async () => {
    const app = createApp({ environment: "test", logger: false });
    apps.push(app);
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { profileId: "default", mode: "mcp", provider: "ollama" },
    });
    expect(selected.json()).toMatchObject({
      mode: "mcp",
      provider: "ollama",
      available: false,
      code: "MCP_HOST_REQUIRED",
    });
    const restored = await app.inject({
      method: "GET",
      url: "/api/v1/inference/selection?profileId=default",
    });
    expect(restored.json().mode).toBe("mcp");
    const local = await app.inject({
      method: "GET",
      url: "/api/v1/inference/local-providers?profileId=default",
    });
    expect(local.statusCode).toBe(200);
    expect(
      local.json().providers.map((item: { provider: string }) => item.provider),
    ).toEqual(["ollama", "custom", "codex", "claude"]);
  });

  it("configures a Custom local endpoint, discovers its models, and activates it", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "local-fast" }, { id: "local-quality" }],
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
    const configured = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/custom",
      payload: {
        profileId: "default",
        baseUrl: "127.0.0.1:1234",
        model: "local-fast",
      },
    });
    expect(configured.statusCode).toBe(200);
    expect(configured.json()).toMatchObject({
      configured: true,
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-fast",
    });
    const models = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=custom&profileId=default",
    });
    expect(models.json().models.map((item: { id: string }) => item.id)).toEqual(
      ["local-fast", "local-quality"],
    );
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "custom",
        model: "local-fast",
        reasoningEffort: "none",
      },
    });
    expect(selected.json()).toMatchObject({
      provider: "custom",
      available: true,
      code: "CONFIGURED",
    });
    const discovered = await app.inject({
      method: "GET",
      url: "/api/v1/inference/local-providers",
    });
    expect(discovered.json().providers).toContainEqual(
      expect.objectContaining({
        provider: "custom",
        ready: true,
      }),
    );
  });

  it("uses the extended discovery ruleset for capable local agents", () => {
    const policy = discoveryInstructionPolicy({
      model: "codex",
      contextTokens: 8192,
      maxOutputTokens: 1024,
      locale: "cs",
      tierOverride: "extended",
    });
    expect(policy.tier).toBe("extended");
    expect(policy.candidateCount).toBe(6);
  });

  it("validates mode and provider configuration", () => {
    expect(() =>
      readRuntimeConfig({
        STREAMERAI_AGENT_MODE: "local",
        STREAMERAI_AGENT_PROVIDER: "ollama",
      }),
    ).toThrow();
    expect(
      readRuntimeConfig({
        STREAMERAI_AGENT_MODE: "local",
        STREAMERAI_AGENT_PROVIDER: "claude",
      }).agent,
    ).toEqual({ mode: "local", provider: "claude", reasoningEffort: "low" });
    expect(
      readRuntimeConfig({
        STREAMERAI_AGENT_MODE: "api",
        STREAMERAI_AGENT_PROVIDER: "gemini",
        STREAMERAI_AGENT_MODEL: "gemini-test",
      }).agent,
    ).toEqual({
      mode: "api",
      provider: "gemini",
      model: "gemini-test",
      reasoningEffort: "low",
    });
  });

  it("stores an API key without echoing it and selects one remote model", async () => {
    const app = createApp({
      environment: "test",
      logger: false,
      remoteApiFetch: (async () => {
        throw new Error("offline test provider");
      }) as typeof fetch,
    });
    apps.push(app);
    const saved = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/api-credential",
      payload: { provider: "openai", apiKey: "private-test-key" },
    });
    expect(saved.json()).toEqual({ provider: "openai", configured: true });
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { mode: "api", provider: "openai", model: "chosen-model" },
    });
    expect(selected.json()).toMatchObject({
      mode: "api",
      provider: "openai",
      model: "chosen-model",
      available: false,
      code: "MODEL_ACCESS_UNVERIFIED",
    });
    expect(selected.body).not.toContain("private-test-key");
  });
});
