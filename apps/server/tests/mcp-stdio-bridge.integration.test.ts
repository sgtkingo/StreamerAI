import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openStreamerDatabase } from "@streamer-ai/database";
import { MasterPinService } from "../src/services/master-pin.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("No port")),
      );
    });
  });
}

it("launches the exact command written into a host config and serves tools through the paired server", async () => {
  const directory = mkdtempSync(join(tmpdir(), "streamerai-mcp-e2e-"));
  const home = join(directory, "home");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const port = await freePort();
  const database = openStreamerDatabase({ filename: ":memory:" });
  const secrets = new NonPersistentMemorySecretStore();
  await new MasterPinService(secrets).setupLocal("local", "01234567");
  const app = createApp({
    secretStore: secrets,
    environment: "test",
    logger: false,
    database,
    mcpHostEnvironment: () => ({
      platform: "linux",
      home,
      env: { PATH: "" },
      serviceAccount: false,
    }),
    runtimeConfig: readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_PORT: String(port),
      STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
      STREAMERAI_DATA_DIR: join(directory, "data"),
    }),
  });
  const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await app.listen({ port, host: "127.0.0.1" });
    const owner = String(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/installation/authorize",
          headers,
          payload: { masterPin: "01234567", admin: true },
        })
      ).headers["set-cookie"],
    ).split(";", 1)[0]!;
    const ownerHeaders = { ...headers, cookie: owner };
    const profileId = (
      await app.inject({ url: "/api/v1/profiles", headers: ownerHeaders })
    ).json().items[0].id as string;
    const connected = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/mcp/hosts`,
      headers: ownerHeaders,
      payload: { hosts: ["cursor"] },
    });
    expect(connected.json().failures).toEqual([]);
    const entry = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    ).mcpServers["streamer-ai"];

    child = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const replies = new Map<number, (value: Record<string, unknown>) => void>();
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const message = JSON.parse(line) as { id: number };
      replies.get(message.id)?.(message as Record<string, unknown>);
    });
    const call = (id: number, method: string, params: unknown = {}) =>
      new Promise<Record<string, unknown>>((resolve) => {
        replies.set(id, resolve);
        child!.stdin!.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
      });

    const initialized = await call(1, "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(initialized.result).toMatchObject({
      serverInfo: { name: "streamer-ai" },
    });
    const tools = (await call(2, "tools/list")).result as {
      tools: { name: string }[];
    };
    expect(tools.tools.map((tool) => tool.name)).toContain("inspect_media");
    const inspected = (await call(3, "tools/call", {
      name: "inspect_media",
      arguments: { titleId: "tmdb:movie:1" },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    // Authentication passed: any failure is about the title, not access.
    expect(inspected.result.content[0]!.text).not.toMatch(
      /sign in|reconnect|not available to agent|another profile|credential/i,
    );

    await app.inject({
      method: "DELETE",
      url: `/api/v1/profiles/${profileId}/mcp/hosts/cursor`,
      headers: ownerHeaders,
    });
    const revoked = (await call(4, "tools/call", {
      name: "inspect_media",
      arguments: { titleId: "tmdb:movie:1" },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(revoked.result.isError).toBe(true);
    expect(revoked.result.content[0]!.text).toMatch(/Reconnect StreamerAI/);
  } finally {
    child?.kill();
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
