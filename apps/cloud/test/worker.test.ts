import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";

import { createAuth } from "../src/auth.js";
import { accounts, fixture, origin } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});

function profile(profileId = "profile-1", date?: string): AccountSyncOperation {
  const { audioOutputDeviceId: _device, ...playback } =
    DEFAULT_PLAYBACK_PREFERENCES;
  return {
    id: crypto.randomUUID(),
    profileId,
    entityId: profileId,
    kind: "profile",
    action: "upsert",
    updatedAt: date ?? new Date(f.now()).toISOString(),
    payload: {
      name: "My profile",
      locale: "cs",
      genres: [],
      playback,
      appearance: DEFAULT_APPEARANCE_PREFERENCES,
      onboardingComplete: true,
    },
  };
}
const title = {
  id: "tmdb:movie:1",
  kind: "movie" as const,
  title: "Test title",
  originalTitle: null,
  year: 2020,
  synopsis: "Test",
  genres: [],
  metadataProvider: "tmdb",
  metadataValidatedAt: "2026-11-01T11:00:00.000Z",
};
function library(profileId = "profile-1"): AccountSyncOperation {
  return {
    id: crypto.randomUUID(),
    profileId,
    entityId: title.id,
    kind: "library",
    action: "upsert",
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      title,
      membershipReason: "explicit",
      state: "saved",
      progressPercent: null,
      lastPlayedAt: null,
    },
  };
}
async function push(operations: AccountSyncOperation[], account = "a") {
  return f.request("/v1/sync/push", {
    method: "POST",
    account,
    data: { operations },
  });
}
async function snapshot(account = "a") {
  const operations: AccountSyncOperation[] = [];
  let after = "";
  for (;;) {
    const page = (await (
      await f.request(
        "/v1/sync/snapshot" +
          (after ? "?after=" + encodeURIComponent(after) : ""),
        { account },
      )
    ).json()) as {
      operations: AccountSyncOperation[];
      cursor: string;
      hasMore: boolean;
    };
    operations.push(...page.operations);
    after = page.cursor;
    if (!page.hasMore) return { operations, cursor: after };
  }
}
async function device(account = "a") {
  const start = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: { client_id: "streamer-ai-home", device_name: "Living room" },
    })
  ).json()) as { device_code: string; user_code: string };
  const approved = await f.request("/v1/device/approve", {
    method: "POST",
    account,
    data: { user_code: start.user_code, approve: true },
  });
  expect(approved.status).toBe(200);
  return (
    await f.request("/v1/device/token", {
      method: "POST",
      data: {
        client_id: "streamer-ai-home",
        device_code: start.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    })
  ).json() as Promise<{
    access_token: string;
    account: { id: string };
    device: { id: string };
  }>;
}

