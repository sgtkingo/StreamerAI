import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRuntimeConfig } from "../src/runtime-config.js";
import { openStreamerDatabase } from "@streamer-ai/database";
import { fixture, origin } from "../../cloud/test/helpers.js";
import { createWorker } from "../../cloud/src/index.js";
import { createApp } from "../src/app.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";

const sessionCookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";", 1)[0]!;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("connects a real email identity to the canonical household while keeping PIN management local", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  const f = fixture(),
    db = openStreamerDatabase({ filename: ":memory:" }),
    worker = createWorker();
  f.env.BREVO_API_KEY = "test-mail-key";
  f.env.MAIL_FROM = "no-reply@example.test";
  let otp = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const data = JSON.parse(String(init.body)) as { textContent: string };
      otp = data.textContent.match(/\b\d{8}\b/)![0];
      return Response.json({ messageId: "test-message" }, { status: 201 });
    }),
  );
  const cloudPaths: string[] = [];
  const directory = mkdtempSync(join(tmpdir(), "email-household-integration-"));
  const app = createApp({
    environment: "test",
    logger: false,
    database: db,
    secretStore: new NonPersistentMemorySecretStore(),
    accountServiceUrl: origin,
    runtimeConfig: readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_ACCESS_MODE: "paired",
      STREAMERAI_WEB_ORIGIN: "http://localhost:5173",
      STREAMERAI_DATA_DIR: directory,
      STREAMERAI_AGENT_MODE: "disabled",
    }),
    accountFetch: (input, init) => {
      cloudPaths.push(new URL(String(input)).pathname);
      return worker.fetch(new Request(String(input), init), f.env);
    },
  });
  const cloud = (path: string, data: unknown, cookie = "") =>
    worker.fetch(
      new Request(origin + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json", cookie },
        body: JSON.stringify(data),
      }),
      f.env,
    );
  try {
    // Opening setup creates the household session. The PIN is requested only
    // after cloud login determines whether this is a new or existing household.
    const claim = await app.inject({
      method: "POST",
      url: "/api/v1/installation/setup",
      headers: { host: "localhost:5173", origin: "http://localhost:5173" },
      payload: {},
    });
    expect(claim.statusCode).toBe(200);
    const cookie = sessionCookie(claim),
      headers = {
        cookie,
        host: "localhost:5173",
        origin: "http://localhost:5173",
      };
    const local = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      headers,
      payload: { deferMasterPin: true },
    });
    expect(local.statusCode).toBe(200);
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/account/cloud/device",
      headers,
      payload: {},
    });
    expect(start.statusCode).toBe(200);
    expect(
      (
        await cloud("/api/auth/email-otp/send-verification-otp", {
          email: "email-only@example.test",
          type: "sign-in",
        })
      ).status,
    ).toBe(200);
    const login = await cloud("/api/auth/sign-in/email-otp", {
      email: "email-only@example.test",
      otp,
    });
    expect(login.status).toBe(200);
    const browser = login.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    expect(
      (
        await cloud(
          "/v1/device/approve",
          { user_code: start.json().userCode, approve: true },
          browser,
        )
      ).status,
    ).toBe(200);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/account/cloud/device/poll",
      headers: { ...headers, cookie: cookie + "; " + sessionCookie(start) },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({
      status: "approved",
      account: {
        id: local.json().account.id,
        email: "email-only@example.test",
        cloudLinked: true,
      },
    });
    const pending = await app.inject({ url: "/api/v1/auth/status", headers });
    expect(pending.json()).toMatchObject({
      authenticated: true,
      householdReady: false,
      masterPinSetupRequired: true,
      householdRestoreRequired: false,
    });
    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/account/master-pin",
      headers,
      payload: { pin: "01234567", confirmation: "01234567" },
    });
    expect(setup.statusCode).toBe(200);
    const verify = (pin: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/account/master-pin/verify",
        headers,
        payload: { pin },
      });
    expect((await verify("01234567")).statusCode).toBe(204);
    const change = (currentPin: string, newPin: string) =>
      app.inject({
        method: "PUT",
        url: "/api/v1/account/master-pin",
        headers,
        payload: { currentPin, newPin, confirmation: newPin },
      });
    expect((await change("99999999", "87654321")).statusCode).toBe(403);
    expect((await change("01234567", "87654321")).statusCode).toBe(200);
    expect((await verify("87654321")).statusCode).toBe(204);
    expect((await verify("01234567")).statusCode).toBe(403);
    expect(
      cloudPaths.some((path) => path.startsWith("/v1/account/master-pin")),
    ).toBe(false);
    const synced = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(synced.json()).toMatchObject({ configured: true, status: "idle" });
    const account = db.accounts.getHousehold(),
      owner = account.cloudUserId;
    expect(account.id).toBe(local.json().account.id);
    const connections = await app.inject({
      url: "/api/v1/account/connections",
      headers,
    });
    expect(connections.statusCode).toBe(200);
    expect(connections.json()).toMatchObject({
      connections: [
        { provider: "email", connected: true, available: true },
        { provider: "google", connected: false, available: true },
        { provider: "apple", connected: false, available: false },
      ],
    });
    expect(
      f.sqlite
        .prepare("SELECT user_id FROM cloud_email_login WHERE user_id = ?")
        .get(owner),
    ).toEqual({ user_id: owner });
    const household = f.sqlite
      .prepare("SELECT id FROM cloud_household WHERE account_id = ?")
      .get(owner) as { id: string };
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM cloud_household_sync_profile WHERE account_id = ?",
        )
        .get(household.id),
    ).toEqual({ n: 1 });
    const profileId = db.profiles.list(account.id)[0]!.id;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/profiles/${profileId}/pin`,
          headers,
          payload: { pin: "1234" },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/lock`,
      headers,
    });
    const reset = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/pin-reset`,
      headers,
      payload: {},
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json().manageUrl).toContain("/admin?tab=profiles");
    expect(
      (await app.inject({ url: "/api/v1/admin/pin-resets", headers })).json()
        .requests,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/admin/pin-resets/${reset.json().id}/decision`,
          headers,
          payload: { approve: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/profiles/${profileId}/pin-reset/poll`,
          headers,
          payload: { requestId: reset.json().id },
        })
      ).json(),
    ).toEqual({ status: "approved" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/profiles/${profileId}/pin`,
          headers,
          payload: { pin: null },
        })
      ).json(),
    ).toEqual({ pinEnabled: false });
  } finally {
    await app.close();
    db.close();
    f.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
