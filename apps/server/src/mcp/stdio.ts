import { createInterface } from "node:readline";
import { STREAMER_TOOLS, StreamerToolService } from "./streamer-tools.js";

type Message = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
    requestId?: string | number;
    protocolVersion?: string;
  };
};
const service = new StreamerToolService(
  process.env.STREAMERAI_MCP_BASE_URL || "http://127.0.0.1:4400",
  fetch,
  process.env.STREAMERAI_MCP_PROFILE_ID || "default",
);
const active = new Map<string | number, AbortController>();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const supportedVersions = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
let initialized = false;
const send = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id: string | number, value: unknown) =>
  send({ jsonrpc: "2.0", id, result: value });
const error = (id: string | number | null, code: number, message: string) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

input.on("line", (line) => {
  if (Buffer.byteLength(line) > 256_000) {
    error(null, -32700, "Message too large.");
    return;
  }
  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    error(null, -32700, "Invalid JSON.");
    return;
  }
  if (message.method === "notifications/cancelled") {
    const id = message.params?.requestId;
    if (id !== undefined) active.get(id)?.abort();
    return;
  }
  if (message.id === undefined) return;
  const id = message.id;
  if (message.method === "initialize") {
    initialized = true;
    result(id, {
      protocolVersion: supportedVersions.has(
        message.params?.protocolVersion ?? "",
      )
        ? message.params!.protocolVersion
        : "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "streamer-ai", version: "0.1.0" },
    });
    return;
  }
  if (!initialized) {
    error(id, -32000, "Server has not been initialized.");
    return;
  }
  if (message.method === "ping") {
    result(id, {});
    return;
  }
  if (message.method === "tools/list") {
    result(id, { tools: STREAMER_TOOLS });
    return;
  }
  if (message.method !== "tools/call") {
    error(id, -32601, "Method not found.");
    return;
  }
  const name = message.params?.name;
  if (
    typeof name !== "string" ||
    !STREAMER_TOOLS.some((tool) => tool.name === name)
  ) {
    error(id, -32602, "Unknown tool.");
    return;
  }
  const controller = new AbortController();
  active.set(id, controller);
  void service
    .call(name, message.params?.arguments ?? {}, controller.signal)
    .then((data) =>
      result(id, { content: [{ type: "text", text: JSON.stringify(data) }] }),
    )
    .catch((cause: unknown) =>
      result(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: cause instanceof Error ? cause.message : "Tool failed.",
          },
        ],
      }),
    )
    .finally(() => active.delete(id));
});
input.once("close", () => {
  for (const controller of active.values()) controller.abort();
});
