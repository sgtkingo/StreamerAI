import { afterEach, beforeEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ACCOUNT_SYNC_SCOPE,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";
import { accounts, fixture } from "./helpers.js";
import {
  deviceToken,
  householdBackup,
  profileOperation,
  registeredHousehold,
} from "./household-helpers.js";
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());
const push = (token: string, operations: unknown[]) =>
  f.request("/v1/sync/push", { method: "POST", token, data: { operations } });

async function migratedProfiles() {
  const legacy = await registeredHousehold(f);
  const profiles = [
    profileOperation(f, "Jirka"),
    profileOperation(f, "Test 2"),
  ];
  expect((await push(legacy.token, profiles)).status).toBe(200);
  f.sqlite
    .prepare(
      "UPDATE cloud_household SET name='Household',server_id='migrated',created_at=0,updated_at=0 WHERE id=?",
    )
    .run(legacy.householdId);
  f.sqlite
    .prepare("UPDATE cloud_device SET revoked_at=? WHERE id=?")
    .run(f.now(), legacy.deviceId);
  return { legacy, profiles };
}

it("reattaches the exact migrated profile namespace to the home server without replacing its identity or backup", async () => {
  const { legacy, profiles } = await migratedProfiles();
  const home = await registeredHousehold(f);
  const backup = householdBackup(f, home.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: home.token,
    data: { expectedRevision: 0, envelope: backup },
  });
  const before = f.sqlite
    .prepare(
      "SELECT * FROM cloud_household_sync_entity WHERE account_id=? ORDER BY profile_id",
    )
    .all(legacy.householdId) as { account_id: string }[];
  const register = () =>
    f.request("/v1/households", {
      method: "POST",
      token: home.token,
      data: {
        householdId: home.householdId,
        name: "Hnízdo",
        serverId: "home-server",
        profileIds: profiles.map((p) => p.profileId),
      },
    });
  expect((await register()).status).toBe(200);
  expect((await register()).status).toBe(200);
  expect(f.sqlite.prepare("SELECT id FROM cloud_household").all()).toEqual([
    { id: home.householdId },
  ]);
  expect(
    f.sqlite
      .prepare(
        "SELECT * FROM cloud_household_sync_entity WHERE account_id=? ORDER BY profile_id",
      )
      .all(home.householdId),
  ).toEqual(before.map((row) => ({ ...row, account_id: home.householdId })));
  expect(
    await (
      await f.request("/v1/sync/v2/checkpoint", { token: home.token })
    ).json(),
  ).toEqual({ revision: 1, envelope: backup });
  expect((await push(home.token, profiles)).status).toBe(200);
  expect(
    (await f.request("/v1/sync/snapshot", { token: home.token })).status,
  ).toBe(200);
});

it("refuses partial profile matches and real households before creating a duplicate", async () => {
  const { legacy, profiles } = await migratedProfiles();
  const credential = await deviceToken(f);
  const id = randomUUID();
  const register = (ids: string[]) =>
    f.request("/v1/households", {
      method: "POST",
      token: credential.token,
      data: {
        householdId: id,
        name: "Hnízdo",
        serverId: "server",
        profileIds: ids,
      },
    });
  expect((await register([profiles[0]!.profileId])).status).toBe(409);
  expect(
    f.sqlite.prepare("SELECT id FROM cloud_household WHERE id=?").get(id),
  ).toBeUndefined();
  f.sqlite
    .prepare("UPDATE cloud_household SET server_id='real-server' WHERE id=?")
    .run(legacy.householdId);
  expect((await register(profiles.map((p) => p.profileId))).status).toBe(409);
  expect(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_household_sync_profile WHERE account_id=?",
      )
      .get(legacy.householdId),
  ).toEqual({ count: 2 });
});

it("does not move another account's migrated profiles", async () => {
  const { legacy, profiles } = await migratedProfiles();
  const stranger = await deviceToken(f, "b");
  const response = await f.request("/v1/households", {
    method: "POST",
    token: stranger.token,
    data: {
      householdId: randomUUID(),
      name: "Other",
      serverId: "other",
      profileIds: profiles.map((p) => p.profileId),
    },
  });
  expect(response.status).toBe(409);
  expect(
    f.sqlite
      .prepare(
        "SELECT COUNT(*) AS count FROM cloud_household_sync_profile WHERE account_id=?",
      )
      .get(legacy.householdId),
  ).toEqual({ count: 2 });
});

