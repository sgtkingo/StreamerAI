import { describe, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import type {
  AgentProvider,
  AgentGenerationRequest,
  ProviderContext,
} from "@streamer-ai/contracts";
import { AgentRouter } from "../src/integrations/agent-router.js";
import { LocalAgentHost } from "../src/integrations/local-agent-host.js";
import { RemoteApiAgent } from "../src/integrations/remote-api-agent.js";
import { StreamerToolService } from "../src/mcp/streamer-tools.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";

const request: AgentGenerationRequest = {
  model: "codex",
  messages: [{ role: "user", content: "Rank these titles." }],
  outputSchemaName: "streamer_ai_grounded_rank",
  outputJsonSchema: {
    type: "object",
    required: ["orderedIds"],
    properties: { orderedIds: { type: "array", items: { type: "string" } } },
  },
  allowedToolNames: ["inspect_media"],
  temperature: 0,
  maxOutputTokens: 160,
};

describe("embedded local tool loop", () => {
  it("dispatches the same safe tool and enforces the current profile", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    const messages: string[] = [];
    const sendMessage = vi.fn(async (message: string) => {
      messages.push(message);
      return messages.length === 1
        ? JSON.stringify({
            kind: "tool",
            tool: {
              name: "inspect_media",
              arguments: {
                titleId: "tmdb:movie:1",
                profileId: "another-profile",
              },
            },
          })
        : JSON.stringify({
            kind: "final",
            result: { orderedIds: ["tmdb:movie:1"] },
          });
    });
    const fakeHost = {
      startSession: vi.fn(async () => ({ id: "thread-1", sendMessage })),
      listModels: vi.fn(async () => ({
        provider: "codex",
        models: [
          {
            id: "gpt-6-luna",
            label: "GPT-6 Luna",
            reasoningEfforts: ["none", "low", "medium", "high"],
          },
        ],
        recommendedModel: "gpt-6-luna",
        source: "local",
        status: "available",
        message: "ready",
      })),
      close: vi.fn(),
    } as unknown as LocalAgentHost;
    const call = vi.fn(async () => ({
      title: { id: "tmdb:movie:1", title: "Example" },
    }));
    const tools = { call } as unknown as StreamerToolService;
    const router = new AgentRouter(
      database,
      { mode: "local", provider: "codex" },
      {} as AgentProvider,
      new RemoteApiAgent(new NonPersistentMemorySecretStore()),
      tools,
      () => new Date(),
      fakeHost,
    );
    const result = await router.generateStructured<{ orderedIds: string[] }>(
      request,
      { profileId: "default" } as ProviderContext,
    );
    expect(result.output.orderedIds).toEqual(["tmdb:movie:1"]);
    expect(call).toHaveBeenCalledWith(
      "inspect_media",
      { titleId: "tmdb:movie:1", profileId: "default" },
      undefined,
    );
    expect(messages[1]).toContain("Example");
    expect(
      database.settings.get(
        "inference.agent-session.Y29kZXg6ZGVmYXVsdDpzdHJlYW1lcl9haV9ncm91bmRlZF9yYW5r",
      ),
    ).toBe("thread-1");
    database.close();
  });

  it("rejects a tool outside the coordinator allowlist", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    const fakeHost = {
      startSession: vi.fn(async () => ({
        id: "thread-2",
        sendMessage: async () =>
          JSON.stringify({
            kind: "tool",
            tool: {
              name: "start_playback",
              arguments: { titleId: "tmdb:movie:1" },
            },
          }),
      })),
      listModels: vi.fn(async () => ({
        provider: "codex",
        models: [
          {
            id: "gpt-6-luna",
            label: "GPT-6 Luna",
            reasoningEfforts: ["none", "low", "medium", "high"],
          },
        ],
        recommendedModel: "gpt-6-luna",
        source: "local",
        status: "available",
        message: "ready",
      })),
      close: vi.fn(),
    } as unknown as LocalAgentHost;
    const call = vi.fn();
    const router = new AgentRouter(
      database,
      { mode: "local", provider: "codex" },
      {} as AgentProvider,
      new RemoteApiAgent(new NonPersistentMemorySecretStore()),
      { call } as unknown as StreamerToolService,
      () => new Date(),
      fakeHost,
    );
    await expect(
      router.generateStructured(request, {
        profileId: "default",
      } as ProviderContext),
    ).rejects.toThrow("unauthorized tool");
    expect(call).not.toHaveBeenCalled();
    database.close();
  });
});
