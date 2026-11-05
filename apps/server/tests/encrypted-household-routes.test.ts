import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { EncryptedHouseholdService } from "../src/services/encrypted-household.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { registerEncryptedHouseholdRoutes } from "../src/routes/encrypted-household.js";
import { createApp } from "../src/app.js";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { accountSecretKey } from "../src/stores/account-integrations.js";

const databases: StreamerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("owner-only encrypted household API", () => {
  it("runs through createApp paired ownership and restores over the clean first-run bootstrap", async () => {
    const root = mkdtempSync(join(tmpdir(), "streamerai-encrypted-api-"));
    const instances: ReturnType<typeof createApp>[] = [];
    const headers = { host: "localhost:5173", origin: "http://localhost:5173" };
    const base = "/api/v1/account/encrypted-household";
    const make = (name: string) => {
      const database = openStreamerDatabase({ filename: ":memory:" });
      databases.push(database);
      const secrets = new NonPersistentMemorySecretStore();
      const runtimeConfig = readRuntimeConfig({
        NODE_ENV: "test",
        STREAMERAI_ACCESS_MODE: "paired",
        STREAMERAI_DATA_DIR: join(root, name),
        STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
        STREAMERAI_AGENT_MODE: "disabled",
      });
      const app = createApp({
        environment: "test",
        logger: false,
        database,
        secretStore: secrets,
        runtimeConfig,
        installationBootstrapToken: "a".repeat(64),
      });
      instances.push(app);
      return { app, database, secrets };
    };
    try {
      const original = make("source");
      const destination = make("destination");
      original.database.profiles.update("default", {
        name: "Restored owner",
        preferences: { prompt: "Private preferences" },
      });
      await original.secrets.set(
        accountSecretKey("local", "integration.tmdb.read-token"),
        "PRIVATE-RECOVERY-TOKEN",
      );
      const owner = async (app: ReturnType<typeof createApp>) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/v1/installation/claim",
          headers,
          payload: { token: "a".repeat(64) },
        });
        expect(response.statusCode).toBe(200);
        return String(response.headers["set-cookie"]).split(";", 1)[0]!;
      };
      const originalOwner = await owner(original.app);
      const destinationOwner = await owner(destination.app);
      const denied = await original.app.inject({
        method: "POST",
        url: base + "/activate",
        headers,
        payload: { confirm: "enable-encrypted-household" },
      });
      expect(denied.statusCode).toBe(401);
      const activated = await original.app.inject({
        method: "POST",
        url: base + "/activate",
        headers: { ...headers, cookie: originalOwner },
        payload: { confirm: "enable-encrypted-household" },
      });
      expect(activated.statusCode).toBe(200);
      const key = activated.json<{ recoveryKey: string }>().recoveryKey;
      const exported = await original.app.inject({
        method: "POST",
        url: base + "/export",
        headers: { ...headers, cookie: originalOwner },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.body).not.toContain("PRIVATE-RECOVERY-TOKEN");
      const restored = await destination.app.inject({
        method: "POST",
        url: base + "/restore",
        headers: { ...headers, cookie: destinationOwner },
        payload: {
          envelope: exported.json(),
          recoveryKey: key,
          confirm: "restore-into-empty-household",
        },
      });
      expect(restored.statusCode).toBe(200);
      expect(destination.database.profiles.list().map((p) => p.name)).toEqual([
        "Restored owner",
      ]);
      expect(
        await destination.secrets.get(
          accountSecretKey("local", "integration.tmdb.read-token"),
        ),
      ).toBe("PRIVATE-RECOVERY-TOKEN");
      const exportedAgain = await destination.app.inject({
        method: "POST",
        url: base + "/export",
        headers: { ...headers, cookie: destinationOwner },
      });
      expect(exportedAgain.statusCode).toBe(200);
      const status = await destination.app.inject({
        url: base,
        headers: { ...headers, cookie: destinationOwner },
      });
      expect(status.json()).toMatchObject({
        enabled: true,
        approvalAvailable: false,
        automaticMergeAvailable: false,
      });
      const pairing = await original.app.inject({
        method: "POST",
        url: "/api/v1/installation/pair",
        headers,
        payload: { name: "Viewer" },
      });
      const pair = pairing.json<{ requestId: string; code: string }>();
      await original.app.inject({
        method: "POST",
        url: "/api/v1/installation/decision",
        headers: { ...headers, cookie: originalOwner },
        payload: { ...pair, approve: true },
      });
      const approved = await original.app.inject({
        method: "POST",
        url: "/api/v1/installation/poll",
        headers: {
          ...headers,
          cookie: String(pairing.headers["set-cookie"]).split(";", 1)[0]!,
        },
        payload: { requestId: pair.requestId },
      });
      expect(approved.statusCode).toBe(200);
      const viewer = String(approved.headers["set-cookie"]).split(";", 1)[0]!;
      const viewerExport = await original.app.inject({
        method: "POST",
        url: base + "/export",
        headers: { ...headers, cookie: viewer },
      });
      expect(viewerExport.statusCode).toBe(403);
    } finally {
      await Promise.all(instances.map((app) => app.close()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces ownership, explicit confirmations and no-store on recovery material", async () => {
    const database = openStreamerDatabase({ filename: ":memory:" });
    databases.push(database);
    database.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    const service = new EncryptedHouseholdService(
      database,
      new NonPersistentMemorySecretStore(),
    );
    const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
    registerEncryptedHouseholdRoutes(app, {
      service,
      accountId: () => "local",
      requireOwner(request, reply) {
        if (request.headers.authorization === "Bearer test-owner") return true;
        reply.code(403).send({ error: "owner_required" });
        return false;
      },
    });
    const headers = { authorization: "Bearer test-owner" };
    const base = "/api/v1/account/encrypted-household";
    try {
      const blocked = await app.inject({
        method: "POST",
        url: base + "/activate",
        payload: { confirm: "enable-encrypted-household" },
      });
      expect(blocked.statusCode).toBe(403);
      expect(blocked.headers["cache-control"]).toBe("no-store");
      expect(service.isEnabled("local")).toBe(false);
      const missingConfirmation = await app.inject({
        method: "POST",
        url: base + "/activate",
        headers,
        payload: {},
      });
      expect(missingConfirmation.statusCode).toBe(400);
      const activated = await app.inject({
        method: "POST",
        url: base + "/activate",
        headers,
        payload: { confirm: "enable-encrypted-household" },
      });
      expect(activated.statusCode).toBe(200);
      expect(activated.headers["cache-control"]).toBe("no-store");
      expect(activated.json<{ recoveryKey: string }>().recoveryKey).toMatch(
        /^STRM-R1-/,
      );
      const exported = await app.inject({
        method: "POST",
        url: base + "/export",
        headers,
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-disposition"]).toContain("attachment");
      expect(exported.body).not.toContain("Viewer");
      const cloud = await app.inject({ url: base + "/cloud", headers });
      expect(cloud.statusCode).toBe(503);
      expect(cloud.json()).toEqual({
        error: {
          code: "ENCRYPTED_SYNC_UNAVAILABLE",
          message: "ENCRYPTED_SYNC_UNAVAILABLE",
        },
      });
      const malformed = await app.inject({
        method: "POST",
        url: base + "/preview",
        headers,
        payload: {
          envelope: exported.json(),
          recoveryKey: "PRIVATE-WRONG-KEY",
        },
      });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.body).not.toContain("PRIVATE-WRONG-KEY");
    } finally {
      await app.close();
    }
  });
});