it("establishes profile ownership before dependent rows in a mixed first upload", async () => {
  const server = await registeredHousehold(f),
    other = await registeredHousehold(f);
  const profile = profileOperation(f, "First upload");
  const feedback: AccountSyncOperation = {
    id: randomUUID(),
    profileId: ACCOUNT_SYNC_SCOPE,
    kind: "source-feedback",
    entityId: createHash("sha256")
      .update(
        JSON.stringify([
          profile.profileId,
          "sai:tmdb:movie:42",
          "webshare",
          "file-first",
          null,
          null,
        ]),
      )
      .digest("hex"),
    action: "upsert",
    updatedAt: profile.updatedAt,
    payload: {
      profileId: profile.profileId,
      titleId: "sai:tmdb:movie:42",
      providerId: "webshare",
      candidateId: "file-first",
      seasonNumber: null,
      episodeNumber: null,
      vote: "up",
    },
  };
  const result = await push(server.token, [feedback, profile]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    acceptedIds: [feedback.id, profile.id],
  });
  expect(
    (await push(other.token, [{ ...feedback, id: randomUUID() }])).status,
  ).toBe(409);
  const fresh = profileOperation(f, "Rolled back");
  expect(
    (await push(other.token, [{ ...feedback, id: randomUUID() }, fresh]))
      .status,
  ).toBe(409);
  expect(
    f.sqlite
      .prepare("SELECT id FROM cloud_household_sync_profile WHERE id=?")
      .get(fresh.profileId),
  ).toBeUndefined();
});

it("completes encrypted merges only from the approved target after its new backup and retains the source", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b"),
    other = await registeredHousehold(f, "b");
  await push(source.token, [profileOperation(f, "Source family")]);
  const original = householdBackup(f, source.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: { expectedRevision: 0, envelope: original },
  });
  const created = await f.request(
    "/v1/households/" + source.householdId + "/merge",
    {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    },
  );
  const { id } = (await created.json()) as { id: string };
  const path = "/v1/household-requests/" + id;
  expect(
    (await f.request(path + "/import", { token: target.token })).status,
  ).toBe(404);
  expect(
    (
      await f.request(path + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.request(path + "/import", { token: other.token })).status,
  ).toBe(404);
  expect(
    (await f.request(path + "/import", { token: source.token })).status,
  ).toBe(404);
  expect((await f.request(path + "/import", { account: "b" })).status).toBe(
    403,
  );
  expect(
    (
      await f.request("/v1/households/" + source.householdId + "/checkpoint", {
        token: target.token,
      })
    ).status,
  ).toBe(403);
  expect(
    await (await f.request(path + "/import", { token: target.token })).json(),
  ).toMatchObject({
    requestId: id,
    sourceRevision: 1,
    targetRevision: 0,
    currentTargetRevision: 0,
    envelope: original,
  });
  const requests = (await (
    await f.request("/v1/household-requests", { token: target.token })
  ).json()) as { requests: { id: string }[] };
  expect(requests.requests.map((r) => r.id)).toContain(id);
  expect(
    await (
      await f.request("/v1/household-requests", { token: other.token })
    ).json(),
  ).toEqual({ requests: [] });
  const complete = () =>
    f.request(path + "/complete", {
      method: "POST",
      token: target.token,
      data: { sourceRevision: 1, targetRevision: 1 },
    });
  expect((await complete()).status).toBe(409);
  const merged = householdBackup(f, target.householdId);
  expect(
    (
      await f.request("/v1/sync/v2/checkpoint", {
        method: "PUT",
        token: target.token,
        data: { expectedRevision: 0, envelope: merged },
      })
    ).status,
  ).toBe(200);
  expect((await complete()).status).toBe(200);
  expect(await (await complete()).json()).toMatchObject({
    ok: true,
    alreadyCompleted: true,
  });
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    401,
  );
  expect((await f.request("/v1/account", { token: target.token })).status).toBe(
    200,
  );
  expect(
    f.sqlite
      .prepare(
        "SELECT envelope_json FROM cloud_household_checkpoint WHERE household_id=?",
      )
      .get(source.householdId),
  ).toEqual({ envelope_json: JSON.stringify(original) });
  expect(
    await (
      await f.request("/v1/household-requests", { token: target.token })
    ).json(),
  ).toEqual({ requests: [] });
});

