import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openStreamerDatabase } from "@streamer-ai/database";
import { resolveMcpScript } from "../src/mcp/mcp-host-installer.js";
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
function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.once("close", (code) => resolve({ code, output }));
  });
}
async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
) {
  for (let attempt = 0; ; attempt += 1) {
    const value = await read();
    if (done(value) || attempt > 50) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

it("connects agents in the user's account while the server runs as a service account", async () => {
  const directory = mkdtempSync(join(tmpdir(), "streamerai-connector-e2e-"));
  const userHome = join(directory, "user");
  mkdirSync(join(userHome, ".cursor"), { recursive: true });
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
      platform: process.platform,
      home: join(directory, "service"),
      env: {},
      serviceAccount: true,
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
  let bridge: ReturnType<typeof spawn> | undefined;
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
    const hosts = () =>
      app
        .inject({
          url: `/api/v1/profiles/${profileId}/mcp/hosts`,
          headers: ownerHeaders,
        })
        .then((response) => response.json());
    const before = await hosts();
    expect(before).toMatchObject({
      serviceAccount: true,
      connector: { available: true },
    });

    const started = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/mcp/connector`,
      headers: ownerHeaders,
    });
    expect(started.statusCode).toBe(200);
    const { ticket, url, command } = started.json();
    expect(url).toBe(
      `streamerai-agent://connect?server=${encodeURIComponent(`http://127.0.0.1:${port}`)}&ticket=${ticket}`,
    );
    expect(command).toContain(url);

    // The connector runs as the person: their home, not the service's.
    const connector = resolveMcpScript("connect")!;
    const userEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      APPDATA: join(userHome, "AppData", "Roaming"),
      PATH: "",
      Path: "",
    };
    delete userEnv.CLAUDE_CONFIG_DIR;
    delete userEnv.CODEX_HOME;
    delete userEnv.XDG_CONFIG_HOME;
    const result = await run(
      connector.command,
      [...connector.args, url, "--no-wait"],
      userEnv,
    );
    expect(result.output).toContain("✓ Cursor");
    expect(result.code).toBe(0);

    const status = await app.inject({
      url: `/api/v1/profiles/${profileId}/mcp/connector/${ticket}`,
      headers: ownerHeaders,
    });
    expect(status.json()).toMatchObject({
      state: "done",
      results: [{ id: "cursor", ok: true }],
    });
    const connected = (await hosts()).hosts.find(
      (host: { id: string }) => host.id === "cursor",
    );
    expect(connected.state).toBe("installed");
    expect(connected.connection.seenAt).toBeUndefined();

    // A used ticket and a remote caller are both refused.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/mcp/connector/redeem",
          headers: { host: `127.0.0.1:${port}` },
          payload: { ticket, hosts: ["cursor"] },
        })
      ).statusCode,
    ).toBe(403);
    const fresh = (
      await app.inject({
        method: "POST",
        url: `/api/v1/profiles/${profileId}/mcp/connector`,
        headers: ownerHeaders,
      })
    ).json().ticket;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/mcp/connector/redeem",
          headers: { host: `127.0.0.1:${port}` },
          remoteAddress: "192.168.1.20",
          payload: { ticket: fresh, hosts: ["cursor"] },
        })
      ).statusCode,
    ).toBe(403);
    // A web page cannot redeem it from the browser either.
    expect([401, 403]).toContain(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/mcp/connector/redeem",
          headers: { ...headers },
          payload: { ticket: fresh, hosts: ["cursor"] },
        })
      ).statusCode,
    );

    // Restarting the host starts the bridge, which clears "restart required".
    const entry = JSON.parse(
      readFileSync(join(userHome, ".cursor", "mcp.json"), "utf8"),
    ).mcpServers["streamer-ai"];
    expect(entry.env.STREAMERAI_MCP_PROFILE_ID).toBe(profileId);
    bridge = spawn(entry.command, entry.args, {
      env: { ...process.env, ...entry.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const initialized = new Promise<string>((resolve) =>
      createInterface({ input: bridge!.stdout! }).once("line", resolve),
    );
    bridge.stdin!.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
    );
    expect(JSON.parse(await initialized).result.serverInfo.name).toBe(
      "streamer-ai",
    );
    const seen = await eventually(
      async () =>
        (await hosts()).hosts.find(
          (host: { id: string }) => host.id === "cursor",
        ),
      (host) => !!host.connection?.seenAt,
    );
    expect(seen.connection.seenAt).toBeTruthy();

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/profiles/${profileId}/mcp/hosts/cursor`,
      headers: ownerHeaders,
    });
    expect(
      revoked.json().hosts.find((host: { id: string }) => host.id === "cursor")
        .state,
    ).toBe("not-detected");
  } finally {
    bridge?.kill();
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
