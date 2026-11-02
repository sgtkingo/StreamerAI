import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { createWorker } from "../src/index.js";
import { fixture, origin } from "./helpers.js";

let f: ReturnType<typeof fixture>;
let worker: ReturnType<typeof createWorker>;
let mails: { to: { email: string }[]; textContent: string; subject: string }[];
let failMail = false;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  f = fixture();
  f.env.BREVO_API_KEY = "secret-test-mail-key";
  f.env.MAIL_FROM = "no-reply@example.test";
  worker = createWorker(undefined, { now: () => Date.now() });
  mails = [];
  failMail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.brevo.com/v3/smtp/email");
      expect(new Headers(init.headers).get("api-key")).toBe(
        "secret-test-mail-key",
      );
      mails.push(JSON.parse(String(init.body)));
      return failMail
        ? Response.json(
            { message: "secret-test-mail-key provider failure" },
            { status: 403 },
          )
        : Response.json({ messageId: "test-message" }, { status: 201 });
    }),
  );
});
afterEach(() => {
  f.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function call(
  path: string,
  data?: unknown,
  cookie = "",
  originHeader = origin,
) {
  return worker.fetch(
    new Request(origin + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        origin: originHeader,
        "content-type": "application/json",
        cookie,
        "cf-connecting-ip": "192.0.2.2",
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
    f.env,
  );
}
const send = (email = "new@example.test") =>
  call("/api/auth/email-otp/send-verification-otp", { email, type: "sign-in" });
const code = () => mails.at(-1)!.textContent.match(/\b\d{8}\b/)![0];
const verify = (otp: string, email = "new@example.test") =>
  call("/api/auth/sign-in/email-otp", { email, otp });
async function signedIn(email = "alice@example.test") {
  expect((await send(email)).status).toBe(200);
  const response = await verify(code(), email);
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

describe("real Better Auth email OTP flow", () => {
  it("bounds a stalled auth initialization and recovers on the next request", async () => {
    const now = Date.now();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(now);
    const database = f.env.DB;
    const stalled = () => new Promise<never>(() => {});
    const query = () => ({
      all: stalled,
      first: stalled,
      raw: stalled,
      run: stalled,
      bind: query,
    });
    f.env.DB = { ...database, prepare: query } as unknown as D1Database;
    const pending = call("/v1/account");
    await vi.advanceTimersByTimeAsync(15_001);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "auth_unavailable" });
    f.env.DB = database;
    expect((await call("/v1/account")).status).toBe(401);
    expect((await send()).status).toBe(200);
  });
  it("creates one owner, stores keyed hashes and issues only a secure HttpOnly session", async () => {
    expect((await send("NEW@example.test")).status).toBe(200);
    const otp = code();
    const stored = f.sqlite.prepare("SELECT value FROM verification").get() as {
      value: string;
    };
    expect(stored.value).not.toContain(otp);
    expect((await verify("00000000")).status).toBe(400);
    const response = await verify(otp);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const account = await call("/v1/account", undefined, cookie);
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({ email: "new@example.test" });
    expect((await verify(otp)).status).toBe(400);
  });

  it("requires Google owners to opt in and never merges merely by matching email", async () => {
    f.sqlite
      .prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('google-a', 'google-a', 'google', 'account-a', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    expect((await send("alice@example.test")).status).toBe(200);
    expect(mails).toHaveLength(0);
    expect((await verify("12345678", "alice@example.test")).status).toBe(400);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM cloud_email_login").get(),
    ).toEqual({ n: 0 });
  });

  it("enables email for the same authenticated owner only after a separate code", async () => {
    const cookie = await signedIn();
    expect(mails.at(-1)!.subject).toContain("přihlašovací kód");
    f.sqlite
      .prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('google-a', 'google-a', 'google', 'account-a', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    f.sqlite.exec("DELETE FROM cloud_email_login");
    vi.setSystemTime(Date.now() + 61_000);
    expect(
      (await call("/v1/account/email-login/code", {}, cookie)).status,
    ).toBe(200);
    expect(mails.at(-1)!.subject).toContain("aktivace e-mailu");
    expect(mails.at(-1)!.subject).not.toContain(code());
    expect(
      (
        await call(
          "/v1/account/email-login/confirm",
          { otp: "00000000" },
          cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (await call("/v1/account/email-login/confirm", { otp: code() }, cookie))
        .status,
    ).toBe(200);
    expect(
      f.sqlite.prepare("SELECT user_id FROM cloud_email_login").get(),
    ).toEqual({ user_id: "account-a" });
    expect(
      (await call("/v1/account/email-login", undefined, cookie)).status,
    ).toBe(200);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send("alice@example.test")).status).toBe(200);
    expect((await verify(code(), "alice@example.test")).status).toBe(200);
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM user WHERE email = 'alice@example.test'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });

  it("rejects an outstanding sign-in code after email is disabled", async () => {
    const cookie = await signedIn();
    f.sqlite
      .prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('google-a', 'google-a', 'google', 'account-a', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send("alice@example.test")).status).toBe(200);
    const otp = code();
    const result = await worker.fetch(
      new Request(origin + "/v1/account/email-login", {
        method: "DELETE",
        headers: { origin, cookie },
      }),
      f.env,
    );
    expect(result.status).toBe(200);
    expect((await verify(otp, "alice@example.test")).status).toBe(400);
    expect(f.sqlite.prepare("SELECT * FROM cloud_email_login").all()).toEqual(
      [],
    );
  });

  it("rejects expired or exhausted codes", async () => {
    await send();
    const otp = code();
    for (let i = 0; i < 5; i++)
      expect((await verify("00000000")).status).toBe(400);
    expect(
      (
        f.sqlite
          .prepare(
            "SELECT value FROM verification WHERE identifier = 'sign-in-otp-new@example.test'",
          )
          .get() as { value: string }
      ).value,
    ).toMatch(/:5$/);
    expect((await verify(otp)).status).toBe(400);
    vi.setSystemTime(Date.now() + 61_000);
    await send();
    const next = code();
    vi.setSystemTime(Date.now() + 601_000);
    expect((await verify(next)).status).toBe(400);
  });

  it("allows explicit Google linking only through a fresh browser owner session", async () => {
    const cookie = await signedIn("new@example.test");
    const response = await call(
      "/api/auth/link-social",
      { provider: "google", callbackURL: origin + "/account" },
      cookie,
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { url: string };
    expect(new URL(data.url).origin).toBe("https://accounts.google.com");
    expect(
      (
        await call(
          "/api/auth/link-social",
          { provider: "google", callbackURL: "https://evil.example" },
          cookie,
        )
      ).status,
    ).toBe(400);
  });

  it("completes Google OAuth linking on the existing e-mail owner without creating another user", async () => {
    const browser = await signedIn("new@example.test");
    const before = (await (
      await call("/v1/account", undefined, browser)
    ).json()) as { id: string };
    const start = await call(
      "/api/auth/link-social",
      { provider: "google", callbackURL: origin + "/account" },
      browser,
    );
    expect(start.status).toBe(200);
    const authorization = new URL(
      ((await start.json()) as { url: string }).url,
    );
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const encode = (data: unknown) =>
      Buffer.from(JSON.stringify(data)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const claims = encode({
      sub: "mock-google-subject",
      email: "new@example.test",
      email_verified: true,
      name: "New owner",
      iss: "https://accounts.google.com",
      aud: "test-client-id",
      iat: now,
      exp: now + 300,
      nonce: authorization.searchParams.get("nonce"),
    });
    const unsigned = encode({ alg: "RS256", kid: "test-key" }) + "." + claims;
    const token =
      unsigned +
      "." +
      sign("RSA-SHA256", Buffer.from(unsigned), pair.privateKey).toString(
        "base64url",
      );
    const mailFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init: RequestInit) => {
        const url = String(input);
        if (url === "https://oauth2.googleapis.com/token")
          return Response.json({
            access_token: "google-private-token",
            token_type: "Bearer",
            expires_in: 3600,
            id_token: token,
          });
        if (url === "https://www.googleapis.com/oauth2/v3/certs")
          return Response.json({
            keys: [
              {
                ...pair.publicKey.export({ format: "jwk" }),
                kid: "test-key",
                alg: "RS256",
                use: "sig",
              },
            ],
          });
        return mailFetch(url, init);
      }),
    );
    const stateCookie = start.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const callback = await call(
      "/api/auth/callback/google?code=mock-code&state=" +
        encodeURIComponent(authorization.searchParams.get("state")!),
      undefined,
      browser + "; " + stateCookie,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(origin + "/account");
    expect(
      await (await call("/v1/account", undefined, browser)).json(),
    ).toMatchObject({ id: before.id });
    expect(
      f.sqlite
        .prepare("SELECT userId FROM account WHERE providerId = 'google'")
        .get(),
    ).toEqual({ userId: before.id });
    expect(
      f.sqlite
        .prepare(
          "SELECT count(*) AS n FROM user WHERE email = 'new@example.test'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      (
        (await (
          await call("/v1/account/connections", undefined, browser)
        ).json()) as { connections: { connected: boolean }[] }
      ).connections
        .slice(0, 2)
        .every((item) => item.connected),
    ).toBe(true);
  });

  it("enforces a persistent resend cooldown and rotates away the old code", async () => {
    await send();
    const first = code();
    const firstSubject = mails.at(-1)!.subject;
    expect((await send()).status).toBe(429);
    expect(mails).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send()).status).toBe(200);
    expect(mails.at(-1)!.subject).not.toBe(firstSubject);
    expect(mails.at(-1)!.subject).not.toContain(code());
    expect((await verify(first)).status).toBe(400);
    expect((await verify(code())).status).toBe(200);
  });

  it("does not spend hourly mail budgets on repeated clicks during the resend cooldown", async () => {
    expect((await send()).status).toBe(200);
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await send();
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
    }
    expect(
      f.sqlite.prepare("SELECT SUM(hits) AS hits FROM cloud_rate_limit").get(),
    ).toEqual({ hits: 4 });
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send()).status).toBe(200);
    expect(mails).toHaveLength(2);
  });

  it("keeps unsupported OTP endpoints, foreign origins and owner actions closed", async () => {
    expect(
      (await call("/api/auth/email-otp/check-verification-otp", {})).status,
    ).toBe(404);
    expect((await call("/api/auth/email-otp/verify-email", {})).status).toBe(
      404,
    );
    expect(
      (
        await call(
          "/api/auth/email-otp/send-verification-otp",
          { email: "new@example.test", type: "sign-in" },
          "",
          "https://evil.example",
        )
      ).status,
    ).toBe(403);
    expect((await call("/v1/account/email-login/code", {})).status).toBe(401);
    const cookie = await signedIn();
    vi.setSystemTime(Date.now() + 301_000);
    expect(
      (await call("/v1/account/email-login/code", {}, cookie)).status,
    ).toBe(403);
    expect(
      (await call("/api/auth/link-social", { provider: "google" }, cookie))
        .status,
    ).toBe(403);
  });

  it("fails closed on mail delivery errors without exposing provider details or a usable OTP", async () => {
    failMail = true;
    const response = await send();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "email_unavailable" });
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM verification").get(),
    ).toEqual({ n: 0 });
    expect((await verify(code())).status).toBe(400);
  });
});