it("refuses encrypted merge completion when the source changes after approval", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  await push(source.token, [profileOperation(f, "Initial")]);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: {
      expectedRevision: 0,
      envelope: householdBackup(f, source.householdId),
    },
  });
  const { id } = (await (
    await f.request("/v1/households/" + source.householdId + "/merge", {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    })
  ).json()) as { id: string };
  await f.request("/v1/household-requests/" + id + "/decision", {
    method: "POST",
    account: "b",
    data: { approve: true },
  });
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: target.token,
    data: {
      expectedRevision: 0,
      envelope: householdBackup(f, target.householdId),
    },
  });
  await push(source.token, [profileOperation(f, "New after approval")]);
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/import", {
        token: target.token,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/complete", {
        method: "POST",
        token: target.token,
        data: { sourceRevision: 1, targetRevision: 1 },
      })
    ).status,
  ).toBe(409);
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    200,
  );
  const registry = f.sqlite
    .prepare("SELECT merged_into FROM cloud_household WHERE id=?")
    .get(source.householdId);
  expect(registry).toEqual({ merged_into: null });
});

it("requires the source backup for local merging and guards its revision", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: target.token,
    data: {
      expectedRevision: 0,
      envelope: householdBackup(f, target.householdId),
    },
  });
  async function approval() {
    const { id } = (await (
      await f.request("/v1/households/" + source.householdId + "/merge", {
        method: "POST",
        account: "a",
        data: { targetHouseholdId: target.householdId },
      })
    ).json()) as { id: string };
    await f.request("/v1/household-requests/" + id + "/decision", {
      method: "POST",
      account: "b",
      data: { approve: true },
    });
    return id;
  }
  const missing = await approval();
  expect(
    await (
      await f.request("/v1/household-requests/" + missing + "/import", {
        token: target.token,
      })
    ).json(),
  ).toEqual({ error: "source_backup_required" });
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: {
      expectedRevision: 0,
      envelope: householdBackup(f, source.householdId),
    },
  });
  const changed = await approval();
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: {
      expectedRevision: 1,
      envelope: householdBackup(f, source.householdId),
    },
  });
  expect(
    (
      await f.request("/v1/household-requests/" + changed + "/import", {
        token: target.token,
      })
    ).status,
  ).toBe(409);
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    200,
  );
});

it("renames only the bound household and refreshes server metadata without changing its backup", async () => {
  const source = await registeredHousehold(f),
    other = await registeredHousehold(f);
  const path = "/v1/households/" + source.householdId;
  const backup = householdBackup(f, source.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: { expectedRevision: 0, envelope: backup },
  });
  expect(
    (
      await f.request(path, {
        method: "PUT",
        token: other.token,
        data: { name: "Wrong" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(path, {
        method: "PUT",
        account: "a",
        data: { name: "Browser" },
      })
    ).status,
  ).toBe(403);
  expect(
    await (
      await f.request(path, {
        method: "PUT",
        token: source.token,
        data: { name: "Living room" },
      })
    ).json(),
  ).toMatchObject({
    household: { name: "Living room", hasBackup: true, revision: 1 },
  });
  const replacement = await deviceToken(f);
  const response = await f.request("/v1/households", {
    method: "POST",
    token: replacement.token,
    data: {
      householdId: source.householdId,
      name: "Living room",
      serverId: "replacement-server",
    },
  });
  expect(await response.json()).toMatchObject({
    household: {
      id: source.householdId,
      serverId: "replacement-server",
      hasBackup: true,
      revision: 1,
    },
  });
  expect(
    await (
      await f.request("/v1/sync/v2/checkpoint", { token: replacement.token })
    ).json(),
  ).toEqual({ revision: 1, envelope: backup });
});

it("binds owner-approved server grants to the requested household and refuses another account", async () => {
  const server = await registeredHousehold(f);
  const grant = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: {
        client_id: "streamer-ai-home",
        device_name: "New server",
        household_id: server.householdId,
        household_name: "Family",
        server_id: "server-new",
      },
    })
  ).json()) as { device_code: string; user_code: string };
  expect(
    (
      await f.request("/v1/device/verify?user_code=" + grant.user_code, {
        account: "b",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/device/approve", {
        method: "POST",
        account: "b",
        data: { user_code: grant.user_code, approve: true },
      })
    ).status,
  ).toBe(403);
  expect(
    await (
      await f.request("/v1/device/verify?user_code=" + grant.user_code, {
        account: "a",
      })
    ).json(),
  ).toMatchObject({
    household_id: server.householdId,
    household_name: "Family",
    server_id: "server-new",
  });
  expect(
    (
      await f.request("/v1/device/approve", {
        method: "POST",
        account: "a",
        data: { user_code: grant.user_code, approve: true },
      })
    ).status,
  ).toBe(200);
  const redeemed = (await (
    await f.request("/v1/device/token", {
      method: "POST",
      data: {
        client_id: "streamer-ai-home",
        device_code: grant.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      },
    })
  ).json()) as { access_token: string; household_id: string };
  expect(redeemed.household_id).toBe(server.householdId);
  expect(
    (await f.request("/v1/sync/snapshot", { token: redeemed.access_token }))
      .status,
  ).toBe(200);
});

