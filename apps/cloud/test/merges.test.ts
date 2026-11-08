import { afterEach, beforeEach, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
} from "@streamer-ai/contracts";
import { accounts, fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});

function profile(id: string) {
  const { audioOutputDeviceId: _device, ...playback } =
    DEFAULT_PLAYBACK_PREFERENCES;
  return {
    id: crypto.randomUUID(),
    profileId: id,
    entityId: id,
    kind: "profile",
    action: "upsert",
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      name: id,
      locale: "cs",
      genres: [],
      playback,
      appearance: DEFAULT_APPEARANCE_PREFERENCES,
      onboardingComplete: true,
    },
  };
}

it("preserves the email identity and device, applies explicit profile selection and protects pending profiles", async () => {
  f.sqlite
    .prepare(
      "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?)",
    )
    .run(accounts.b!.id, f.now());
  f.sqlite
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
    VALUES ('google-row', 'google-sub', 'google', ?, ?, ?)`,
    )
    .run(accounts.a!.id, f.now(), f.now());
  for (const [account, ids] of [
    ["a", ["a1", "a2", "a3"]],
    ["b", ["b1", "b2", "b3"]],
  ] as const) {
    expect(
      (
        await f.request("/v1/sync/push", {
          method: "POST",
          account,
          data: { operations: ids.map(profile) },
        })
      ).status,
    ).toBe(200);
  }
  const token = "a".repeat(64);
  const tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  f.sqlite
    .prepare(
      "INSERT INTO cloud_device (id, account_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "device-a",
      accounts.a!.id,
      "device",
      tokenHash,
      f.now(),
      f.now() + 100_000,
    );
  const created = await f.request("/v1/merges", {
    method: "POST",
    account: "a",
    data: { target: accounts.b!.id },
  });
  expect(created.status).toBe(201);
  const merge = (await created.json()) as {
    id: string;
    target_account_id: string;
  };
  expect(merge.target_account_id).toBe(accounts.b!.id);
  const aList = (await (
    await f.request("/v1/merges", { account: "a" })
  ).json()) as { merges: Array<{ profiles: Array<{ id: string }> }> };
  expect(aList.merges[0]!.profiles.map((p) => p.id).sort()).toEqual([
    "a1",
    "a2",
    "a3",
  ]);
  const bList = (await (
    await f.request("/v1/merges", { account: "b" })
  ).json()) as { merges: Array<{ profiles: Array<{ id: string }> }> };
  expect(bList.merges[0]!.profiles).toHaveLength(6);
  const path = `/v1/merges/${merge.id}/decision`;
  const expectedProfileIds = ["a1", "a2", "a3", "b1", "b2", "b3"];
  expect(
    (
      await f.request(path, {
        method: "POST",
        account: "a",
        data: { approve: true, profileIds: ["a1"], expectedProfileIds },
      })
    ).status,
  ).toBe(404);
  const stale = await f.request(path, {
    method: "POST",
    account: "b",
    data: { approve: true, profileIds: ["a1"], expectedProfileIds: ["a1"] },
  });
  expect(await stale.json()).toEqual({ error: "merge_changed" });
  const result = await f.request(path, {
    method: "POST",
    account: "b",
    data: {
      approve: true,
      profileIds: ["a1", "a2", "b1", "b2"],
      expectedProfileIds,
    },
  });
  expect(await result.json()).toEqual({ ok: true, accountId: accounts.b!.id });
  expect(
    f.sqlite
      .prepare("SELECT id, account_id, active FROM cloud_profile ORDER BY id")
      .all(),
  ).toEqual(
    ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({
      id,
      account_id: accounts.b!.id,
      active: id.endsWith("3") ? 0 : 1,
    })),
  );
  expect(
    f.sqlite
      .prepare("SELECT userId FROM account WHERE id = 'google-row'")
      .get(),
  ).toEqual({ userId: accounts.b!.id });
  expect(
    await (await f.request("/v1/account", { token })).json(),
  ).toMatchObject({ id: accounts.b!.id });
  expect(
    await (
      await f.request(`/v1/account/merged-from/${accounts.a!.id}`, { token })
    ).json(),
  ).toEqual({ merged: true });
  expect(
    (await f.request(`/v1/account/merged-from/${accounts.c!.id}`, { token }))
      .status,
  ).toBe(404);
  expect(
    await (await f.request("/v1/sync/snapshot", { token })).json(),
  ).toEqual({ error: "account_merged" });
  expect(
    (
      await f.request("/v1/account/merge-ack", {
        method: "POST",
        token,
        data: { accountId: accounts.a!.id },
      })
    ).status,
  ).toBe(409);
  expect(
    await (
      await f.request("/v1/account/merge-ack", {
        method: "POST",
        token,
        data: { accountId: accounts.b!.id },
      })
    ).json(),
  ).toEqual({ ok: true });
  expect(
    await (
      await f.request("/v1/account/merge-ack", {
        method: "POST",
        token,
        data: { accountId: accounts.b!.id },
      })
    ).json(),
  ).toEqual({ ok: true });
  expect((await f.request("/v1/sync/snapshot", { token })).status).toBe(403);
  const snapshot = (await (
    await f.request("/v1/sync/snapshot", { account: "b" })
  ).json()) as { operations: Array<{ profileId: string; action: string }> };
  expect(snapshot.operations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ profileId: "a3", action: "delete" }),
      expect.objectContaining({ profileId: "b3", action: "delete" }),
      expect.objectContaining({ profileId: "a1", action: "upsert" }),
    ]),
  );
});

it("rejects merging two active email login methods without changing either account", async () => {
  f.sqlite
    .prepare(
      "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?), (?, ?)",
    )
    .run(accounts.a!.id, f.now(), accounts.b!.id, f.now());
  const response = await f.request("/v1/merges", {
    method: "POST",
    account: "a",
    data: { target: accounts.b!.id },
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "merge_email_conflict" });
  expect(
    f.sqlite.prepare('SELECT COUNT(*) AS count FROM "user"').get(),
  ).toEqual({ count: 3 });
});

it("merges a profile previously transferred from the survivor despite its old tombstone", async () => {
  f.sqlite
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
    VALUES ('google-row', 'google-sub', 'google', ?, ?, ?)`,
    )
    .run(accounts.a!.id, f.now(), f.now());
  const pushed = await f.request("/v1/sync/push", {
    method: "POST",
    account: "b",
    data: { operations: [profile("returned")] },
  });
  expect(pushed.status).toBe(200);
  const transfer = (await (
    await f.request("/v1/transfers", {
      method: "POST",
      account: "b",
      data: { profileId: "returned", target: accounts.a!.id },
    })
  ).json()) as { id: string };
  const accepted = await f.request(`/v1/transfers/${transfer.id}/accept`, {
    method: "POST",
    account: "a",
    data: {},
  });
  expect(accepted.status).toBe(200);
  const merge = (await (
    await f.request("/v1/merges", {
      method: "POST",
      account: "b",
      data: { target: accounts.a!.id },
    })
  ).json()) as { id: string };
  const result = await f.request(`/v1/merges/${merge.id}/decision`, {
    method: "POST",
    account: "a",
    data: {
      approve: true,
      profileIds: ["returned"],
      expectedProfileIds: ["returned"],
    },
  });
  expect(await result.json()).toEqual({ ok: true, accountId: accounts.b!.id });
  expect(
    f.sqlite
      .prepare(
        "SELECT account_id, active FROM cloud_profile WHERE id = 'returned'",
      )
      .get(),
  ).toEqual({ account_id: accounts.b!.id, active: 1 });
  expect(
    f.sqlite
      .prepare(
        "SELECT action FROM cloud_entity WHERE account_id = ? AND profile_id = 'returned'",
      )
      .get(accounts.b!.id),
  ).toEqual({ action: "upsert" });
});

