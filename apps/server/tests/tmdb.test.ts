import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createApp,
  createAppLogger,
  NonPersistentMemoryIntegrationStateStore,
  NonPersistentMemorySecretStore,
  TMDB_CONFIGURATION_URL,
  type FetchLike,
} from "../src/index.js";
import { fetchReturning, TEST_TOKEN, tmdbConfiguration } from "./fixtures.js";
import { accountSecretKey } from "../src/stores/account-integrations.js";

describe("TMDB guided connection", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function app(fetch: FetchLike, overrides: { timeoutMs?: number } = {}) {
    const secretStore = new NonPersistentMemorySecretStore();
    const integrationStateStore =
      new NonPersistentMemoryIntegrationStateStore();
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch,
      secretStore,
      integrationStateStore,
      tmdbTimeoutMs: overrides.timeoutMs,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    return { instance, secretStore, integrationStateStore };
  }

  it("checks the official configuration endpoint without saving", async () => {
    let observedUrl: string | undefined;
    let observedAuthorization: string | undefined;
    const fetch: FetchLike = async (url, options) => {
      observedUrl = url;
      observedAuthorization = options.headers.authorization;
      return fetchReturning(200, tmdbConfiguration())(url, options);
    };
    const { instance, secretStore } = app(fetch);

    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/check",
      payload: { token: TEST_TOKEN },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      integrationId: "tmdb",
      ok: true,
      status: "verified",
      messageCode: "VERIFIED",
    });
    expect(observedUrl).toBe(TMDB_CONFIGURATION_URL);
    expect(observedAuthorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(await secretStore.has("integration.tmdb.read-token")).toBe(false);
    expect(result.body).not.toContain(TEST_TOKEN);
  });

  it("connects only after validation and reports memory persistence", async () => {
    const { instance, secretStore } = app(
      fetchReturning(200, tmdbConfiguration()),
    );

    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/connect",
      payload: { token: TEST_TOKEN },
    });
    const catalog = await instance.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      ok: true,
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "memory",
    });
    expect(
      await secretStore.has(
        accountSecretKey("local", "integration.tmdb.read-token"),
      ),
    ).toBe(true);
    expect(result.body).not.toContain(TEST_TOKEN);
    expect(result.body).not.toContain("secretRef");
    const catalogBody = catalog.json();
    expect(catalogBody.persistence).toBe("memory");
    expect(
      catalogBody.items.find((item: { id: string }) => item.id === "tmdb"),
    ).toMatchObject({ id: "tmdb", status: "connected", configured: true });
    expect(catalog.body).not.toContain(TEST_TOKEN);
  });

  it("disconnects without exposing or retaining the credential", async () => {
    const { instance, secretStore, integrationStateStore } = app(
      fetchReturning(200, tmdbConfiguration()),
    );
    await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/connect",
      payload: { token: TEST_TOKEN },
    });

    const result = await instance.inject({
      method: "DELETE",
      url: "/api/v1/integrations/tmdb",
    });

    expect(result.statusCode).toBe(204);
    expect(
      await secretStore.has(
        accountSecretKey("local", "integration.tmdb.read-token"),
      ),
    ).toBe(false);
    expect(await integrationStateStore.get("tmdb")).toBeUndefined();
  });

  it("returns a sanitized, actionable 401 and does not save a rejected token", async () => {
    const { instance, secretStore } = app(
      fetchReturning(401, { status_message: `Rejected ${TEST_TOKEN}` }),
    );

    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/connect",
      payload: { token: TEST_TOKEN },
    });

    expect(result.statusCode).toBe(401);
    expect(result.json()).toMatchObject({
      ok: false,
      status: "action-required",
      messageCode: "CREDENTIAL_REJECTED",
    });
    expect(await secretStore.has("integration.tmdb.read-token")).toBe(false);
    expect(result.body).not.toContain(TEST_TOKEN);
    expect(result.body).not.toContain("status_message");
  });

  it("returns a sanitized timeout and does not log a token from an error", async () => {
    let logs = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const fetch: FetchLike = async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            const error = new Error(`Timeout while using ${TEST_TOKEN}`);
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    const secretStore = new NonPersistentMemorySecretStore();
    const instance = createApp({
      environment: "test",
      logger: createAppLogger({ destination }),
      fetch,
      secretStore,
      integrationStateStore: new NonPersistentMemoryIntegrationStateStore(),
      tmdbTimeoutMs: 5,
    });
    apps.push(instance);

    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/connect",
      payload: { token: TEST_TOKEN },
    });

    expect(result.statusCode).toBe(504);
    expect(result.json()).toMatchObject({
      ok: false,
      status: "unavailable",
      messageCode: "TIMEOUT",
    });
    expect(await secretStore.has("integration.tmdb.read-token")).toBe(false);
    expect(result.body).not.toContain(TEST_TOKEN);
    expect(logs).not.toContain(TEST_TOKEN);
  });

  it("rejects a successful-looking but malformed TMDB response", async () => {
    const { instance, secretStore } = app(
      fetchReturning(200, { success: true }),
    );

    const result = await instance.inject({
      method: "POST",
      url: "/api/v1/integrations/tmdb/connect",
      payload: { token: TEST_TOKEN },
    });

    expect(result.statusCode).toBe(502);
    expect(result.json()).toMatchObject({
      messageCode: "INVALID_RESPONSE",
    });
    expect(await secretStore.has("integration.tmdb.read-token")).toBe(false);
  });
});
