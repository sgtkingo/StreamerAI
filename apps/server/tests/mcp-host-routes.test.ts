import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import { MasterPinService } from "../src/services/master-pin.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

it("lets only the owner connect agent hosts and limits the bridge token to its profile's tool routes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "streamerai-mcp-routes-"));
  const home = join(directory, "home");
  mkdirSync(join(home, ".cursor"), { recursive: true });
  const database = openStreamerDatabase({ filename: ":memory:" });
  const secrets = new NonPersistentMemorySecretStore();
  await new MasterPinService(secrets).setupLocal("local", "01234567");
  const app = createApp({
    secretStore: secrets,
    environment: "test",
    logger: false,
    database,
    mcpBridge: { command: "node", args: ["stdio.js"] },
    mcpHostEnvironment: () => ({
      platform: "linux",
      home,
      env: { PATH: "" },
      serviceAccount: false,
    }),
    runtimeConfig: readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
      STREAMERAI_DATA_DIR: join(directory, "data"),
    }),
  });
  const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
  const cookie = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";", 1)[0]!;
  try {
    const owner = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/authorize",
        headers,
        payload: { masterPin: "01234567", admin: true },
      }),
    );
    const ownerHeaders = { ...headers, cookie: owner };
    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers: ownerHeaders,
      payload: {},
    });
    expect(entered.statusCode).toBe(200);
    const profiles = await app.inject({
      url: "/api/v1/profiles",
      headers: ownerHeaders,
    });
    expect(profiles.statusCode).toBe(200);
    const profileId = profiles.json().items[0].id as string;
    const other = database.profiles.create({
      id: "second-profile",
      accountId: database.profiles.get(profileId)!.accountId,
      name: "Second",
      locale: "en",
    });

    const listed = await app.inject({
      url: `/api/v1/profiles/${profileId}/mcp/hosts`,
      headers: ownerHeaders,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ canManage: true });
    expect(
      listed.json().hosts.find((host: { id: string }) => host.id === "cursor")
        .state,
    ).toBe("available");

    const connected = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/mcp/hosts`,
      headers: ownerHeaders,
      payload: {},
    });
    expect(connected.statusCode).toBe(200);
    expect(connected.json().failures).toEqual([]);
    expect(
      connected
        .json()
        .hosts.find((host: { id: string }) => host.id === "cursor").state,
    ).toBe("installed");
    const config = JSON.parse(
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8"),
    );
    const token = config.mcpServers["streamer-ai"].env
      .STREAMERAI_MCP_TOKEN as string;

    // The stdio bridge talks to the loopback port without a browser session.
    const bridgeHeaders = {
      host: "127.0.0.1:4400",
      "x-streamer-mcp-token": token,
    };
    const inspected = await app.inject({
      url: `/api/v1/profiles/${profileId}/titles/tmdb:movie:1`,
      headers: bridgeHeaders,
    });
    expect([401, 403]).not.toContain(inspected.statusCode);
    expect(
      (
        await app.inject({
          url: `/api/v1/profiles/${other.id}/titles/tmdb:movie:1`,
          headers: bridgeHeaders,
        })
      ).statusCode,
    ).toBe(403);
    expect([401, 403]).toContain(
      (await app.inject({ url: "/api/v1/profiles", headers: bridgeHeaders }))
        .statusCode,
    );
    expect(
      (
        await app.inject({
          url: `/api/v1/profiles/${profileId}/titles/tmdb:movie:1`,
          headers: { ...bridgeHeaders, "x-streamer-mcp-token": `${token}x` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: `/api/v1/profiles/${profileId}/titles/tmdb:movie:1`,
          headers: bridgeHeaders,
          remoteAddress: "192.168.1.20",
        })
      ).statusCode,
    ).toBe(403);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/profiles/${profileId}/mcp/hosts/cursor`,
      headers: ownerHeaders,
    });
    expect(removed.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: `/api/v1/profiles/${profileId}/titles/tmdb:movie:1`,
          headers: bridgeHeaders,
        })
      ).statusCode,
    ).toBe(401);

    const request = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      headers,
      payload: { name: "Living room TV" },
    });
    const pairing = request.json();
    await app.inject({
      method: "POST",
      url: "/api/v1/installation/decision",
      headers: ownerHeaders,
      payload: {
        requestId: pairing.requestId,
        code: pairing.code,
        approve: true,
      },
    });
    const viewer = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/poll",
        headers: { ...headers, cookie: cookie(request) },
        payload: { requestId: pairing.requestId },
      }),
    );
    const viewerHeaders = { ...headers, cookie: viewer };
    const viewerList = await app.inject({
      url: `/api/v1/profiles/${profileId}/mcp/hosts`,
      headers: viewerHeaders,
    });
    expect(viewerList.statusCode).toBe(200);
    expect(viewerList.json()).toMatchObject({ canManage: false, hosts: [] });
    for (const call of [
      {
        method: "POST" as const,
        url: `/api/v1/profiles/${profileId}/mcp/hosts`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/profiles/${profileId}/mcp/manual`,
      },
      {
        method: "POST" as const,
        url: `/api/v1/profiles/${profileId}/mcp/connector`,
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/profiles/${profileId}/mcp/hosts/cursor`,
      },
    ])
      expect(
        (await app.inject({ ...call, headers: viewerHeaders, payload: {} }))
          .statusCode,
      ).toBe(403);
  } finally {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
