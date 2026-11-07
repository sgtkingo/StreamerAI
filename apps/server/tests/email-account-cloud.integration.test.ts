import { afterEach, expect, it, vi } from "vitest";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { openStreamerDatabase } from "@streamer-ai/database";
import {
  fixture,
  masterPinVerifier,
  origin,
} from "../../cloud/test/helpers.js";
import { createWorker } from "../../cloud/src/index.js";
import { createApp } from "../src/app.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("pairs a real email-only Better Auth identity with the home server and synchronizes the same owner", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  const f = fixture();
  const db = openStreamerDatabase({ filename: ":memory:" });
  const worker = createWorker();
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
  const app = createApp({
    environment: "test",
    logger: false,
    database: db,
    secretStore: new NonPersistentMemorySecretStore(),
    accountServiceUrl: origin,
    accountFetch: (input, init) =>
      worker.fetch(new Request(String(input), init), f.env),
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
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
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
    const initialApproval = await cloud(
      "/v1/device/approve",
      { user_code: start.json().userCode, approve: true },
      browser,
    );
    expect(initialApproval.status).toBe(409);
    const masterSetup = await worker.fetch(
      new Request(origin + "/v1/account/master-pin", {
        method: "PUT",
        headers: {
          origin,
          "content-type": "application/json",
          cookie: browser,
        },
        body: JSON.stringify({ verifier: masterPinVerifier("01234567") }),
      }),
      f.env,
    );
    expect(masterSetup.status).toBe(200);
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
      url: "/api/v1/auth/device/poll",
      headers: { cookie: String(start.headers["set-cookie"]).split(";")[0]! },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({
      status: "approved",
      account: {
        name: "email-only",
        email: "email-only@example.test",
        cloudLinked: true,
      },
    });
    const cookie = String(poll.headers["set-cookie"]).split(";")[0]!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/account/master-pin/verify",
          headers: { cookie },
          payload: { pin: "01234567" },
        })
      ).statusCode,
    ).toBe(204);
    const change = (currentPin: string, newPin: string) =>
      app.inject({
        method: "PUT",
        url: "/api/v1/account/master-pin",
        headers: { cookie },
        payload: { currentPin, newPin, confirmation: newPin },
      });
    expect((await change("01234567", "87654321")).json().error.code).toBe(
      "MASTER_PIN_UPGRADE_REQUIRED",
    );
    const enrollment = await worker.fetch(
      new Request(origin + "/v1/account/master-pin/enroll", {
        headers: { cookie: browser },
      }),
      f.env,
    );
    expect(enrollment.status).toBe(200);
    const details = (await enrollment.json()) as {
      salt: string;
      version: string;
      required: boolean;
    };
    expect(details.required).toBe(true);
    const changeSalt = randomBytes(16).toString("hex");
    expect(
      (
        await cloud(
          "/v1/account/master-pin/enroll",
          {
            version: details.version,
            proof: pbkdf2Sync(
              "01234567",
              details.salt,
              600_000,
              32,
              "sha256",
            ).toString("hex"),
            changeSalt,
            changeHash: pbkdf2Sync(
              "01234567",
              changeSalt,
              600_000,
              32,
              "sha256",
            ).toString("hex"),
          },
          browser,
        )
      ).status,
    ).toBe(200);
    expect((await change("01234567", "87654321")).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/account/master-pin/verify",
          headers: { cookie },
          payload: { pin: "87654321" },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/account/master-pin/verify",
          headers: { cookie },
          payload: { pin: "01234567" },
        })
      ).statusCode,
    ).toBe(403);
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie },
    });
    expect(sync.json()).toMatchObject({ configured: true, status: "idle" });
    const owner = db.accounts.getLocal().cloudUserId;
    const connections = await app.inject({
      url: "/api/v1/account/connections",
      headers: { cookie },
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
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM cloud_profile WHERE account_id = ?")
        .get(owner),
    ).toEqual({ n: 1 });
    const profileId = db.profiles.list(db.accounts.getLocal().id)[0]!.id;
    const headers = { cookie };
    await app.inject({
      method: "PUT",
      url: `/api/v1/profiles/${profileId}/pin`,
      headers,
      payload: { pin: "1234" },
    });
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
    expect(
      (
        await cloud(
          `/v1/account/pin-resets/${reset.json().id}/decision`,
          { approve: true },
          browser,
        )
      ).status,
    ).toBe(200);
    const approvedReset = await app.inject({
      method: "POST",
      url: `/api/v1/profiles/${profileId}/pin-reset/poll`,
      headers,
      payload: { requestId: reset.json().id },
    });
    expect(approvedReset.json()).toEqual({ status: "approved" });
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
  }
}, 15_000);
