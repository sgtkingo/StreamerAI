import { afterEach, describe, expect, it } from "vitest";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

const apps: FastifyInstance[] = [];
const databases: StreamerDatabase[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const db of databases.splice(0)) db.close();
});
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";")[0]!;

function local() {
  const database = openStreamerDatabase({ filename: ":memory:" });
  databases.push(database);
  const app = createApp({ environment: "test", logger: false, database });
  apps.push(app);
  return { app, database };
}
function cloud() {
  let identity = "owner-one";
  let purpose = "login";
  let pending = false;
  let now = Date.now();
  const tokens = new Map<string, string>();
  const database = openStreamerDatabase({
    filename: ":memory:",
    clock: () => new Date(now),
  });
  databases.push(database);
  const secrets = new NonPersistentMemorySecretStore();
  let revoked = false;
  let connectionsAvailable = true;
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const token =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      "";
    if (path === "/v1/device/code") {
      purpose = String(body.purpose ?? "login");
      return Response.json({
        device_code: `code-${identity}-${now}`,
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.example/device",
        verification_uri_complete:
          "https://accounts.example/device?user_code=ABCD-EFGH",
        expires_in: 300,
        interval: 3,
      });
    }
    if (path === "/v1/device/token") {
      if (pending)
        return Response.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      const accessToken = `cloud-private-token-${identity}-${now}`;
      tokens.set(accessToken, identity);
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: purpose === "pin-reset" ? 300 : 2_592_000,
        purpose,
        account: {
          id: identity,
          email: `${identity}@example.com`,
          name: identity,
        },
        device: { id: `device-${identity}-${now}`, name: "Browser" },
      });
    }
    if (path === "/v1/account")
      return revoked
        ? Response.json({ error: "revoked" }, { status: 401 })
        : Response.json({
            id: tokens.get(token),
            email: `${tokens.get(token)}@example.com`,
            name: tokens.get(token),
          });
    if (path === "/v1/account/connections")
      return connectionsAvailable
        ? Response.json({
            accountId: tokens.get(token),
            connections: [
              {
                provider: "google",
                name: "Google",
                connected: true,
                available: true,
                accessToken: "must-not-escape",
              },
              {
                provider: "apple",
                name: "Apple",
                connected: false,
                available: false,
              },
            ],
          })
        : Response.json({ error: "offline" }, { status: 503 });
    if (init?.method === "DELETE" && path.startsWith("/v1/devices/"))
      return new Response(null, { status: 204 });
    if (path === "/v1/sync/snapshot" || path === "/v1/sync/pull")
      return Response.json({ cursor: "0", operations: [], hasMore: false });
    if (path === "/v1/sync/push")
      return Response.json({
        cursor: "1",
        acceptedIds: (body.operations as { id: string }[]).map((op) => op.id),
      });
    throw new Error("Unexpected cloud request.");
  };
  const app = createApp({
    environment: "test",
    logger: false,
    database,
    secretStore: secrets,
    accountServiceUrl: "https://accounts.example",
    accountFetch: fetcher,
    now: () => new Date(now),
  });
  apps.push(app);
  const login = async (
    user: string,
    options: {
      cookie?: string;
      adoptLocalAccount?: boolean;
      disableSync?: boolean;
    } = {},
  ) => {
    identity = user;
    now += 1000;
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: options.cookie ? { cookie: options.cookie } : {},
      payload: {
        adoptLocalAccount: options.adoptLocalAccount,
        disableSync: options.disableSync,
      },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: {
        cookie: [cookie(start), options.cookie].filter(Boolean).join("; "),
      },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe("approved");
    expect(poll.body).not.toContain("cloud-private-token");
    return cookie(poll);
  };
  return {
    app,
    database,
    login,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      revoked = true;
    },
    setConnectionsAvailable: (value: boolean) => {
      connectionsAvailable = value;
    },
    setIdentity: (user: string) => {
      identity = user;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
  };
}

