import { describe, expect, it } from "vitest";
import { OllamaAgentProvider, type OllamaFetch } from "../src/index.js";

const config = {
  provider: "ollama" as const,
  baseUrl: "http://127.0.0.1:11434",
  model: "qwen3.5:4b",
  minimumVersion: "0.5.0",
  contextTokens: 4096,
  maxOutputTokens: 128,
  timeoutMs: 1000,
};

const context = {
  requestId: "request-0001",
  profileId: "default",
  locale: "cs" as const,
  deadlineAt: "2099-01-01T00:00:00.000Z",
  secretRef: null,
};

const request = {
  model: "qwen3.5:4b",
  messages: [{ role: "user" as const, content: "Find a space movie." }],
  outputSchemaName: "titles",
  outputJsonSchema: { type: "object", properties: {} },
  allowedToolNames: [],
  temperature: 0,
  maxOutputTokens: 64,
};

function response(value: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}

describe("Ollama agent adapter", () => {
  it("repairs a thinking-exhausted response once without changing the selected effort or replaying thoughts", async () => {
    const events: Array<Record<string, unknown>> = [];
    const posted: Array<Record<string, unknown>> = [];
    const provider = new OllamaAgentProvider({
      config,
      diagnostic: (event) => events.push(event),
      fetch: async (url, init) => {
        if (url.endsWith("/api/show"))
          return response({ thinking: { values: [false, true] } });
        posted.push(JSON.parse(init.body ?? "{}"));
        return posted.length === 1
          ? response({
              done: true,
              done_reason: "length",
              prompt_eval_count: 100,
              eval_count: 3072,
              message: { content: "", thinking: "private-hidden-reasoning" },
            })
          : response({
              model: request.model,
              done: true,
              done_reason: "stop",
              prompt_eval_count: 100,
              eval_count: 12,
              message: { content: '{"valid":true}' },
            });
      },
    });
    const result = await provider.generateStructured(request, context, "high");
    expect(result).toMatchObject({
      output: { valid: true },
      finishReason: "completed",
      inputTokens: 200,
      outputTokens: 3084,
    });
    expect(posted).toHaveLength(2);
    expect(posted[0]?.think).toBe(true);
    expect(posted[1]).toMatchObject({
      think: false,
      messages: request.messages,
      format: request.outputJsonSchema,
      options: { num_predict: 64 },
    });
    expect(JSON.stringify(posted)).not.toContain("private-hidden-reasoning");
    expect(JSON.stringify(events)).not.toContain("private-hidden-reasoning");
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AGENT_REPAIR_STARTED",
        think: false,
        reason: "thinking-exhausted-before-json",
      }),
    );
  });

  it.each([
    { values: [false, true], effort: "none" as const },
    { values: ["low", "medium", "high"], effort: "high" as const },
  ])(
    "does not send an unsupported or unnecessary repair for $effort on $values",
    async ({ values, effort }) => {
      let chatCalls = 0;
      const provider = new OllamaAgentProvider({
        config,
        fetch: async (url) => {
          if (url.endsWith("/api/show"))
            return response({ thinking: { values } });
          chatCalls++;
          return response({
            done: true,
            done_reason: "length",
            message: { content: "" },
          });
        },
      });
      await expect(
        provider.generateStructured(request, context, effort),
      ).rejects.toMatchObject({ kind: "invalid-response" });
      expect(chatCalls).toBe(1);
    },
  );

  it("never recursively repairs JSON and respects the remaining original deadline", async () => {
    for (const remainingMs of [10_000, 500]) {
      let time = Date.parse("2026-10-23T12:00:00Z");
      const deadlineAt = new Date(time + 60_000).toISOString();
      let chatCalls = 0;
      const provider = new OllamaAgentProvider({
        config,
        now: () => new Date(time),
        fetch: async (url) => {
          if (url.endsWith("/api/show"))
            return response({ thinking: { values: [false, true] } });
          chatCalls++;
          if (chatCalls === 1) time += 60_000 - remainingMs;
          return response({
            done: true,
            done_reason: "length",
            message: { content: "" },
          });
        },
      });
      await expect(
        provider.generateStructured(
          request,
          { ...context, deadlineAt },
          "high",
        ),
      ).rejects.toMatchObject({ kind: "invalid-response" });
      expect(chatCalls).toBe(remainingMs >= 1_000 ? 2 : 1);
    }
  });

  it("logs actual reasoning controls and token usage without prompts, outputs or hidden thinking", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new OllamaAgentProvider({
      config,
      diagnostic: (event) => events.push(event),
      fetch: async (url) =>
        url.endsWith("/api/show")
          ? response({ thinking: { values: [false, true] } })
          : response({
              model: "qwen3.5:4b",
              done: true,
              done_reason: "stop",
              prompt_eval_count: 123,
              eval_count: 12,
              message: {
                content: '{"result":"private-model-output"}',
                thinking: "private-hidden-thinking",
              },
            }),
    });
    await provider.generateStructured(
      {
        ...request,
        messages: [{ role: "user", content: "private-user-prompt" }],
      },
      {
        ...context,
        secretRef: "private-vault-ref",
        discoverySessionId: "diagnostic-session",
      } as typeof context,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AGENT_OPTIONS",
        think: false,
        numPredict: 64,
        model: "qwen3.5:4b",
        schema: "titles",
        sessionId: "diagnostic-session",
        discoveryRequestId: context.requestId,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AGENT_RESPONSE",
        doneReason: "stop",
        inputTokens: 123,
        outputTokens: 12,
      }),
    );
    for (const secret of [
      "private-model-output",
      "private-hidden-thinking",
      "private-user-prompt",
      "private-vault-ref",
    ])
      expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("logs exhausted generation budgets even when no final JSON can be parsed", async () => {
    const events: Array<Record<string, unknown>> = [];
    const provider = new OllamaAgentProvider({
      config,
      diagnostic: (event) => events.push(event),
      fetch: async (url) =>
        url.endsWith("/api/show")
          ? response({ thinking: { values: [false, true] } })
          : response({
              done: true,
              done_reason: "length",
              prompt_eval_count: 100,
              eval_count: 3072,
              message: { content: "", thinking: "private-truncated-thinking" },
            }),
    });
    await expect(
      provider.generateStructured(request, context, "high"),
    ).rejects.toMatchObject({ kind: "invalid-response" });
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AGENT_RESPONSE",
        doneReason: "length",
        outputTokens: 3072,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        code: "DISCOVERY_AGENT_FAILED",
        failure: expect.objectContaining({ kind: "invalid-response" }),
      }),
    );
    expect(JSON.stringify(events)).not.toContain("private-truncated-thinking");
  });

  it("interrupts a running Ollama request when discovery is cancelled", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let ollamaSignal: AbortSignal | undefined;
    const fetch: OllamaFetch = async (url, init) => {
      if (url.endsWith("/api/show"))
        return response({ thinking: { values: [false] } });
      ollamaSignal = init.signal;
      started();
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    };
    const provider = new OllamaAgentProvider({
      config,
      fetch,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    const generation = provider.generateStructured(
      {
        model: "qwen3.5:4b",
        messages: [{ role: "user", content: "Find a comedy" }],
        outputSchemaName: "titles",
        outputJsonSchema: { type: "object", properties: {} },
        allowedToolNames: [],
        temperature: 0,
        maxOutputTokens: 64,
      },
      { ...context, signal: controller.signal },
    );
    await requestStarted;
    controller.abort();
    await expect(generation).rejects.toMatchObject({ kind: "timeout" });
    expect(ollamaSignal?.aborted).toBe(true);
  });

  it("uses strict structured output without exposing a general runtime endpoint", async () => {
    let posted: Record<string, unknown> | undefined;
    const fetch: OllamaFetch = async (url, init) => {
      if (url.endsWith("/api/show"))
        return response({ thinking: { values: [false] } });
      posted = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      return response({
        model: "qwen3.5:4b",
        done: true,
        message: { content: '{"intent":"autumn movie"}' },
        prompt_eval_count: 12,
        eval_count: 5,
      });
    };
    const provider = new OllamaAgentProvider({
      config,
      fetch,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });

    const result = await provider.generateStructured<{ intent: string }>(
      {
        model: "qwen3.5:4b",
        messages: [{ role: "user", content: "Podzimní film" }],
        outputSchemaName: "intent",
        outputJsonSchema: {
          type: "object",
          required: ["intent"],
          properties: { intent: { type: "string" } },
        },
        allowedToolNames: [],
        temperature: 0,
        maxOutputTokens: 64,
      },
      context,
    );

    expect(result.output).toEqual({ intent: "autumn movie" });
    expect(posted).toMatchObject({
      model: "qwen3.5:4b",
      stream: false,
      think: false,
    });
    expect(posted).not.toHaveProperty("tools");
  });

  it.each([
    { values: [false, true], effort: "none", think: false },
    { values: [false, true], effort: "low", think: true },
    { values: [false, true], effort: "medium", think: true },
    { values: [false, true], effort: "high", think: true },
    { values: ["low", "medium", "high"], effort: "none", think: "low" },
    { values: ["low", "medium", "high"], effort: "medium", think: "medium" },
    { values: ["low", "medium", "high"], effort: "high", think: "high" },
    { values: [true], effort: "none", think: true },
    { values: [false], effort: "high", think: false },
  ] as const)(
    "maps $effort to the model's supported think=$think control ($values)",
    async ({ values, effort, think }) => {
      let posted: Record<string, unknown> | undefined;
      const provider = new OllamaAgentProvider({
        config,
        fetch: async (url, init) => {
          if (url.endsWith("/api/show"))
            return response({ thinking: { values } });
          posted = JSON.parse(init.body ?? "{}");
          return response({ done: true, message: { content: "{}" } });
        },
      });
      await provider.generateStructured(request, context, effort);
      expect(posted).toMatchObject({ model: request.model, think });
    },
  );

  it("keeps the runtime default when thinking metadata is unavailable", async () => {
    let posted: Record<string, unknown> | undefined;
    const provider = new OllamaAgentProvider({
      config,
      fetch: async (url, init) => {
        if (url.endsWith("/api/show")) return response({});
        posted = JSON.parse(init.body ?? "{}");
        return response({ done: true, message: { content: "{}" } });
      },
    });
    await provider.generateStructured(request, context);
    expect(posted?.think).toBeNull();
  });

  it("does not reuse thinking metadata for the same model on another host", async () => {
    const posted: Record<string, unknown>[] = [];
    const shows: string[] = [];
    const provider = new OllamaAgentProvider({
      config,
      configForProfile: (profileId) => ({
        ...config,
        contextTokens: profileId === "other" ? 8192 : 2048,
        baseUrl:
          profileId === "other" ? "http://127.0.0.1:11435" : config.baseUrl,
      }),
      fetch: async (url, init) => {
        if (url.endsWith("/api/show")) {
          shows.push(url);
          return response({
            thinking: {
              values: url.includes(":11435")
                ? ["low", "medium", "high"]
                : [false, true],
            },
          });
        }
        posted.push(JSON.parse(init.body ?? "{}"));
        return response({ done: true, message: { content: "{}" } });
      },
    });
    await provider.generateStructured(request, context, "high");
    await provider.generateStructured(
      request,
      { ...context, profileId: "other" },
      "high",
    );
    expect(posted.map((item) => item.think)).toEqual([true, "high"]);
    expect(
      posted.map((item) => (item.options as { num_ctx: number }).num_ctx),
    ).toEqual([2048, 8192]);
    expect(shows).toHaveLength(2);
  });

  it("retries metadata after failure instead of silently disabling requested thinking", async () => {
    let shows = 0;
    let chats = 0;
    const provider = new OllamaAgentProvider({
      config,
      fetch: async (url) => {
        if (url.endsWith("/api/show")) {
          shows += 1;
          if (shows === 1) throw new Error("temporarily offline");
          return response({ capabilities: ["completion", "thinking"] });
        }
        chats += 1;
        return response({ done: true, message: { content: "{}" } });
      },
    });
    await expect(
      provider.generateStructured(request, context, "high"),
    ).rejects.toMatchObject({ kind: "network" });
    expect(chats).toBe(0);
    await provider.generateStructured(request, context, "high");
    expect(shows).toBe(2);
    expect(chats).toBe(1);
  });

  it("reserves generation tokens for hidden thinking separately from final JSON", async () => {
    const budgets: number[] = [];
    const provider = new OllamaAgentProvider({
      config,
      fetch: async (url, init) => {
        if (url.endsWith("/api/show"))
          return response({ thinking: { values: [false, true] } });
        budgets.push(JSON.parse(init.body ?? "{}").options.num_predict);
        return response({ done: true, message: { content: "{}" } });
      },
    });
    await provider.generateStructured(request, context, "none");
    await provider.generateStructured(request, context, "high");
    expect(budgets).toEqual([64, 3_136]);
  });

  it("bounds the thinking allowance to remaining configured context", async () => {
    let budget = 0;
    const provider = new OllamaAgentProvider({
      config: { ...config, contextTokens: 2_048 },
      fetch: async (url, init) => {
        if (url.endsWith("/api/show"))
          return response({ thinking: { values: [false, true] } });
        budget = JSON.parse(init.body ?? "{}").options.num_predict;
        return response({ done: true, message: { content: "{}" } });
      },
    });
    await provider.generateStructured(
      {
        ...request,
        messages: [{ role: "user", content: "x".repeat(3_000) }],
      },
      context,
      "high",
    );
    expect(budget).toBeGreaterThan(request.maxOutputTokens);
    expect(budget).toBeLessThan(1_000);
  });

  it("reports a length stop even when Ollama marks the response done", async () => {
    const provider = new OllamaAgentProvider({
      config,
      fetch: async (url) =>
        response(
          url.endsWith("/api/show")
            ? { thinking: { values: [false] } }
            : { done: true, done_reason: "length", message: { content: "{}" } },
        ),
    });
    const result = await provider.generateStructured(request, context);
    expect(result.finishReason).toBe("length");
  });
});
