import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { InferenceFetch } from "../src/integrations/ollama-preflight.js";

describe("guide Ollama model download", () => {
  const apps: ReturnType<typeof createApp>[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("pulls only the profile's configured model", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "success" }), { status: 200 }),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as InferenceFetch,
    });
    apps.push(app);

    await app.inject({
      method: "PUT",
      url: "/api/v1/inference/selection",
      payload: { profileId: "default", mode: "mcp", provider: "ollama" },
    });
    const config = await app.inject({
      method: "GET",
      url: "/api/v1/inference/agent/ollama-config?profileId=default",
    });
    expect(config.json()).toEqual({
      model: "qwen3.5:4b",
      baseUrl: "http://127.0.0.1:11434",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/inference/agent/pull",
      payload: { profileId: "default", model: "untrusted:huge" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, model: "qwen3.5:4b" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ model: "qwen3.5:4b", stream: false }),
        redirect: "manual",
      }),
    );
  });

  it("reports a failed pull without treating the model as installed", async () => {
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "pulling" }), { status: 200 }),
      ) as InferenceFetch,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/inference/agent/pull",
      payload: { profileId: "default" },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: { code: "OLLAMA_PULL_FAILED" },
    });
  });

  it("checks a discovered model without changing the profile configuration", async () => {
    const fetcher = vi.fn(async () => new Response("", { status: 503 }));
    const app = createApp({
      environment: "test",
      logger: false,
      inferenceFetch: fetcher as InferenceFetch,
    });
    apps.push(app);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/inference/agent/verify",
      payload: { profileId: "default", model: "../invalid model" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/inference/agent/verify",
      payload: { profileId: "default", model: "other:4b" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, model: "other:4b" });
    const config = await app.inject({
      method: "GET",
      url: "/api/v1/inference/agent/ollama-config?profileId=default",
    });
    expect(config.json()).toMatchObject({ model: "qwen3.5:4b" });
  });
});