it("preserves library and feedback on repeated profile moves and emits new target operations", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  const profile = profileOperation(f, "Moving family");
  const library: AccountSyncOperation = {
    id: randomUUID(),
    profileId: profile.profileId,
    entityId: "tmdb:movie:1",
    kind: "library",
    action: "upsert",
    updatedAt: profile.updatedAt,
    payload: {
      title: {
        id: "tmdb:movie:1",
        kind: "movie",
        title: "Favorite",
        originalTitle: null,
        year: 2020,
        synopsis: "Saved",
        genres: [],
        metadataProvider: "tmdb",
        metadataValidatedAt: profile.updatedAt,
      },
      membershipReason: "explicit",
      state: "saved",
      progressPercent: null,
      lastPlayedAt: null,
    },
  };
  const feedback: AccountSyncOperation = {
    id: randomUUID(),
    profileId: ACCOUNT_SYNC_SCOPE,
    kind: "source-feedback",
    entityId: createHash("sha256")
      .update(
        JSON.stringify([
          profile.profileId,
          "sai:tmdb:movie:42",
          "webshare",
          "file-1",
          null,
          null,
        ]),
      )
      .digest("hex"),
    action: "upsert",
    updatedAt: profile.updatedAt,
    payload: {
      profileId: profile.profileId,
      titleId: "sai:tmdb:movie:42",
      providerId: "webshare",
      candidateId: "file-1",
      seasonNumber: null,
      episodeNumber: null,
      vote: "up",
    },
  };
  expect((await push(source.token, [profile, library, feedback])).status).toBe(
    200,
  );
  async function move(
    from: typeof source,
    to: typeof target,
    fromAccount: string,
    toAccount: string,
  ) {
    const created = await f.request(
      "/v1/households/" + from.householdId + "/profile-transfers",
      {
        method: "POST",
        account: fromAccount,
        data: {
          profileId: profile.profileId,
          targetHouseholdId: to.householdId,
        },
      },
    );
    const { id } = (await created.json()) as { id: string };
    const approved = await f.request(
      "/v1/household-requests/" + id + "/decision",
      { method: "POST", account: toAccount, data: { approve: true } },
    );
    expect(approved.status).toBe(200);
    const pull = (await (
      await f.request("/v1/sync/pull?after=0", { token: to.token })
    ).json()) as { operations: AccountSyncOperation[] };
    expect(
      pull.operations.some(
        (o) => o.kind === "library" && o.action === "upsert",
      ),
    ).toBe(true);
    expect(
      pull.operations.some(
        (o) => o.kind === "source-feedback" && o.action === "upsert",
      ),
    ).toBe(true);
    const row = f.sqlite
      .prepare(
        "SELECT operation_json FROM cloud_household_sync_account_entity WHERE account_id=? AND entity_id=?",
      )
      .get(to.householdId, feedback.entityId) as { operation_json: string };
    expect(JSON.parse(row.operation_json)).toMatchObject({
      action: "upsert",
      payload: feedback.payload,
    });
    return pull.operations
      .filter((o) => o.kind === "profile" && o.action === "upsert")
      .at(-1)!;
  }
  const first = await move(source, target, "a", "b");
  const second = await move(target, source, "b", "a");
  expect(second.id).not.toBe(first.id);
  expect(Date.parse(second.updatedAt)).toBeGreaterThan(
    Date.parse(first.updatedAt),
  );
});

