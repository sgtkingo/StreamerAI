import { afterEach, expect, it } from "vitest";
import { hash } from "../src/http.js";
import { fixture } from "./helpers.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});

it("deletes only the verified browser owner's data and leaves a non-identifying deletion signal for connected devices", async () => {
  const f = fixture();
  fixtures.push(f);
  const token = "a".repeat(64);
  const revokedToken = "b".repeat(64);
  const insert = f.sqlite.prepare(
    "INSERT INTO cloud_device (id, account_id, name, purpose, token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, 'login', ?, ?, ?, ?)",
  );
  insert.run(
    "active",
    "account-a",
    "TV",
    await hash(token),
    f.now(),
    f.now() + 1000,
    null,
  );
  insert.run(
    "revoked",
    "account-a",
    "Old",
    await hash(revokedToken),
    f.now(),
    f.now() + 1000,
    f.now(),
  );
  expect(
    (await f.request("/v1/account", { method: "DELETE", token })).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account", {
        method: "DELETE",
        account: "a",
        origin: "https://evil.test",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account", {
        method: "DELETE",
        account: "a",
        authenticatedAt: f.now() - 300001,
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request("/v1/account", { method: "DELETE", account: "a" })).status,
  ).toBe(200);
  expect(f.sqlite.prepare('SELECT id FROM "user" ORDER BY id').all()).toEqual([
    { id: "account-b" },
    { id: "account-c" },
  ]);
  expect(
    f.sqlite.prepare("SELECT count(*) AS n FROM cloud_device").get(),
  ).toEqual({ n: 0 });
  const deleted = await f.request("/v1/device/deletion-status", { token });
  expect(deleted.status).toBe(410);
  expect(await deleted.json()).toEqual({ error: "account_deleted" });
  expect(
    (await f.request("/v1/device/deletion-status", { token: revokedToken }))
      .status,
  ).toBe(404);
  expect(
    (await f.request("/v1/device/deletion-status", { token: "c".repeat(64) }))
      .status,
  ).toBe(404);
});