describe("account authentication and profile boundaries", () => {
  it("reports account synchronization in the integration catalog and respects pause and account isolation", async () => {
    const { app, login } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const profiles = await app.inject({ url: "/api/v1/profiles", headers });
    const profileId = profiles.json().items[0].id as string;
    const catalog = async () => {
      const response = await app.inject({
        url: `/api/v1/integrations?profileId=${profileId}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      return response
        .json()
        .items.find((item: { id: string }) => item.id === "cloudflare-sync");
    };
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: true,
      status: "connected",
    });
    const paused = await app.inject({
      method: "PUT",
      url: "/api/v1/account/sync",
      headers,
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: false,
      status: "action_required",
    });
    const localSession = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const localHeaders = { cookie: cookie(localSession) };
    const localProfiles = await app.inject({
      url: "/api/v1/profiles",
      headers: localHeaders,
    });
    const localProfileId = localProfiles.json().items[0].id as string;
    const localCatalog = await app.inject({
      url: `/api/v1/integrations?profileId=${localProfileId}`,
      headers: localHeaders,
    });
    expect(
      localCatalog
        .json()
        .items.find((item: { id: string }) => item.id === "cloudflare-sync"),
    ).toMatchObject({
      selected: false,
      configured: false,
      status: "not_configured",
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/account/sync",
      headers,
      payload: { enabled: true },
    });
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: true,
      status: "connected",
    });
  });
  it("reads linked methods for the signed-in owner without exposing tokens and tolerates a cloud outage", async () => {
    const { app, login, setConnectionsAvailable } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const response = await app.inject({
      url: "/api/v1/account/connections",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connections: [
        { provider: "google", connected: true },
        { provider: "apple", available: false },
      ],
    });
    expect(response.body).not.toContain("must-not-escape");
    expect(response.body).not.toContain("cloud-private-token");
    const overview = await app.inject({ url: "/api/v1/account", headers });
    expect(
      new URL(overview.json().manageUrl).searchParams.get("account_id"),
    ).toBe("owner-one");
    setConnectionsAvailable(false);
    expect(
      (await app.inject({ url: "/api/v1/account/connections", headers }))
        .statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ url: "/api/v1/account", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/account/connections" })).statusCode,
    ).toBe(401);
  });
  it("opens an isolated household beside a claimed Google account without cloud credentials", async () => {
    const { app, database, login } = cloud();
    await login("owner-one");
    const owned = database.profiles.list("local")[0]!;
    database.profiles.update(owned.id, { name: "Private owner profile" });
    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    expect(entered.statusCode).toBe(200);
    const account = entered.json().account;
    expect(account.id).not.toBe("local");
    expect(account.cloudLinked).toBe(false);
    const headers = { cookie: cookie(entered) };
    const profiles = await app.inject({ url: "/api/v1/profiles", headers });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.body).not.toContain("Private owner profile");
    expect(
      (
        await app.inject({
          url: `/api/v1/setup/status?profileId=${owned.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const overview = (
      await app.inject({ url: "/api/v1/account", headers })
    ).json();
    expect(overview.manageUrl).toBeNull();
    expect(overview.sync.configured).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/device",
          headers,
          payload: {
            purpose: "pin-reset",
            profileId: profiles.json().items[0].id,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/local",
          headers: { origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it("keeps local profiles local when a separate online account signs in later", async () => {
    const { app, database, login } = cloud();
    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const localId = entered.json().account.id;
    const old = database.profiles.list(localId)[0]!;
    database.profiles.update(old.id, { name: "Local cinema" });
    const signed = await login("owner-one");
    expect(database.accounts.getLocal().cloudUserId).toBeNull();
    const profiles = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: signed },
    });
    expect(profiles.body).not.toContain("Local cinema");
    expect(database.profiles.getRequired(old.id).accountId).toBe(localId);
  });

  it("adopts only the explicitly reviewed household and invalidates its other sessions", async () => {
    const { app, database, login } = cloud();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const accountId = first.json().account.id;
    const profileId = database.profiles.list(accountId)[0]!.id;
    const signed = await login("owner-one", {
      cookie: cookie(first),
      adoptLocalAccount: true,
      disableSync: true,
    });
    expect(database.accounts.getRequired(accountId).cloudUserId).toBe(
      "owner-one",
    );
    expect(database.profiles.getRequired(profileId).accountId).toBe(accountId);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: cookie(second) },
        })
      ).statusCode,
    ).toBe(401);
    const overview = (
      await app.inject({ url: "/api/v1/account", headers: { cookie: signed } })
    ).json();
    expect(overview.sync.configured).toBe(false);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/account/sync",
          headers: { cookie: signed },
          payload: { enabled: true },
        })
      ).json().configured,
    ).toBe(true);
  });
  it("marks local cookies Secure when HTTPS terminates at the configured web proxy", async () => {
    const runtimeConfig = readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_WEB_ORIGIN: "https://cinema.example",
    });
    const app = createApp({
      environment: "test",
      logger: false,
      runtimeConfig,
    });
    apps.push(app);
    const status = await app.inject("/api/v1/auth/status");
    expect(status.statusCode).toBe(200);
    expect(String(status.headers["set-cookie"])).toContain("; Secure");
  });
  it("keeps local-only installations available and masks locked profile data", async () => {
    const { app, database } = local();
    const status = await app.inject("/api/v1/auth/status");
    expect(status.json()).toMatchObject({
      enabled: false,
      authenticated: true,
      cloudConfigured: false,
    });
    const owner = cookie(status);
    database.profiles.update("default", {
      preferences: { prompt: "Private taste", genres: ["Drama"] },
    });
    const set = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    expect(set.statusCode).toBe(200);
    const locked = await app.inject("/api/v1/profiles");
    expect(locked.json().items[0]).toMatchObject({
      name: "Viewer",
      pinEnabled: true,
      prompt: "",
      genres: [],
    });
    expect(locked.body).not.toContain("Private taste");
    expect(
      (await app.inject("/api/v1/profiles/default/library")).statusCode,
    ).toBe(423);
    const unlock = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/unlock",
      payload: { pin: "1234" },
    });
    expect(unlock.statusCode).toBe(204);
    const opened = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: cookie(unlock) },
    });
    expect(opened.json().items[0].prompt).toBe("Private taste");
  });
  it("rejects bypassing an existing PIN through settings and locks after repeated failures", async () => {
    const { app } = local();
    const owner = cookie(await app.inject("/api/v1/auth/status"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const bypass = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      payload: { pin: null },
    });
    expect(bypass.statusCode).toBe(403);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/profiles/default/unlock",
            payload: { pin: "9999" },
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/profiles/default/unlock",
          payload: { pin: "1234" },
        })
      ).statusCode,
    ).toBe(429);
  });
  it("relocks on explicit switch and invalidates old unlocks when PIN changes", async () => {
    const { app } = local();
    const owner = cookie(await app.inject("/api/v1/auth/status"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const unlock = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/unlock",
      payload: { pin: "1234" },
    });
    const viewer = cookie(unlock);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "4567", currentPin: "1234" },
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(423);
    await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/lock",
      headers: { cookie: owner },
      payload: {},
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(423);
  });
  it("requires authentication in cloud mode and rejects cross-origin account writes", async () => {
    const { app } = cloud();
    expect((await app.inject("/api/v1/profiles")).statusCode).toBe(401);
    expect((await app.inject("/api/v1/auth/status")).json().authenticated).toBe(
      false,
    );
    const cross = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { origin: "https://attacker.example" },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });
  it("claims legacy profiles once and isolates accounts, including body/query profile IDs", async () => {
    const { app, database, login } = cloud();
    const one = await login("owner-one");
    const two = await login("owner-two");
    expect(database.accounts.getLocal().cloudUserId).toBe("owner-one");
    const owned = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: one },
    });
    expect(owned.json().items.map((item: { id: string }) => item.id)).toContain(
      "default",
    );
    const second = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: two },
    });
    expect(second.json().items).toHaveLength(1);
    expect(second.body).not.toContain('"id":"default"');
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status?profileId=default",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status?profileId=missing-profile",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/integrations/webshare/connect",
          headers: { cookie: two },
          payload: { profileId: "default", username: "x", password: "x" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("binds a pending pairing to the initiating browser", async () => {
    const { app } = cloud();
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      payload: {},
    });
    const attempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.body).not.toContain("cloud-private-token");
  });
  it("never falls back to another account's default profile when the account is empty", async () => {
    const { app, database, login } = cloud();
    await login("owner-one");
    const owner = await login("owner-two");
    const account = database.accounts.getByCloudUserId("owner-two")!;
    for (const profile of database.profiles.list(account.id))
      database.profiles.delete(profile.id);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: owner },
        })
      ).json().items,
    ).toEqual([]);
    expect(database.profiles.get("default")?.accountId).toBe("local");
  });
  it("keeps an active protected profile unlocked and relocks after thirty idle minutes", async () => {
    const { app, login, advance } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    for (let index = 0; index < 3; index++) {
      advance(20 * 60_000);
      expect(
        (
          await app.inject({
            url: "/api/v1/profiles/default/library",
            headers: { cookie: owner },
          })
        ).statusCode,
      ).toBe(200);
    }
    advance(31 * 60_000);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(423);
  });
  it("requires fresh same-account Google approval for PIN recovery and never replaces the login session", async () => {
    const { app, login } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { cookie: owner },
      payload: { purpose: "pin-reset", profileId: "default" },
    });
    const recovery = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: { cookie: `${owner}; ${cookie(start)}` },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json().status).toBe("approved");
    expect(recovery.headers["set-cookie"]).toBeUndefined();
    const reset = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: null },
    });
    expect(reset.json()).toEqual({ pinEnabled: false });
  });
  it("rejects recovery using another Google account", async () => {
    const { app, login, setIdentity } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { cookie: owner },
      payload: { purpose: "pin-reset", profileId: "default" },
    });
    setIdentity("owner-two");
    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: { cookie: `${owner}; ${cookie(start)}` },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(recovered.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/profiles/default/pin",
          headers: { cookie: owner },
          payload: { pin: null },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("invalidates logout locally and honors cloud device revocation", async () => {
    const { app, login, revoke, advance } = cloud();
    const session = await login("owner-one");
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/status",
          headers: { cookie: session },
        })
      ).json().authenticated,
    ).toBe(true);
    revoke();
    advance(61_000);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(401);
  });
});