it("immediately transfers a profile between households of the same owner", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "a");
  const profile = profileOperation(f, "Family");
  await push(source.token, [profile]);
  const response = await f.request(
    `/v1/households/${source.householdId}/profile-transfers`,
    {
      method: "POST",
      account: "a",
      data: {
        profileId: profile.profileId,
        targetHouseholdId: target.householdId,
      },
    },
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    ok: true,
    sourceHouseholdId: source.householdId,
    targetHouseholdId: target.householdId,
  });
  expect(
    (await (
      await f.request(`/v1/households/${target.householdId}/profiles`, {
        account: "a",
      })
    ).json()) as { profiles: unknown[] },
  ).toMatchObject({ profiles: [{ id: profile.profileId, name: "Family" }] });
  expect(
    await (await f.request("/v1/household-requests", { account: "a" })).json(),
  ).toEqual({ requests: [] });
});

it("immediately merges sync-only households of the same owner", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "a");
  await push(source.token, [profileOperation(f, "Source")]);
  const response = await f.request(
    `/v1/households/${source.householdId}/merge`,
    {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    },
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    ok: true,
    sourceHouseholdId: source.householdId,
    targetHouseholdId: target.householdId,
  });
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    401,
  );
  expect(
    await (await f.request("/v1/household-requests", { account: "a" })).json(),
  ).toEqual({ requests: [] });
});

it("prepares encrypted merges of the same owner for local completion without separate approval", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "a");
  await push(source.token, [profileOperation(f, "Source")]);
  const backup = householdBackup(f, source.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: { expectedRevision: 0, envelope: backup },
  });
  const response = await f.request(
    `/v1/households/${source.householdId}/merge`,
    {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    },
  );
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    id: string;
    requiresLocalImport: boolean;
  };
  expect(result.requiresLocalImport).toBe(true);
  expect(
    (
      await f.request(`/v1/household-requests/${result.id}/decision`, {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
  expect(
    await (
      await f.request(`/v1/household-requests/${result.id}/import`, {
        token: target.token,
      })
    ).json(),
  ).toMatchObject({ requestId: result.id, envelope: backup });
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    200,
  );
});

it("merges sync-only households after explicit approval and preserves account deletion", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  await push(source.token, [profileOperation(f, "Source")]);
  await push(target.token, [profileOperation(f, "Target")]);
  const created = await f.request(
    "/v1/households/" + source.householdId + "/merge",
    {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    },
  );
  const { id } = (await created.json()) as { id: string };
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    401,
  );
  const synced = JSON.stringify(
    await (
      await f.request("/v1/sync/pull?after=0", { token: target.token })
    ).json(),
  );
  expect(synced).toContain("Source");
  expect(synced).toContain("Target");
  const owner = (await (
    await f.request("/v1/households/" + source.householdId, { account: "a" })
  ).json()) as { household: { mergedInto: string } };
  expect(owner.household.mergedInto).toBe(target.householdId);
  expect(
    (await f.request("/v1/account", { method: "DELETE", account: "b" })).status,
  ).toBe(200);
  expect(
    (await f.request("/v1/households/" + source.householdId, { account: "a" }))
      .status,
  ).toBe(200);
});