describe("identity and device grants", () => {
  it("lists only claimed pending grants for their owner and requires the device code for approval", async () => {
    const grant = (await (
      await f.request("/v1/device/code", {
        method: "POST",
        data: { client_id: "streamer-ai-home", device_name: "TV" },
      })
    ).json()) as { user_code: string; device_code: string };
    const pending = async (account: string) =>
      (await (await f.request("/v1/device/pending", { account })).json()) as {
        pairings: Array<{ id: string; device_name: string }>;
      };
    expect((await pending("a")).pairings).toEqual([]);
    expect(
      (
        await f.request("/v1/device/claim", {
          method: "POST",
          account: "a",
          data: { user_code: grant.user_code },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request("/v1/device/claim", {
          method: "POST",
          account: "a",
          data: { user_code: grant.user_code },
        })
      ).status,
    ).toBe(200);
    const { pairings } = await pending("a");
    expect(pairings).toHaveLength(1);
    expect(pairings[0]?.device_name).toBe("TV");
    const storedGrant = f.sqlite
      .prepare("SELECT user_hash, device_hash FROM cloud_device_grant")
      .get() as { user_hash: string; device_hash: string };
    expect(pairings[0]?.id).not.toBe(storedGrant.user_hash);
    expect(pairings[0]?.id).not.toBe(storedGrant.device_hash);
    expect(JSON.stringify(pairings)).not.toContain(grant.device_code);
    expect((await pending("b")).pairings).toEqual([]);
    expect(
      (
        await f.request("/v1/device/verify?user_code=" + grant.user_code, {
          account: "b",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/v1/device/claim", {
          method: "POST",
          account: "b",
          data: { user_code: grant.user_code },
        })
      ).status,
    ).toBe(400);
    const path = "/v1/device/pending/" + pairings[0]?.id + "/decision";
    expect(
      (
        await f.request(path, {
          method: "POST",
          account: "b",
          data: { approve: false },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/v1/device/approve", {
          method: "POST",
          account: "b",
          data: { user_code: grant.user_code, approve: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(path, {
          method: "POST",
          account: "a",
          data: { approve: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(path, {
          method: "POST",
          account: "a",
          data: { approve: true, user_code: grant.user_code },
        })
      ).status,
    ).toBe(200);
    expect((await pending("a")).pairings).toEqual([]);
  });

  it("allows only one account to claim a pending code and excludes expired grants", async () => {
    const grant = (await (
      await f.request("/v1/device/code", {
        method: "POST",
        data: { client_id: "streamer-ai-home", device_name: "TV" },
      })
    ).json()) as { user_code: string };
    const claim = (account: string) =>
      f.request("/v1/device/claim", {
        method: "POST",
        account,
        data: { user_code: grant.user_code },
      });
    const outcomes = await Promise.all([claim("a"), claim("b")]);
    expect(outcomes.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    const winner = outcomes[0]?.status === 200 ? "a" : "b";
    f.advance(300_001);
    expect(
      await (await f.request("/v1/device/pending", { account: winner })).json(),
    ).toEqual({ pairings: [] });
  });

  it("uses the native Better Auth D1 schema to start a Google state-protected login", async () => {
    const auth = createAuth(f.env);
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          provider: "google",
          callbackURL: origin + "/account",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const data = (await response.json()) as { url: string };
    const google = new URL(data.url);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.searchParams.get("redirect_uri")).toBe(
      origin + "/api/auth/callback/google",
    );
    expect(google.searchParams.get("state")).toBeTruthy();
    expect(google.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("rejects anonymous requests, arbitrary OAuth callbacks and cross-origin approval", async () => {
    expect((await f.request("/v1/account")).status).toBe(401);
    expect(
      (
        await f.request("/api/auth/sign-in/social", {
          method: "POST",
          data: {
            provider: "google",
            callbackURL: "https://evil.test/account",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request("/v1/device/approve", {
          method: "POST",
          account: "a",
          origin: "https://evil.test",
          data: { user_code: "ABCD-EFGH", approve: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (await f.request("/api/auth/sign-up/email", { method: "POST", data: {} }))
        .status,
    ).toBe(404);
  });

  it("requires explicit approval and returns a hashed, account-bound, revocable device credential", async () => {
    const token = await device();
    expect(token.account.id).toBe(accounts.a?.id);
    expect(token.access_token).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(200);
    expect(
      (
        await f.request("/v1/account/connections", {
          token: token.access_token,
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await f.request("/v1/account", { token: token.access_token })
      ).json(),
    ).toEqual({ ...accounts.a, mergeAckRequired: false, householdId: null });
    const stored = f.sqlite
      .prepare("SELECT token_hash FROM cloud_device")
      .get() as { token_hash: string };
    expect(stored.token_hash).not.toBe(token.access_token);
    expect(
      (await f.request("/v1/devices", { token: token.access_token })).status,
    ).toBe(403);
    expect(
      (
        await f.request("/v1/transfers", {
          method: "POST",
          token: token.access_token,
          data: {},
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request("/v1/devices/" + token.device.id, {
          method: "DELETE",
          account: "b",
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(200);
    await f.request("/v1/devices/" + token.device.id, {
      method: "DELETE",
      account: "a",
    });
    expect(
      f.sqlite
        .prepare("SELECT id FROM cloud_device WHERE id = ?")
        .get(token.device.id),
    ).toBeUndefined();
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(401);
  });

  it("expires device credentials after thirty days", async () => {
    const token = await device();
    f.advance(30 * 24 * 60 * 60_000);
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(401);
  });

  it("requires recent Google authentication for PIN reset and issues only a short scoped token", async () => {
    const grant = (await (
      await f.request("/v1/device/code", {
        method: "POST",
        data: {
          client_id: "streamer-ai-home",
          device_name: "Home server",
          purpose: "pin-reset",
          profile_name: "Kids",
        },
      })
    ).json()) as { device_code: string; user_code: string };
    const path = "/v1/device/verify?user_code=" + grant.user_code;
    expect(
      await (
        await f.request(path, {
          account: "a",
          authenticatedAt: f.now() - 300_001,
        })
      ).json(),
    ).toEqual({ error: "reauth_required" });
    expect(
      await (await f.request(path, { account: "a" })).json(),
    ).toMatchObject({ purpose: "pin-reset", profile_name: "Kids" });
    const approval = { user_code: grant.user_code, approve: true };
    expect(
      (
        await f.request("/v1/device/approve", {
          method: "POST",
          account: "a",
          authenticatedAt: f.now() - 300_001,
          data: approval,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request("/v1/device/approve", {
          method: "POST",
          account: "a",
          data: approval,
        })
      ).status,
    ).toBe(200);
    const token = (await (
      await f.request("/v1/device/token", {
        method: "POST",
        data: {
          client_id: "streamer-ai-home",
          device_code: grant.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      })
    ).json()) as { purpose: string; expires_in: number; access_token: string };
    expect(token.purpose).toBe("pin-reset");
    expect(token.expires_in).toBe(300);
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(200);
    expect(
      await (
        await f.request("/v1/sync/pull?after=0", { token: token.access_token })
      ).json(),
    ).toEqual({ error: "token_scope_forbidden" });
    f.advance(300_001);
    expect(
      (await f.request("/v1/account", { token: token.access_token })).status,
    ).toBe(401);
  });

  it("enforces poll intervals, five-minute grant expiry, denial and single-use redemption", async () => {
    const grant = (await (
      await f.request("/v1/device/code", {
        method: "POST",
        data: { client_id: "streamer-ai-home", device_name: "TV" },
      })
    ).json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete: string;
    };
    expect(grant.verification_uri_complete).not.toContain(grant.device_code);
    const poll = () =>
      f.request("/v1/device/token", {
        method: "POST",
        data: {
          client_id: "streamer-ai-home",
          device_code: grant.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
      });
    expect(await (await poll()).json()).toEqual({
      error: "authorization_pending",
    });
    expect(await (await poll()).json()).toEqual({ error: "slow_down" });
    await f.request("/v1/device/approve", {
      method: "POST",
      account: "a",
      data: { user_code: grant.user_code, approve: false },
    });
    f.advance(10_000);
    expect(await (await poll()).json()).toEqual({ error: "access_denied" });
    f.advance(300_000);
    expect(await (await poll()).json()).toEqual({ error: "expired_token" });
    const second = (await (
      await f.request("/v1/device/code", {
        method: "POST",
        data: { client_id: "streamer-ai-home", device_name: "TV 2" },
      })
    ).json()) as { device_code: string; user_code: string };
    await f.request("/v1/device/approve", {
      method: "POST",
      account: "a",
      data: { user_code: second.user_code, approve: true },
    });
    const secondBody = {
      client_id: "streamer-ai-home",
      device_code: second.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    };
    expect(
      (
        await f.request("/v1/device/token", {
          method: "POST",
          data: secondBody,
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await f.request("/v1/device/token", {
          method: "POST",
          data: secondBody,
        })
      ).json(),
    ).toEqual({ error: "invalid_grant" });
  });
});

describe("account synchronization", () => {
  it("isolates accounts, enforces five profiles and rolls back failed batches", async () => {
    expect((await push([profile()])).status).toBe(200);
    expect((await push([profile()], "b")).status).toBe(409);
    const other = (await (
      await f.request("/v1/sync/pull?after=0", { account: "b" })
    ).json()) as { operations: unknown[] };
    expect(other.operations).toHaveLength(0);
    expect(
      (await push([profile("p2"), profile("p3"), profile("p4"), profile("p5")]))
        .status,
    ).toBe(200);
    expect(await (await push([library(), profile("p6")])).json()).toEqual({
      error: "profile_limit",
    });
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM cloud_entity WHERE kind='library'")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("rejects secrets and AI text in safe payloads", async () => {
    const operation = profile();
    if (operation.kind !== "profile" || !operation.payload)
      throw new Error("bad fixture");
    const unsafe = {
      ...operation,
      payload: {
        ...operation.payload,
        prompt: "private AI prompt",
        token: "secret",
      },
    };
    const response = await f.request("/v1/sync/push", {
      method: "POST",
      account: "a",
      data: { operations: [unsafe] },
    });
    expect(response.status).toBe(400);
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM cloud_profile").get(),
    ).toEqual({ n: 0 });
  });

  it("applies deterministic LWW, acknowledges stale operations, and never resurrects deleted profiles", async () => {
    const original = profile();
    await push([original]);
    const stale = profile("profile-1", "2026-11-01T10:00:00.000Z");
    expect(await (await push([stale])).json()).toMatchObject({
      acceptedIds: [stale.id],
    });
    const pulled = (await (
      await f.request("/v1/sync/pull?after=0", { account: "a" })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(pulled.operations).toHaveLength(1);
    expect(pulled.operations[0]?.id).toBe(original.id);
    f.advance(1000);
    await push([{ ...profile(), action: "delete", payload: null }]);
    f.advance(1000);
    expect(await (await push([profile()])).json()).toEqual({
      error: "profile_deleted",
    });
  });

  it("keeps progress from the newest playback session despite delayed older-session updates", async () => {
    await push([profile()]);
    const make = (
      sessionStartedAt: string,
      updatedAt: string,
      positionSeconds: number,
    ): AccountSyncOperation => ({
      id: crypto.randomUUID(),
      profileId: "profile-1",
      entityId: title.id,
      kind: "progress",
      action: "upsert",
      updatedAt,
      payload: {
        title,
        seasonNumber: null,
        episodeNumber: null,
        positionSeconds,
        durationSeconds: 1000,
        progressPercent: positionSeconds / 10,
        sessionId: sessionStartedAt,
        sessionStartedAt,
      },
    });
    await push([
      make("2026-11-01T11:30:00.000Z", "2026-11-01T11:31:00.000Z", 100),
    ]);
    const newest = make(
      "2026-11-01T11:40:00.000Z",
      "2026-11-01T11:41:00.000Z",
      200,
    );
    await push([newest]);
    await push([
      make("2026-11-01T11:30:00.000Z", "2026-11-01T11:50:00.000Z", 900),
    ]);
    const state = await snapshot();
    expect(
      state.operations.find((operation) => operation.kind === "progress")?.id,
    ).toBe(newest.id);
  });

  it("keeps operation IDs immutable even for acknowledged stale no-ops", async () => {
    const original = profile();
    await push([original]);
    f.advance(1000);
    expect(
      await (
        await push([
          { ...original, updatedAt: new Date(f.now()).toISOString() },
        ])
      ).json(),
    ).toEqual({ error: "operation_id_conflict" });
    const stale = profile("profile-1", "2026-11-01T10:00:00.000Z");
    await push([stale]);
    expect((await push([stale])).status).toBe(200);
    expect(
      await (
        await push([{ ...stale, updatedAt: new Date(f.now()).toISOString() }])
      ).json(),
    ).toEqual({ error: "operation_id_conflict" });
  });

  it("paginates profile-first snapshots and resumes changes from its original watermark", async () => {
    await push([profile()]);
    for (let batch = 0; batch < 11; batch++) {
      const operations = Array.from({ length: 10 }, (_, index) => ({
        ...library(),
        entityId: `title-${batch * 10 + index}`,
      }));
      expect((await push(operations)).status).toBe(200);
    }
    const state = await snapshot();
    expect(state.operations).toHaveLength(111);
    expect(state.operations[0]?.kind).toBe("profile");
    f.advance(1000);
    const changed = library();
    await push([changed]);
    const newer = (await (
      await f.request("/v1/sync/pull?after=" + state.cursor, { account: "a" })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(newer.operations.map((operation) => operation.id)).toEqual([
      changed.id,
    ]);
  });
});

describe("profile transfer", () => {
  beforeEach(() => {
    f.sqlite
      .prepare('UPDATE "user" SET "emailVerified" = 1 WHERE id = ?')
      .run(accounts.b!.id);
  });
  it("requires the target browser owner and transfers all safe state while revoking source writes", async () => {
    await push([profile(), library()]);
    const transfer = (await (
      await f.request("/v1/transfers", {
        method: "POST",
        account: "a",
        data: { profileId: "profile-1", targetEmail: accounts.b?.email },
      })
    ).json()) as { id: string };
    expect(
      (
        await f.request(`/v1/transfers/${transfer.id}/accept`, {
          method: "POST",
          account: "c",
          data: {},
        })
      ).status,
    ).toBe(404);
    const accepted = await f.request(`/v1/transfers/${transfer.id}/accept`, {
      method: "POST",
      account: "b",
      data: {},
    });
    expect(await accepted.json()).toEqual({ ok: true, profileId: "profile-1" });
    const target = (await (
      await f.request("/v1/sync/pull?after=0", { account: "b" })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(target.operations.map((operation) => operation.kind).sort()).toEqual(
      ["library", "profile"],
    );
    const source = (await (
      await f.request("/v1/sync/pull?after=0", { account: "a" })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(source.operations).toHaveLength(1);
    expect(source.operations[0]).toMatchObject({
      kind: "profile",
      action: "delete",
      payload: null,
    });
    const oldSource = await push([profile()]);
    expect(await oldSource.json()).toEqual({ error: "profile_not_owned" });
    expect((await push([library()], "a")).status).toBe(409);
    expect(
      (
        await f.request(`/v1/transfers/${transfer.id}/accept`, {
          method: "POST",
          account: "b",
          data: {},
        })
      ).status,
    ).toBe(404);
  });

  it("enforces the target profile limit atomically and expires pending transfers", async () => {
    await push([profile()]);
    await push(
      [
        profile("b1"),
        profile("b2"),
        profile("b3"),
        profile("b4"),
        profile("b5"),
      ],
      "b",
    );
    const transfer = (await (
      await f.request("/v1/transfers", {
        method: "POST",
        account: "a",
        data: { profileId: "profile-1", targetEmail: accounts.b?.email },
      })
    ).json()) as { id: string };
    const result = await f.request(`/v1/transfers/${transfer.id}/accept`, {
      method: "POST",
      account: "b",
      data: {},
    });
    expect(await result.json()).toEqual({ error: "profile_limit" });
    expect(
      f.sqlite
        .prepare("SELECT account_id FROM cloud_profile WHERE id = 'profile-1'")
        .get(),
    ).toEqual({ account_id: accounts.a?.id });
    expect(
      f.sqlite
        .prepare("SELECT accepted_at FROM cloud_transfer WHERE id = ?")
        .get(transfer.id),
    ).toEqual({ accepted_at: null });
    f.advance(86_400_001);
    expect(
      (
        await f.request(`/v1/transfers/${transfer.id}/accept`, {
          method: "POST",
          account: "b",
          data: {},
        })
      ).status,
    ).toBe(404);
  });

  it("accepts a transfer by account UID only after explicit replacement and publishes the deletion", async () => {
    await push([profile(), library()]);
    await push(
      [
        profile("b1"),
        profile("b2"),
        profile("b3"),
        profile("b4"),
        profile("b5"),
        library("b1"),
      ],
      "b",
    );
    const before = await snapshot("b");
    const created = await f.request("/v1/transfers", {
      method: "POST",
      account: "a",
      data: { profileId: "profile-1", target: accounts.b!.id },
    });
    expect(created.status).toBe(201);
    const transfer = (await created.json()) as {
      id: string;
      expires_at: number;
      emailStatus: string;
    };
    expect(transfer.expires_at).toBe(f.now() + 86_400_000);
    expect(transfer.emailStatus).toBe("unavailable");

    const wrongProfile = await f.request(
      `/v1/transfers/${transfer.id}/accept`,
      {
        method: "POST",
        account: "b",
        data: { removeProfileIds: ["profile-1"] },
      },
    );
    expect(wrongProfile.status).toBe(409);
    expect(
      f.sqlite
        .prepare("SELECT active FROM cloud_profile WHERE id = 'b1'")
        .get(),
    ).toEqual({ active: 1 });

    const accepted = await f.request(`/v1/transfers/${transfer.id}/accept`, {
      method: "POST",
      account: "b",
      data: { removeProfileIds: ["b1"] },
    });
    expect(accepted.status).toBe(200);
    const delta = (await (
      await f.request(`/v1/sync/pull?after=${before.cursor}`, { account: "b" })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(delta.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          profileId: "b1",
          kind: "profile",
          action: "delete",
        }),
        expect.objectContaining({
          profileId: "profile-1",
          kind: "profile",
          action: "upsert",
        }),
        expect.objectContaining({
          profileId: "profile-1",
          kind: "library",
          action: "upsert",
        }),
      ]),
    );
    expect(
      f.sqlite
        .prepare("SELECT active FROM cloud_profile WHERE id = 'b1'")
        .get(),
    ).toEqual({ active: 0 });
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM cloud_entity WHERE profile_id = 'b1' AND kind <> 'profile'",
        )
        .get(),
    ).toEqual({ n: 0 });
  });

  it("requires recent owner authentication for initiating and accepting a transfer", async () => {
    await push([profile()]);
    const stale = f.now() - 300_001;
    const input = { profileId: "profile-1", target: accounts.b!.id };
    const create = await f.request("/v1/transfers", {
      method: "POST",
      account: "a",
      authenticatedAt: stale,
      data: input,
    });
    expect(await create.json()).toEqual({ error: "reauth_required" });
    const created = await f.request("/v1/transfers", {
      method: "POST",
      account: "a",
      data: input,
    });
    const transfer = (await created.json()) as { id: string };
    const accept = await f.request(`/v1/transfers/${transfer.id}/accept`, {
      method: "POST",
      account: "b",
      authenticatedAt: stale,
      data: {},
    });
    expect(await accept.json()).toEqual({ error: "reauth_required" });
    expect(
      f.sqlite
        .prepare("SELECT account_id FROM cloud_profile WHERE id = 'profile-1'")
        .get(),
    ).toEqual({ account_id: accounts.a!.id });
  });

  it("finds unverified recipient accounts only by UID", async () => {
    f.sqlite
      .prepare('UPDATE "user" SET "emailVerified" = 0 WHERE id = ?')
      .run(accounts.b!.id);
    await push([profile()]);
    const byEmail = await f.request("/v1/transfers", {
      method: "POST",
      account: "a",
      data: { profileId: "profile-1", target: accounts.b!.email },
    });
    expect(await byEmail.json()).toEqual({
      error: "target_account_unavailable",
    });
    const byUid = await f.request("/v1/transfers", {
      method: "POST",
      account: "a",
      data: { profileId: "profile-1", target: accounts.b!.id },
    });
    expect(byUid.status).toBe(201);
  });
});
