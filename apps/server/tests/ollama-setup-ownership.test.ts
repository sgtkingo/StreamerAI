import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import { MasterPinService } from "../src/services/master-pin.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

it("requires real installation ownership for host AI detection and model actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "streamerai-ai-owner-test-"));
  const database = openStreamerDatabase({ filename: ":memory:" });
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    expect(String(input)).toMatch(
      /^http:\/\/127\.0\.0\.1:11434\/api\/(?:version|tags)$/,
    );
    return String(input).endsWith("/version")
      ? Response.json({ version: "0.15.0" })
      : Response.json({ models: [{ name: "qwen3.5:4b" }] });
  });
  vi.stubGlobal("fetch", fetcher);
  const secrets = new NonPersistentMemorySecretStore();
  await new MasterPinService(secrets).setupLocal("local", "01234567");
  const app = createApp({
    secretStore: secrets,
    environment: "test",
    logger: false,
    database,
    runtimeConfig: readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
      STREAMERAI_DATA_DIR: directory,
    }),
  });
  const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
  const cookie = (response: { headers: Record<string, unknown> }) =>
    String(response.headers["set-cookie"]).split(";", 1)[0]!;
  try {
    expect(
      (await app.inject({ url: "/api/v1/server/ai-setup", headers }))
        .statusCode,
    ).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const owner = cookie(
      await app.inject({
        method: "POST",
        url: "/api/v1/installation/authorize",
        headers,
        payload: { masterPin: "01234567", admin: true },
      }),
    );
    const detected = await app.inject({
      url: "/api/v1/server/ai-setup",
      headers: { ...headers, cookie: owner },
    });
    expect(detected.statusCode).toBe(200);
    expect(detected.json().model.present).toBe(true);
    const request = await app.inject({
      method: "POST",
      url: "/api/v1/installation/pair",
      headers,
      payload: { name: "Ordinary browser" },
    });
    const pairing = request.json();
    const decision = await app.inject({
      method: "POST",
      url: "/api/v1/installation/decision",
      headers: { ...headers, cookie: owner },
      payload: {
        requestId: pairing.requestId,
        code: pairing.code,
        approve: true,
      },
    });
    expect(decision.statusCode).toBe(200);
    const approved = await app.inject({
      method: "POST",
      url: "/api/v1/installation/poll",
      headers: { ...headers, cookie: cookie(request) },
      payload: { requestId: pairing.requestId },
    });
    const viewer = cookie(approved);
    expect(
      (
        await app.inject({
          url: "/api/v1/server/ai-setup",
          headers: { ...headers, cookie: viewer },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/server/ai-setup/model",
          headers: { ...headers, cookie: viewer },
          payload: { confirm: "download-recommended-local-model" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/server/ai-setup/model",
          headers: { ...headers, cookie: owner },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/server/ai-setup/model",
      headers: { ...headers, cookie: owner },
      payload: { confirm: "download-recommended-local-model" },
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json().alreadyPresent).toBe(true);
    expect(
      fetcher.mock.calls.every(([input]) => !String(input).endsWith("/pull")),
    ).toBe(true);
  } finally {
    await app.close();
    database.close();
    vi.unstubAllGlobals();
    rmSync(directory, { recursive: true, force: true });
  }
});