it("preserves both Google identities and also a legacy email-only survivor", async () => {
  const addGoogle = (id: string, user: string) =>
    f.sqlite
      .prepare(
        `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
    VALUES (?, ?, 'google', ?, ?, ?)`,
      )
      .run(id, id, user, f.now(), f.now());
  addGoogle("google-a", accounts.a!.id);
  addGoogle("google-b", accounts.b!.id);
  const merge = (await (
    await f.request("/v1/merges", {
      method: "POST",
      account: "a",
      data: { target: accounts.b!.id },
    })
  ).json()) as { id: string };
  expect(
    await (
      await f.request(`/v1/merges/${merge.id}/decision`, {
        method: "POST",
        account: "b",
        data: { approve: true, profileIds: [], expectedProfileIds: [] },
      })
    ).json(),
  ).toEqual({ ok: true, accountId: accounts.a!.id });
  expect(
    f.sqlite
      .prepare("SELECT accountId, userId FROM account ORDER BY accountId")
      .all(),
  ).toEqual([
    { accountId: "google-a", userId: accounts.a!.id },
    { accountId: "google-b", userId: accounts.a!.id },
  ]);
  const second = (await (
    await f.request("/v1/merges", {
      method: "POST",
      account: "a",
      data: { target: accounts.c!.id },
    })
  ).json()) as { id: string; target_account_id: string };
  expect(second.target_account_id).toBe(accounts.c!.id);
  expect(
    await (
      await f.request(`/v1/merges/${second.id}/decision`, {
        method: "POST",
        account: "c",
        data: { approve: true, profileIds: [], expectedProfileIds: [] },
      })
    ).json(),
  ).toEqual({ ok: true, accountId: accounts.c!.id });
  expect(
    f.sqlite
      .prepare("SELECT user_id FROM cloud_email_login WHERE user_id = ?")
      .get(accounts.c!.id),
  ).toEqual({ user_id: accounts.c!.id });
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) AS count FROM account WHERE userId = ?")
      .get(accounts.c!.id),
  ).toEqual({ count: 2 });
  expect(
    f.sqlite
      .prepare(
        "SELECT source_id, target_id FROM cloud_account_merge_alias ORDER BY source_id",
      )
      .all(),
  ).toEqual([
    { source_id: accounts.a!.id, target_id: accounts.c!.id },
    { source_id: accounts.b!.id, target_id: accounts.c!.id },
  ]);
});

