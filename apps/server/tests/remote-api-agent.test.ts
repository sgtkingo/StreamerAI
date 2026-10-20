import { describe, expect, it, vi } from "vitest";
import type {
  AgentGenerationRequest,
  ProviderContext,
} from "@streamer-ai/contracts";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import {
  RemoteApiAgent,
  REMOTE_API_NAMES,
  remoteApiSecretKey,
} from "../src/integrations/remote-api-agent.js";

const request: AgentGenerationRequest = {
  model: "chosen-model",
  messages: [{ role: "user", content: 'Return JSON: {"ok":true}.' }],
  outputSchemaName: "test_result",
  outputJsonSchema: {
    type: "object",
    properties: { ok: { type: "boolean" } },
    required: ["ok"],
    additionalProperties: false,
  },
  allowedToolNames: [],
  temperature: 0,
  maxOutputTokens: 128,
};
const context = { profileId: "default" } as ProviderContext;

describe("remote API agent adapters", () => {
  it.each([
    ["openai", "gpt-6-luna", "none", ["reasoning", "effort"], "none"],
    ["anthropic", "claude-haiku-5-5", "none", ["thinking", "type"], "disabled"],
    [
      "gemini",
      "gemini-3.1-flash-lite",
      "none",
      ["generationConfig", "thinkingConfig", "thinkingLevel"],
      "minimal",
    ],
    ["grok", "grok-4.3", "high", ["reasoning_effort"], "high"],
    ["kimi", "kimi-k2.6", "none", ["thinking", "type"], "disabled"],
    ["deepseek", "deepseek-flash", "medium", ["reasoning_effort"], "high"],
  ] as const)(
    "maps %s reasoning controls",
    async (provider, model, effort, path, expected) => {
      const secrets = new NonPersistentMemorySecretStore();
      await secrets.set(
        remoteApiSecretKey("default", provider),
        "test-secret-key",
      );
      const payload =
        provider === "openai"
          ? { output_text: '{"ok":true}' }
          : provider === "anthropic"
            ? { content: [{ text: '{"ok":true}' }] }
            : provider === "gemini"
              ? {
                  candidates: [
                    { content: { parts: [{ text: '{"ok":true}' }] } },
                  ],
                }
              : { choices: [{ message: { content: '{"ok":true}' } }] };
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );
      const agent = new RemoteApiAgent(secrets, fetcher as typeof fetch);
      await agent.generateStructured(
        provider,
        { ...request, model },
        context,
        effort,
      );
      const body = JSON.parse(
        (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
          .body as string,
      );
      let value: unknown = body;
      for (const part of path) value = (value as Record<string, unknown>)[part];
      expect(value).toBe(expected);
    },
  );

  it.each(REMOTE_API_NAMES)(
    "parses structured output from %s without returning the key",
    async (provider) => {
      const secrets = new NonPersistentMemorySecretStore();
      await secrets.set(
        remoteApiSecretKey("default", provider),
        "top-secret-test-key",
      );
      const payload =
        provider === "openai"
          ? {
              output: [
                { content: [{ type: "output_text", text: '{"ok":true}' }] },
              ],
              usage: { input_tokens: 4, output_tokens: 5 },
            }
          : provider === "anthropic"
            ? {
                content: [{ type: "text", text: '{"ok":true}' }],
                usage: { input_tokens: 4, output_tokens: 5 },
              }
            : provider === "gemini"
              ? {
                  candidates: [
                    { content: { parts: [{ text: '{"ok":true}' }] } },
                  ],
                  usageMetadata: {
                    promptTokenCount: 4,
                    candidatesTokenCount: 5,
                  },
                }
              : {
                  choices: [{ message: { content: '{"ok":true}' } }],
                  usage: { prompt_tokens: 4, completion_tokens: 5 },
                };
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(payload), { status: 200 }),
      );
      const agent = new RemoteApiAgent(secrets, fetcher as typeof fetch);
      const result = await agent.generateStructured<{ ok: boolean }>(
        provider,
        request,
        context,
      );
      expect(result.output).toEqual({ ok: true });
      expect(result.inputTokens).toBe(4);
      expect(result.outputTokens).toBe(5);
      const [url, init] = fetcher.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toMatch(/^https:\/\//);
      expect(init.redirect).toBe("manual");
      expect(JSON.stringify(result)).not.toContain("top-secret-test-key");
    },
  );

  it("reports a missing API key without calling the provider", async () => {
    const fetcher = vi.fn();
    const agent = new RemoteApiAgent(
      new NonPersistentMemorySecretStore(),
      fetcher as typeof fetch,
    );
    expect(await agent.status("openai", "default")).toMatchObject({
      available: false,
      code: "CREDENTIAL_REQUIRED",
    });
    await expect(
      agent.generateStructured("openai", request, context),
    ).rejects.toThrow("not configured");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
