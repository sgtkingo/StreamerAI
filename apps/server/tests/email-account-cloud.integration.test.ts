import { afterEach, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import { fixture, origin } from "../../cloud/test/helpers.js";
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
  } finally {
    await app.close();
    db.close();
    f.close();
  }
});
