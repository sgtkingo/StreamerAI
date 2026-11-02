import { afterEach, describe, expect, it } from "vitest";
import { accountSecretKey } from "../src/stores/account-integrations.js";
import {
  createApp,
  NonPersistentMemorySecretStore,
  WEBSHARE_WST_SECRET_KEY,
  type FetchLike,
  type ProviderFetch,
} from "../src/index.js";

const unusedTmdbFetch: FetchLike = async () => {
  throw new Error("TMDB fetch should not run in Webshare route tests");
};

function xmlResponse(body: string) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
  };
}

describe("Webshare connection API", () => {
  const apps: ReturnType<typeof createApp>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("stores only WST and exposes only sanitized connection state", async () => {
    const secrets = new NonPersistentMemorySecretStore();
    const calls: Array<{ url: string; body: string }> = [];
    const providerFetch: ProviderFetch = async (url, init) => {
      calls.push({ url, body: init.body ?? "" });
      return url.endsWith("/salt/")
        ? xmlResponse(
            "<response><status>OK</status><salt>salt</salt></response>",
          )
        : xmlResponse(
            "<response><status>OK</status><token>authorized-session-token</token></response>",
          );
    };
    const app = createApp({
      environment: "test",
      logger: false,
      fetch: unusedTmdbFetch,
      providerFetch,
      secretStore: secrets,
      now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/webshare/connect",
      payload: { username: "viewer", password: "plain-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      integrationId: "webshare",
      ok: true,
      status: "connected",
      messageCode: "CONNECTED",
      persistence: "memory",
    });
    expect(response.body).not.toContain("plain-password");
    expect(response.body).not.toContain("authorized-session-token");
    expect(
      await secrets.get(accountSecretKey("local", WEBSHARE_WST_SECRET_KEY)),
    ).toBe("authorized-session-token");
    expect(calls[1]?.body).not.toContain("plain-password");

    const setup = await app.inject({
      method: "GET",
      url: "/api/v1/setup/status",
    });
    expect(setup.json().integrations.webshare).toMatchObject({
      configured: true,
      status: "connected",
    });
  });
});
