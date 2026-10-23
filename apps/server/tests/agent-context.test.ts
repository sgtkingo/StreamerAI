import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { openStreamerDatabase } from "@streamer-ai/database";
import {
  agentSelectionKey,
  parseAgentSelection,
} from "../src/integrations/agent-router.js";

describe("agent context configuration", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  const runtimeConfig = readRuntimeConfig({ NODE_ENV: "test" });
  const metadata = {
    thinking: { values: [false, true] },
    model_info: {
      "general.architecture": "qwen35",
      "qwen35.context_length": 16384,
    },
  };
  function instance(database?: ReturnType<typeof openStreamerDatabase>) {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const app = createApp({
      environment: "test",
      logger: false,
      runtimeConfig,
      database,
      inferenceFetch: async (url, init) => {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        posted.push({ url, body });
        return new Response(
          JSON.stringify(
            url.endsWith("/api/tags")
              ? { models: [{ name: runtimeConfig.inference.model }] }
              : url.endsWith("/api/version")
                ? { version: "0.6.0" }
                : url.endsWith("/api/show")
                  ? {
                      ...metadata,
                      license: "Apache License 2.0",
                      details: {
                        family: "qwen3",
                        parameter_size: "4B",
                        quantization_level: "Q4_K_M",
                      },
                      capabilities: ["completion", "tools"],
                    }
                  : { response: '{"ready":true,"language":"cs"}' },
          ),
        );
      },
    });
    apps.push(app);
    return { app, posted };
  }

  it.each([null, "8192", 0, 2047, 131073, 4096.5])(
    "rejects invalid context %s",
    (value) => {
      expect(() =>
        parseAgentSelection({
          mode: "api",
          provider: "ollama",
          contextTokens: value,
        }),
      ).toThrow("Context size");
    },
  );

  it("persists the limit, returns it on GET, and sends it to Ollama without restarting", async () => {
    const { app, posted } = instance();
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "ollama",
        reasoningEffort: "none",
        contextTokens: 8192,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      contextTokens: 8192,
      effectiveContextTokens: 8192,
    });
    const restored = await app.inject({
      method: "GET",
      url: "/api/v1/inference/selection",
    });
    expect(restored.json()).toMatchObject({
      contextTokens: 8192,
      effectiveContextTokens: 8192,
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/inference/agent/verify",
      payload: { model: runtimeConfig.inference.model },
    });
    expect(
      posted.find((item) => item.url.endsWith("/api/generate"))?.body,
    ).toMatchObject({ options: { num_ctx: 8192 } });
    const automatic = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "ollama",
        reasoningEffort: "none",
      },
    });
    expect(automatic.json().contextTokens).toBeUndefined();
    expect(automatic.json().effectiveContextTokens).toBe(4096);
  });

  it("reports model maximum and rejects an oversized automatic-model selection through HTTP", async () => {
    const { app } = instance();
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama",
    });
    expect(catalog.json().models[0].maxContextTokens).toBe(16384);
    const result = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        mode: "api",
        provider: "ollama",
        reasoningEffort: "none",
        contextTokens: 32768,
      },
    });
    expect(result.statusCode).toBe(400);
    expect(result.json().error.message).toContain("16384");
  });

  it("clamps a stored limit when the selected model's maximum decreases", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    database.settings.set(agentSelectionKey("default"), {
      mode: "api",
      provider: "ollama",
      reasoningEffort: "none",
      contextTokens: 32768,
    });
    const { app } = instance(database);
    await app.inject({
      method: "GET",
      url: "/api/v1/inference/models?provider=ollama",
    });
    const result = await app.inject({
      method: "GET",
      url: "/api/v1/inference/selection",
    });
    expect(result.json()).toMatchObject({
      contextTokens: 32768,
      effectiveContextTokens: 16384,
    });
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    database.close();
  });

  it("keeps context budgets isolated between profiles and restores them after app recreation", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    database.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    database.profiles.create({
      id: "other",
      name: "Other viewer",
      locale: "en",
    });
    const { app } = instance(database);
    const selected = await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: {
        profileId: "other",
        mode: "api",
        provider: "ollama",
        reasoningEffort: "none",
        contextTokens: 8192,
      },
    });
    expect(selected.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: "GET", url: "/api/v1/inference/selection" })
      ).json().effectiveContextTokens,
    ).toBe(4096);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    const { app: reopened } = instance(database);
    expect(
      (
        await reopened.inject({
          method: "GET",
          url: "/api/v1/inference/selection?profileId=other",
        })
      ).json(),
    ).toMatchObject({ contextTokens: 8192, effectiveContextTokens: 8192 });
    await reopened.close();
    apps.splice(apps.indexOf(reopened), 1);
    database.close();
  });
});
