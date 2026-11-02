import { afterEach, describe, expect, it } from "vitest";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import {
  AccountScopedSecretStore,
  accountSecretKey,
  migrateAccountIntegrations,
} from "../src/stores/account-integrations.js";
import {
  NonPersistentMemorySecretStore,
  profileSecretKey,
} from "../src/stores/secret-store.js";
import { createApp } from "../src/index.js";
import { fetchReturning, tmdbConfiguration, TEST_TOKEN } from "./fixtures.js";

const databases: StreamerDatabase[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function setup() {
  const db = openStreamerDatabase({ filename: ":memory:" });
  databases.push(db);
  db.profiles.create({ id: "default", name: "First viewer", locale: "en" });
  db.profiles.create({ id: "child", name: "Child", locale: "en" });
  db.accounts.upsert({ id: "other" });
  db.profiles.create({
    id: "other-profile",
    accountId: "other",
    name: "Other",
    locale: "en",
  });
  const raw = new NonPersistentMemorySecretStore();
  return { db, raw, store: new AccountScopedSecretStore(db, raw) };
}

describe("account provider credentials", () => {
  it("inherits connected provider credentials within the account and follows a profile transfer", async () => {
    const { db, raw, store } = setup();
    await raw.set("integration.webshare.wst", "first-session");
    expect(
      await store.get(profileSecretKey("child", "integration.webshare.wst")),
    ).toBe("first-session");
    expect(
      await store.get(
        profileSecretKey("other-profile", "integration.webshare.wst"),
      ),
    ).toBeUndefined();
    await store.set(
      profileSecretKey("child", "integration.webshare.wst"),
      "renewed-session",
    );
    expect(await store.get("integration.webshare.wst")).toBe("renewed-session");
    await store.set(
      profileSecretKey("other-profile", "integration.webshare.wst"),
      "other-session",
    );
    db.profiles.transfer("child", "other");
    expect(
      await store.get(profileSecretKey("child", "integration.webshare.wst")),
    ).toBe("other-session");
    expect(
      await raw.get(accountSecretKey("local", "integration.webshare.wst")),
    ).toBe("renewed-session");
  });

  it("migrates only the dominant profile without falling back to another profile or copying installation secrets", async () => {
    const { db, raw, store } = setup();
    db.settings.set("migration.accountIntegrations.sourceProfile", "child");
    await raw.set("integration.tmdb.read-token", "default-token");
    await raw.set(
      profileSecretKey("child", "integration.webshare.wst"),
      "child-session",
    );
    await raw.set("sync.cloud.refresh-token", "installation-secret");
    await migrateAccountIntegrations(db, raw);
    expect(await store.get("integration.webshare.wst")).toBe("child-session");
    expect(await store.get("integration.tmdb.read-token")).toBeUndefined();
    expect(
      await raw.has(accountSecretKey("local", "sync.cloud.refresh-token")),
    ).toBe(false);
    expect(await store.get("sync.cloud.refresh-token")).toBe(
      "installation-secret",
    );
  });

  it("never resurrects an old legacy token after disconnection", async () => {
    const { db, raw, store } = setup();
    await raw.set("integration.webshare.wst", "legacy-session");
    await store.delete("integration.webshare.wst");
    await migrateAccountIntegrations(db, raw);
    const reopened = new AccountScopedSecretStore(db, raw);
    expect(await reopened.get("integration.webshare.wst")).toBeUndefined();
    expect(await raw.get("integration.webshare.wst")).toBe("legacy-session");
  });

  it("automatically connects an existing account service for a new profile and preserves it when another profile is deleted", async () => {
    const { db, raw } = setup();
    const app = createApp({
      environment: "test",
      logger: false,
      database: db,
      secretStore: raw,
      fetch: fetchReturning(200, tmdbConfiguration()),
    });
    try {
      const connected = await app.inject({
        method: "POST",
        url: "/api/v1/integrations/tmdb/connect",
        payload: { token: TEST_TOKEN },
      });
      expect(connected.statusCode).toBe(200);
      const child = await app.inject({
        method: "GET",
        url: "/api/v1/setup/status?profileId=child",
      });
      expect(child.json().integrations.tmdb).toMatchObject({
        configured: true,
        status: "connected",
      });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/profiles",
        payload: { name: "New viewer" },
      });
      expect(created.statusCode).toBe(201);
      const inherited = await app.inject({
        method: "GET",
        url: `/api/v1/setup/status?profileId=${created.json().id}`,
      });
      expect(inherited.json().integrations.tmdb).toMatchObject({
        configured: true,
        status: "connected",
      });
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: "/api/v1/profiles/default",
          })
        ).statusCode,
      ).toBe(204);
      expect(
        await raw.get(accountSecretKey("local", "integration.tmdb.read-token")),
      ).toBe(TEST_TOKEN);
      expect(db.integrations.get("tmdb", "child")).toMatchObject({
        setupStatus: "ready",
      });
      const remaining = await app.inject({
        method: "GET",
        url: "/api/v1/setup/status?profileId=child",
      });
      expect(remaining.json().integrations.tmdb.configured).toBe(true);
    } finally {
      await app.close();
    }
  });
});