it("owns multiple households without storing or replacing a PIN and binds each server token to one", async () => {
  const first = await registeredHousehold(f, "a"),
    second = await registeredHousehold(f, "a"),
    other = await registeredHousehold(f, "b");
  const all = (await (
    await f.request("/v1/households", { account: "a" })
  ).json()) as { households: { id: string }[] };
  expect(all.households.map((h) => h.id).sort()).toEqual(
    [first.householdId, second.householdId].sort(),
  );
  expect(
    (await f.request("/v1/households/" + other.householdId, { account: "a" }))
      .status,
  ).toBe(404);
  expect(
    (
      await f.request("/v1/households/" + second.householdId, {
        token: first.token,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/households/" + second.householdId + "/checkpoint", {
        token: first.token,
      })
    ).status,
  ).toBe(403);
  const scoped = (await (
    await f.request("/v1/account", { token: first.token })
  ).json()) as { id: string; householdId: string };
  expect(scoped).toMatchObject({
    id: accounts.a!.id,
    householdId: first.householdId,
  });
  const unbound = await deviceToken(f, "a");
  expect(
    (await f.request("/v1/sync/snapshot", { token: unbound.token })).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/households", {
        method: "POST",
        token: unbound.token,
        data: {
          householdId: other.householdId,
          name: "Stolen",
          serverId: "server",
        },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.request("/v1/households", {
        method: "POST",
        token: first.token,
        data: {
          householdId: second.householdId,
          name: "Switch",
          serverId: "server",
        },
      })
    ).status,
  ).toBe(403);
  const before = f.sqlite
    .prepare("SELECT verifier_json FROM cloud_master_pin WHERE account_id=?")
    .get(accounts.a!.id);
  expect(
    (
      await f.request("/v1/households", {
        method: "POST",
        token: first.token,
        data: {
          householdId: first.householdId,
          name: "Same",
          serverId: "server",
        },
      })
    ).status,
  ).toBe(200);
  expect(
    f.sqlite
      .prepare("SELECT verifier_json FROM cloud_master_pin WHERE account_id=?")
      .get(accounts.a!.id),
  ).toEqual(before);
});

it("isolates sync profiles, cursors, backups and the five-profile cap for households of one account", async () => {
  const first = await registeredHousehold(f),
    second = await registeredHousehold(f);
  const one = profileOperation(f, "Private first"),
    two = profileOperation(f, "Private second");
  expect((await push(first.token, [one])).status).toBe(200);
  expect((await push(second.token, [two])).status).toBe(200);
  const left = (await (
    await f.request("/v1/sync/pull?after=0", { token: first.token })
  ).json()) as { operations: unknown[] };
  expect(JSON.stringify(left)).toContain("Private first");
  expect(JSON.stringify(left)).not.toContain("Private second");
  const selected = await (
    await f.request(
      "/v1/sync/pull?after=0&household_id=" + second.householdId,
      { account: "a" },
    )
  ).json();
  expect(JSON.stringify(selected)).toContain("Private second");
  expect(JSON.stringify(selected)).not.toContain("Private first");
  expect(
    (
      await f.request("/v1/sync/pull?household_id=" + second.householdId, {
        token: first.token,
      })
    ).status,
  ).toBe(403);
  expect((await push(first.token, [{ ...two, id: randomUUID() }])).status).toBe(
    409,
  );
  expect(
    (
      await push(
        first.token,
        Array.from({ length: 4 }, (_, i) => profileOperation(f, "A" + i)),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await push(
        second.token,
        Array.from({ length: 4 }, (_, i) => profileOperation(f, "B" + i)),
      )
    ).status,
  ).toBe(200);
  expect((await push(first.token, [profileOperation(f, "sixth")])).status).toBe(
    409,
  );
  expect(
    (
      await f.request("/v1/sync/v2/checkpoint", {
        method: "PUT",
        token: first.token,
        data: {
          expectedRevision: 0,
          envelope: householdBackup(f, first.householdId),
        },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await f.request("/v1/sync/v2/checkpoint", { token: second.token })
    ).json(),
  ).toEqual({ revision: 0, envelope: null });
  expect(
    (
      await f.request("/v1/sync/v2/checkpoint", {
        method: "PUT",
        token: first.token,
        data: {
          expectedRevision: 1,
          envelope: householdBackup(f, second.householdId),
        },
      })
    ).status,
  ).toBe(409);
});

it("revokes a detached server credential while keeping its household and backup", async () => {
  const server = await registeredHousehold(f);
  const backup = householdBackup(f, server.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: server.token,
    data: { expectedRevision: 0, envelope: backup },
  });
  const result = await f.request(
    "/v1/households/" + server.householdId + "/connection",
    { method: "DELETE", token: server.token },
  );
  expect(result.status).toBe(200);
  expect((await f.request("/v1/account", { token: server.token })).status).toBe(
    401,
  );
  const state = (await (
    await f.request("/v1/households/" + server.householdId, { account: "a" })
  ).json()) as { household: { hasBackup: boolean } };
  expect(state.household.hasBackup).toBe(true);
  expect(
    f.sqlite
      .prepare(
        "SELECT envelope_json FROM cloud_household_checkpoint WHERE household_id=?",
      )
      .get(server.householdId),
  ).toEqual({ envelope_json: JSON.stringify(backup) });
});

it("requires fresh browser authentication and reports the server connection state", async () => {
  const server = await registeredHousehold(f);
  const path = "/v1/households/" + server.householdId + "/connection";
  const stale = await f.request(path, {
    method: "DELETE",
    account: "a",
    authenticatedAt: f.now() - 300_001,
  });
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ error: "reauth_required" });
  const list = async () =>
    (await (await f.request("/v1/households", { account: "a" })).json()) as {
      households: { id: string; serverConnected: boolean }[];
    };
  expect(
    (await list()).households.find((h) => h.id === server.householdId)
      ?.serverConnected,
  ).toBe(true);
  expect(
    (await f.request(path, { method: "DELETE", account: "a" })).status,
  ).toBe(200);
  expect(
    (await list()).households.find((h) => h.id === server.householdId)
      ?.serverConnected,
  ).toBe(false);
  expect((await f.request("/v1/account", { token: server.token })).status).toBe(
    401,
  );
});

