import { afterEach, describe, expect, it } from "vitest";
import type { MediaProvider, MetadataProvider } from "@streamer-ai/contracts";
import {
  createApp,
  type FetchLike,
  type InferenceFetch,
} from "../src/index.js";
import { NonPersistentMemoryIntegrationStateStore } from "../src/stores/integration-state-store.js";

const unusedFetch: FetchLike = async () => {
  throw new Error("TMDB fetch should not run in a system-route test");
};

describe("system API", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function app() {
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    return instance;
  }

  it("reports liveness and readiness", async () => {
    const instance = app();
    const live = await instance.inject({
      method: "GET",
      url: "/api/v1/health/live",
    });
    const ready = await instance.inject({
      method: "GET",
      url: "/api/v1/health/ready",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: "ready" });
  });

  it("reports whether the configured local agent is loaded without exposing Ollama details", async () => {
    let resident = false;
    const inferenceFetch: InferenceFetch = async (url) => {
      expect(url).toMatch(/\/api\/ps$/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ model: resident ? "qwen3.5:4b" : "another-model:latest" }],
        }),
      };
    };
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      inferenceFetch,
      now: () => new Date("2026-09-27T12:00:00.000Z"),
    });
    apps.push(instance);
    const cold = await instance.inject({
      method: "GET",
      url: "/api/v1/inference/residency?record=true",
    });
    expect(cold.statusCode).toBe(200);
    expect(cold.json()).toEqual({
      state: "unloaded",
      checkedAt: "2026-09-27T12:00:00.000Z",
    });
    resident = true;
    const warm = await instance.inject({
      method: "GET",
      url: "/api/v1/inference/residency",
    });
    expect(warm.json()).toMatchObject({ state: "loaded" });
  });

  it("makes non-persistent development storage explicit", async () => {
    const instance = app();
    const setup = await instance.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });
    const integrations = await instance.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });

    expect(setup.json()).toMatchObject({
      status: "needs_setup",
      storage: { persistence: "mixed", durable: false },
    });
    const integrationBody = integrations.json();
    expect(integrationBody.persistence).toBe("memory");
    expect(integrationBody.items).toHaveLength(12);
    expect(
      integrationBody.items.find((item: { id: string }) => item.id === "tmdb"),
    ).toMatchObject({ id: "tmdb", status: "action_required" });
  });

  it("accepts configured community metadata and media providers as ready sources", async () => {
    const state = new NonPersistentMemoryIntegrationStateStore();
    for (const integrationId of ["community-db", "community-media"]) {
      await state.set({
        integrationId,
        status: "connected",
        configured: true,
        updatedAt: "2026-09-27T12:00:00.000Z",
      });
    }
    const descriptor = (id: string, family: "metadata" | "media") => ({
      id,
      family,
      displayName: id,
      connectorVersion: "1.0.0",
      capabilities: family === "metadata" ? ["movies"] : ["movie-search"],
      supportedLocales: ["en"],
      setupMode: "none" as const,
      credentialFields: [],
      canAutoDetect: false,
      supportsRecheck: true,
      supportsDisconnect: true,
      documentationUrl: null,
      privacySummary: "Uses a configured community source.",
    });
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      integrationStateStore: state,
      metadataProviders: [
        {
          descriptor: () => descriptor("community-db", "metadata"),
        } as MetadataProvider,
      ],
      mediaProviders: [
        {
          descriptor: () => descriptor("community-media", "media"),
        } as MediaProvider,
      ],
    });
    apps.push(instance);

    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      capabilities: { metadata: true, playback: true },
      integrations: {
        tmdb: { configured: false },
        webshare: { configured: false },
      },
    });
    expect(response.json().requiredSteps).not.toContain("connect_tmdb");
    expect(response.json().requiredSteps).not.toContain("connect_webshare");
  });

  it("saves planned source choices without marking adapters configured", async () => {
    const instance = app();
    const selected = await instance.inject({
      method: "PUT",
      url: "/api/v1/integrations/opensubtitles/selection",
      payload: { selected: true },
    });
    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toMatchObject({
      id: "opensubtitles",
      planned: true,
      selected: true,
      configured: false,
    });
    const catalog = await instance.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });
    expect(
      catalog
        .json()
        .items.find((item: { id: string }) => item.id === "opensubtitles"),
    ).toMatchObject({ selected: true, configured: false });

    const rejected = await instance.inject({
      method: "PUT",
      url: "/api/v1/integrations/webshare/selection",
      payload: { selected: true },
    });
    expect(rejected.statusCode).toBe(404);

    const deselected = await instance.inject({
      method: "PUT",
      url: "/api/v1/integrations/opensubtitles/selection",
      payload: { selected: false },
    });
    expect(deselected.json()).toMatchObject({
      selected: false,
      configured: false,
    });
  });

  it("lists a registered community adapter without a built-in catalog entry", async () => {
    const community = {
      descriptor: () => ({
        id: "community-media",
        family: "media" as const,
        displayName: "Community Media",
        connectorVersion: "1.0.0",
        capabilities: ["movie-search"],
        supportedLocales: ["en"],
        setupMode: "none" as const,
        credentialFields: [],
        canAutoDetect: false,
        supportsRecheck: true,
        supportsDisconnect: true,
        documentationUrl: null,
        privacySummary: "Searches a configured private media source.",
      }),
    } as MediaProvider;
    const instance = createApp({
      environment: "test",
      logger: false,
      fetch: unusedFetch,
      mediaProviders: [community],
    });
    apps.push(instance);

    const response = await instance.inject({
      method: "GET",
      url: "/api/v1/integrations",
    });
    expect(response.statusCode).toBe(200);
    expect(
      response
        .json()
        .items.find((item: { id: string }) => item.id === "community-media"),
    ).toMatchObject({
      category: "media",
      name: "Community Media",
      planned: false,
      configured: false,
    });
  });

  it("refuses memory stores in production composition", () => {
    expect(() =>
      createApp({
        environment: "production",
        logger: false,
        fetch: unusedFetch,
        databaseFilename: ":memory:",
      }),
    ).toThrow(/persistent SecretStore/);
  });

  it("maps an unsupported request content type to a safe client error", async () => {
    const instance = app();
    const response = await instance.inject({
      method: "POST",
      url: "/api/v1/inference/detect",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "unexpected=true",
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "The request is incomplete or invalid.",
      },
    });
  });
});
