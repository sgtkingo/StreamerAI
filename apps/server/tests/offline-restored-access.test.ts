import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import { MasterPinService } from "../src/services/master-pin.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

it("opens a restored cloud-owned legacy household entirely offline after local owner claim", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "streamerai-offline-access-test-"),
  );
  const database = openStreamerDatabase({ filename: ":memory:" });
  database.accounts.upsert({
    id: "local",
    cloudUserId: "original-cloud-owner",
    name: "Recovered household",
  });
  database.settings.set("server.offlineRestore", {
    requiresLocalOwnerRecovery: true,
  });
  let network = 0;
  const secrets = new NonPersistentMemorySecretStore();
  await new MasterPinService(secrets).setupLocal("local", "01234567");
  const app = createApp({
    secretStore: secrets,
    environment: "test",
    logger: false,
    database,
    accountServiceUrl: null,
    accountFetch: async () => {
      network++;
      throw new Error("Offline");
    },
    runtimeConfig: readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
      STREAMERAI_DATA_DIR: directory,
    }),
  });
  const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
  try {
    database.profiles.update("default", { name: "Recovered viewer" });
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/installation/authorize",
      headers,
      payload: { masterPin: "01234567", admin: true },
    });
    const ownerCookie = String(claim.headers["set-cookie"]).split(";", 1)[0]!;
    const status = await app.inject({
      url: "/api/v1/auth/status",
      headers: { ...headers, cookie: ownerCookie },
    });
    expect(status.json().authenticated).toBe(false);
    expect(status.json().recoveredLocalAccounts).toHaveLength(1);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers: { ...headers, cookie: ownerCookie },
      payload: {
        recoveredAccountId: status.json().recoveredLocalAccounts[0].id,
        masterPin: "01234567",
      },
    });
    expect(login.statusCode).toBe(200);
    const accountCookie = String(login.headers["set-cookie"]).split(";", 1)[0]!;
    const profiles = await app.inject({
      url: "/api/v1/profiles",
      headers: { ...headers, cookie: `${ownerCookie}; ${accountCookie}` },
    });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.json().items[0].name).toBe("Recovered viewer");
    expect(database.accounts.getLocal().cloudUserId).toBe(
      "original-cloud-owner",
    );
    expect(network).toBe(0);
  } finally {
    await app.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
