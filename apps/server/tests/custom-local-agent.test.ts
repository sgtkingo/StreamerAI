import { describe, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import { createApp } from "../src/app.js";
import type {
  AgentGenerationRequest,
  ProviderContext,
} from "@streamer-ai/contracts";
import {
  CustomLocalAgent,
  parseCustomLocalAgentConfig,
} from "../src/integrations/custom-local-agent.js";

describe("custom local agent", () => {
  it("rejects public hosts and embedded credentials", () => {
    for (const baseUrl of [
      "https://api.example.com/v1",
      "http://user:password@127.0.0.1:1234/v1",
      "http://127.0.0.1:1234/private",
    ]) {
      expect(() =>
        parseCustomLocalAgentConfig({ baseUrl, model: "local-model" }),
      ).toThrow();
    }
  });

  it("lists every local model and sends structured prompts to the configured endpoint", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    const fetcher = vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith("/models"))
        return new Response(
          JSON.stringify({
            data: [
              { id: "local-small" },
              { id: "local-medium" },
              { id: "local-large" },
            ],
          }),
          { status: 200 },
        );
      expect(input).toBe("http://127.0.0.1:1234/v1/chat/completions");
      expect(init.redirect).toBe("manual");
      expect(JSON.parse(String(init.body))).toMatchObject({
        model: "local-small",
        response_format: { type: "json_object" },
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
        { status: 200 },
      );
    });
    const agent = new CustomLocalAgent(database, fetcher as typeof fetch);
    agent.save("viewer", { baseUrl: "127.0.0.1:1234", model: "local-small" });
    expect(agent.config("viewer")).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local-small",
    });
    const catalog = await agent.listModels("viewer");
    expect(catalog.models.map((item) => item.id)).toEqual([
      "local-small",
      "local-medium",
      "local-large",
    ]);
    const request: AgentGenerationRequest = {
      model: "local-small",
      messages: [{ role: "user", content: "Return JSON." }],
      outputSchemaName: "result",
      outputJsonSchema: { type: "object" },
      allowedToolNames: [],
      temperature: 0,
      maxOutputTokens: 128,
    };
    const result = await agent.generateStructured(request, {
      profileId: "viewer",
    } as ProviderContext);
    expect(result.output).toEqual({ ok: true });
    database.close();
  });

  it("requires a real structured test response before the guide confirms Custom", async () => {
    let canaryReady = true;
    const fetcher = vi.fn(
      async (input: string) =>
        new Response(
          JSON.stringify(
            input.endsWith("/models")
              ? { data: [{ id: "local-small" }] }
              : {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({ ready: canaryReady }),
                      },
                    },
                  ],
                },
          ),
          { status: 200 },
        ),
    );
    const app = createApp({
      environment: "test",
      logger: false,
      remoteApiFetch: fetcher as typeof fetch,
    });
    try {
      const candidate = await app.inject({
        method: "POST",
        url: "/api/v1/inference/custom/verify",
        payload: {
          profileId: "default",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "local-small",
        },
      });
      expect(candidate.json()).toEqual({ ok: true });
      const beforeSave = await app.inject({
        method: "GET",
        url: "/api/v1/inference/custom?profileId=default",
      });
      expect(beforeSave.json()).toMatchObject({ configured: false });
      const invalid = await app.inject({
        method: "POST",
        url: "/api/v1/inference/custom/verify",
        payload: {
          profileId: "default",
          baseUrl: "https://example.com/v1",
          model: "local-small",
        },
      });
      expect(invalid.statusCode).toBe(400);
      const configured = await app.inject({
        method: "PUT",
        url: "/api/v1/inference/custom",
        payload: {
          profileId: "default",
          baseUrl: "http://127.0.0.1:1234/v1",
          model: "local-small",
        },
      });
      expect(configured.statusCode).toBe(200);
      const passed = await app.inject({
        method: "POST",
        url: "/api/v1/inference/custom/verify",
        payload: { profileId: "default" },
      });
      expect(passed.json()).toEqual({ ok: true });
      canaryReady = false;
      const failed = await app.inject({
        method: "POST",
        url: "/api/v1/inference/custom/verify",
        payload: { profileId: "default" },
      });
      expect(failed.json()).toEqual({ ok: false });
    } finally {
      await app.close();
    }
  });
});