it("preserves a device's earlier third-party transfer notices without replacing a survivor profile", async () => {
  f.sqlite
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt)
    VALUES ('google-row', 'google-sub', 'google', ?, ?, ?)`,
    )
    .run(accounts.a!.id, f.now(), f.now());
  const token = "c".repeat(64);
  const tokenHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  f.sqlite
    .prepare(
      "INSERT INTO cloud_device (id, account_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      "source-device",
      accounts.a!.id,
      "device",
      tokenHash,
      f.now(),
      f.now() + 100_000,
    );
  expect(
    (
      await f.request("/v1/sync/push", {
        method: "POST",
        account: "a",
        data: {
          operations: [
            profile("to-third"),
            profile("to-survivor"),
            profile("retained"),
          ],
        },
      })
    ).status,
  ).toBe(200);
  for (const [id, targetAccount, target] of [
    ["to-third", "c", accounts.c!.id],
    ["to-survivor", "b", accounts.b!.id],
  ] as const) {
    const created = (await (
      await f.request("/v1/transfers", {
        method: "POST",
        account: "a",
        data: { profileId: id, target },
      })
    ).json()) as { id: string };
    expect(
      (
        await f.request(`/v1/transfers/${created.id}/accept`, {
          method: "POST",
          account: targetAccount,
          data: {},
        })
      ).status,
    ).toBe(200);
  }
  const merge = (await (
    await f.request("/v1/merges", {
      method: "POST",
      account: "a",
      data: { target: accounts.b!.id },
    })
  ).json()) as { id: string };
  const result = await f.request(`/v1/merges/${merge.id}/decision`, {
    method: "POST",
    account: "b",
    data: {
      approve: true,
      profileIds: ["retained", "to-survivor"],
      expectedProfileIds: ["retained", "to-survivor"],
    },
  });
  expect(await result.json()).toEqual({ ok: true, accountId: accounts.b!.id });
  expect(
    f.sqlite
      .prepare(
        "SELECT account_id,active FROM cloud_profile WHERE id = 'to-survivor'",
      )
      .get(),
  ).toEqual({ account_id: accounts.b!.id, active: 1 });
  expect(
    f.sqlite
      .prepare(
        "SELECT account_id,active FROM cloud_profile WHERE id = 'to-third'",
      )
      .get(),
  ).toEqual({ account_id: accounts.c!.id, active: 1 });
  expect(
    f.sqlite
      .prepare(
        "SELECT action FROM cloud_entity WHERE account_id = ? AND profile_id = 'to-survivor'",
      )
      .get(accounts.b!.id),
  ).toEqual({ action: "upsert" });
  expect(
    f.sqlite
      .prepare(
        "SELECT action FROM cloud_entity WHERE account_id = ? AND profile_id = 'to-third'",
      )
      .get(accounts.c!.id),
  ).toEqual({ action: "upsert" });
  const notices = await (
    await f.request("/v1/account/merge-tombstones", { token })
  ).json();
  expect(notices).toEqual({
    accountId: accounts.b!.id,
    operations: [
      expect.objectContaining({ profileId: "to-third", action: "delete" }),
    ],
    next: null,
  });
  f.sqlite.prepare('DELETE FROM "user" WHERE id = ?').run(accounts.c!.id);
  expect(
    await (await f.request("/v1/account/merge-tombstones", { token })).json(),
  ).toEqual(notices);
  expect(
    (await f.request("/v1/account/merge-tombstones", { account: "b" })).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/account/merge-ack", {
        method: "POST",
        token,
        data: { accountId: accounts.a!.id },
      })
    ).status,
  ).toBe(409);
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) AS count FROM cloud_merge_device_tombstone")
      .get(),
  ).toEqual({ count: 1 });
  expect(
    (
      await f.request("/v1/account/merge-ack", {
        method: "POST",
        token,
        data: { accountId: accounts.b!.id },
      })
    ).status,
  ).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT COUNT(*) AS count FROM cloud_merge_device_tombstone")
      .get(),
  ).toEqual({ count: 0 });
});
