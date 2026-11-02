import { afterEach, expect, it } from "vitest";
import { fixture } from "./helpers.js";
import { hash } from "../src/http.js";
import { emailLogin } from "../src/email-login.js";
import { origin } from "./helpers.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

it("allows a paired installation to read enrollment but rejects PIN-reset credentials", async () => {
  const f = fixture();
  fixtures.push(f);
  const token = "a".repeat(64);
  f.sqlite
    .prepare(
      "INSERT INTO cloud_device (id, account_id, name, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "device",
      "account-a",
      "Home",
      "login",
      await hash(token),
      f.now(),
      f.now() + 60_000,
    );
  const response = await f.request("/v1/account/connections", { token });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accountId: "account-a" });
  f.sqlite.exec("UPDATE cloud_device SET purpose = 'pin-reset'");
  expect((await f.request("/v1/account/connections", { token })).status).toBe(
    403,
  );
});

it("lists only this owner's linked providers, without credential material", async () => {
  const f = fixture();
  fixtures.push(f);
  f.env.BREVO_API_KEY = "test";
  f.env.MAIL_FROM = "no-reply@example.test";
  f.sqlite
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, accessToken, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "google-a",
      "private-provider-id",
      "google",
      "account-a",
      "private-provider-token",
      f.now(),
      f.now(),
    );
  f.sqlite
    .prepare(
      "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?)",
    )
    .run("account-a", f.now());
  const response = await f.request("/v1/account/connections", { account: "a" });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("private-provider");
  expect(JSON.parse(text)).toEqual({
    accountId: "account-a",
    connections: [
      {
        provider: "email",
        name: "StreamerAI e-mail",
        connected: true,
        available: true,
      },
      { provider: "google", name: "Google", connected: true, available: true },
      { provider: "apple", name: "Apple", connected: false, available: false },
    ],
  });
  const other = await f.request("/v1/account/connections", { account: "b" });
  expect(
    (
      (await other.json()) as { connections: { connected: boolean }[] }
    ).connections.every((item) => !item.connected),
  ).toBe(true);
  expect((await f.request("/v1/account/connections")).status).toBe(401);
});

it("removes only the owner's method and preserves a usable alternative", async () => {
  const f = fixture();
  fixtures.push(f);
  f.env.BREVO_API_KEY = "test";
  f.env.MAIL_FROM = "no-reply@example.test";
  const addGoogle = f.sqlite.prepare(
    "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)",
  );
  addGoogle.run("google-a", "provider-a", "account-a", f.now(), f.now());
  addGoogle.run("google-b", "provider-b", "account-b", f.now(), f.now());
  f.sqlite
    .prepare("INSERT INTO cloud_email_login VALUES (?, ?)")
    .run("account-a", f.now());
  f.sqlite
    .prepare("INSERT INTO cloud_email_login VALUES (?, ?)")
    .run("account-b", f.now());

  expect(
    (await f.request("/v1/account/google-login", { method: "DELETE" })).status,
  ).toBe(401);
  expect(
    (
      await f.request("/v1/account/google-login", {
        method: "DELETE",
        account: "a",
        origin: "https://evil.test",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account/google-login", {
        method: "DELETE",
        account: "a",
        authenticatedAt: f.now() - 300_001,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account/google-login", {
        method: "DELETE",
        account: "a",
      })
    ).status,
  ).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT userId FROM account WHERE providerId = 'google'")
      .all(),
  ).toEqual([{ userId: "account-b" }]);
  const last = await f.request("/v1/account/email-login", {
    method: "DELETE",
    account: "a",
  });
  expect(last.status).toBe(409);
  expect(await last.json()).toEqual({ error: "last_sign_in_method" });
  expect(
    (
      await f.request("/v1/account/google-login", {
        method: "DELETE",
        account: "a",
      })
    ).status,
  ).toBe(404);

  expect(
    (
      await f.request("/v1/account/email-login", {
        method: "DELETE",
        account: "b",
      })
    ).status,
  ).toBe(200);
  const googleLast = await f.request("/v1/account/google-login", {
    method: "DELETE",
    account: "b",
  });
  expect(googleLast.status).toBe(409);
  expect(await googleLast.json()).toEqual({ error: "last_sign_in_method" });
});

it("does not remove Google when email login is unavailable", async () => {
  const f = fixture();
  fixtures.push(f);
  f.sqlite
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)",
    )
    .run("google-a", "provider-a", "account-a", f.now(), f.now());
  f.sqlite
    .prepare("INSERT INTO cloud_email_login VALUES (?, ?)")
    .run("account-a", f.now());
  const result = await f.request("/v1/account/google-login", {
    method: "DELETE",
    account: "a",
  });
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ error: "email_unavailable" });
  expect(f.sqlite.prepare("SELECT count(*) AS n FROM account").get()).toEqual({
    n: 1,
  });
});

it("does not re-enable email if disabled while OTP verification is in progress", async () => {
  const f = fixture();
  fixtures.push(f);
  f.env.BREVO_API_KEY = "test";
  f.env.MAIL_FROM = "no-reply@example.test";
  f.sqlite
    .prepare(
      "INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, 'google', ?, ?, ?)",
    )
    .run("google-a", "provider-a", "account-a", f.now(), f.now());
  f.sqlite
    .prepare("INSERT INTO cloud_email_login VALUES (?, ?)")
    .run("account-a", f.now());
  const request = new Request(origin + "/api/auth/sign-in/email-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alice@example.test", otp: "12345678" }),
  });
  await expect(
    emailLogin(
      request,
      f.env,
      {
        getSession: async () => null,
        handler: async () => {
          f.sqlite
            .prepare("DELETE FROM cloud_email_login WHERE user_id = ?")
            .run("account-a");
          return Response.json({ user: { id: "account-a" } });
        },
      },
      f.now(),
    ),
  ).rejects.toMatchObject({ code: "invalid_otp" });
  expect(f.sqlite.prepare("SELECT * FROM cloud_email_login").all()).toEqual([]);
});