it("deletes only the owner's cloud household, revoking its server and removing cloud data", async () => {
  const source = await registeredHousehold(f);
  const other = await registeredHousehold(f);
  await push(source.token, [profileOperation(f, "Family")]);
  const backup = householdBackup(f, source.householdId);
  expect(
    (
      await f.request("/v1/sync/v2/checkpoint", {
        method: "PUT",
        token: source.token,
        data: { expectedRevision: 0, envelope: backup },
      })
    ).status,
  ).toBe(200);
  const path = "/v1/households/" + source.householdId;
  expect(
    (await f.request(path, { method: "DELETE", token: source.token })).status,
  ).toBe(403);
  expect(
    (
      await f.request(path, {
        method: "DELETE",
        account: "a",
        authenticatedAt: f.now() - 300_001,
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request(path, { method: "DELETE", account: "b" })).status,
  ).toBe(404);
  expect(
    (
      await f.request(path, {
        method: "DELETE",
        account: "a",
        origin: "https://other.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (await f.request(path, { method: "DELETE", account: "a" })).status,
  ).toBe(200);
  expect((await f.request(path, { account: "a" })).status).toBe(404);
  expect(
    (await f.request("/v1/households/" + other.householdId, { account: "a" }))
      .status,
  ).toBe(200);
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    401,
  );
  expect(
    f.sqlite
      .prepare("SELECT 1 FROM cloud_household_checkpoint WHERE household_id=?")
      .get(source.householdId),
  ).toBeUndefined();
  expect(
    f.sqlite
      .prepare("SELECT 1 FROM cloud_household_sync_profile WHERE account_id=?")
      .get(source.householdId),
  ).toBeUndefined();
});

it("does not resurrect merged households when their target is deleted", async () => {
  const source = await registeredHousehold(f);
  const target = await registeredHousehold(f);
  f.sqlite
    .prepare("UPDATE cloud_household SET merged_into=? WHERE id=?")
    .run(target.householdId, source.householdId);
  const path = "/v1/households/" + target.householdId;
  const blocked = await f.request(path, { method: "DELETE", account: "a" });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toEqual({
    error: "household_has_merged_sources",
  });
  expect((await f.request("/v1/account", { token: target.token })).status).toBe(
    200,
  );
  expect(
    (
      await f.request("/v1/households/" + source.householdId, {
        method: "DELETE",
        account: "a",
      })
    ).status,
  ).toBe(200);
  expect(
    (await f.request(path, { method: "DELETE", account: "a" })).status,
  ).toBe(200);
});

it("transfers household ownership only after the target owner approves and revokes the previous owner's tokens", async () => {
  const server = await registeredHousehold(f);
  await push(server.token, [profileOperation(f, "Family")]);
  const requested = await f.request(
    "/v1/households/" + server.householdId + "/ownership-transfer",
    { method: "POST", account: "a", data: { targetAccountId: accounts.b!.id } },
  );
  expect(requested.status).toBe(201);
  const { id } = (await requested.json()) as { id: string };
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/decision", {
        method: "POST",
        account: "a",
        data: { approve: true },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/decision", {
        method: "POST",
        account: "b",
        authenticatedAt: f.now() - 300_001,
        data: { approve: true },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  expect((await f.request("/v1/account", { token: server.token })).status).toBe(
    401,
  );
  expect(
    (await f.request("/v1/households/" + server.householdId, { account: "a" }))
      .status,
  ).toBe(404);
  const next = await registeredHousehold(f, "b", server.householdId);
  const data = await (
    await f.request("/v1/sync/pull?after=0", { token: next.token })
  ).json();
  expect(JSON.stringify(data)).toContain("Family");
});

it("moves a profile between authorized households with source tombstones and rejects stale approval", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  const profile = profileOperation(f, "Moved");
  await push(source.token, [profile]);
  const create = async () => {
    const result = await f.request(
      "/v1/households/" + source.householdId + "/profile-transfers",
      {
        method: "POST",
        account: "a",
        data: {
          profileId: profile.profileId,
          targetHouseholdId: target.householdId,
        },
      },
    );
    expect(result.status).toBe(201);
    return ((await result.json()) as { id: string }).id;
  };
  const stale = await create();
  await push(source.token, [profileOperation(f, "Later")]);
  expect(
    (
      await f.request("/v1/household-requests/" + stale + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(409);
  const id = await create();
  expect(
    (
      await f.request("/v1/household-requests/" + id + "/decision", {
        method: "POST",
        account: "b",
        data: { approve: true },
      })
    ).status,
  ).toBe(200);
  const from = (await (
    await f.request("/v1/sync/pull?after=0", { token: source.token })
  ).json()) as { operations: { profileId: string; action: string }[] };
  const into = (await (
    await f.request("/v1/sync/pull?after=0", { token: target.token })
  ).json()) as { operations: { profileId: string; action: string }[] };
  expect(
    from.operations.some(
      (o) => o.profileId === profile.profileId && o.action === "delete",
    ),
  ).toBe(true);
  expect(
    into.operations.some(
      (o) => o.profileId === profile.profileId && o.action === "upsert",
    ),
  ).toBe(true);
  expect(
    (await push(source.token, [{ ...profile, id: randomUUID() }])).status,
  ).toBe(409);
});

it("does not silently merge opaque backups after approval", async () => {
  const source = await registeredHousehold(f, "a"),
    target = await registeredHousehold(f, "b");
  await push(source.token, [profileOperation(f, "Keep me")]);
  const backup = householdBackup(f, source.householdId);
  await f.request("/v1/sync/v2/checkpoint", {
    method: "PUT",
    token: source.token,
    data: { expectedRevision: 0, envelope: backup },
  });
  const created = await f.request(
    "/v1/households/" + source.householdId + "/merge",
    {
      method: "POST",
      account: "a",
      data: { targetHouseholdId: target.householdId },
    },
  );
  const { id } = (await created.json()) as { id: string };
  const approved = await f.request(
    "/v1/household-requests/" + id + "/decision",
    { method: "POST", account: "b", data: { approve: true } },
  );
  expect(await approved.json()).toMatchObject({
    ok: true,
    requiresLocalImport: true,
  });
  expect(
    await (
      await f.request("/v1/sync/v2/checkpoint", { token: source.token })
    ).json(),
  ).toEqual({ revision: 1, envelope: backup });
  expect((await f.request("/v1/account", { token: source.token })).status).toBe(
    200,
  );
});

it("copies earlier account data into an isolated household without changing archived PIN records", async () => {
  f.close();
  f = fixture({ households: false });
  const id = randomUUID();
  f.sqlite
    .prepare(
      "INSERT INTO cloud_encrypted_checkpoint(account_id,revision,dataset_id,envelope_json,updated_at) VALUES(?,2,?,'{}',?)",
    )
    .run(accounts.a!.id, id, f.now());
  const archived = f.sqlite
    .prepare("SELECT * FROM cloud_master_pin ORDER BY account_id")
    .all();
  f.sqlite.exec(
    readFileSync(
      new URL("../migrations/0011_households.sql", import.meta.url),
      "utf8",
    ),
  );
  const state = (await (
    await f.request("/v1/households/" + id, { account: "a" })
  ).json()) as { household: { id: string; hasBackup: boolean } };
  expect(state.household).toMatchObject({ id, hasBackup: true });
  expect(
    f.sqlite
      .prepare("SELECT * FROM cloud_master_pin ORDER BY account_id")
      .all(),
  ).toEqual(archived);
});
