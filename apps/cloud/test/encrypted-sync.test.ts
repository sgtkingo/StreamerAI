import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  type EncryptedHouseholdEnvelope,
  type MasterPinHouseholdBackup,
} from "@streamer-ai/contracts";
import { fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});
const path = "/v1/sync/v2/checkpoint";
let householdId: string;
function envelope(): MasterPinHouseholdBackup {
  const cipher = {
    algorithm: "aes-256-gcm" as const,
    nonce: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const inner: EncryptedHouseholdEnvelope = {
    format: "streamerai-encrypted-household",
    version: 1,
    datasetId: householdId,
    keyVersion: 1,
    recoveryVersion: 1,
    snapshotId: crypto.randomUUID(),
    sequence: 1,
    createdAt: new Date(f.now()).toISOString(),
    recovery: { ...cipher },
    payload: { ...cipher },
  };
  return {
    format: "streamerai-master-pin-household",
    version: 1,
    kdf: {
      algorithm: "argon2id",
      memory: 65_536,
      passes: 3,
      parallelism: 1,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
    },
    cloudRecovery: { ...cipher },
    envelope: inner,
  };
}
async function token(account = "a"): Promise<string> {
  const grant = (await (
    await f.request("/v1/device/code", {
      method: "POST",
      data: { client_id: "streamer-ai-home", device_name: "Home" },
    })
  ).json()) as { device_code: string; user_code: string };
  expect(
    (
      await f.request("/v1/device/approve", {
        method: "POST",
        account,
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
  ).json()) as { access_token: string };
  householdId = crypto.randomUUID();
  expect(
    (
      await f.request("/v1/households", {
        method: "POST",
        token: redeemed.access_token,
        data: { householdId, name: "Home", serverId: crypto.randomUUID() },
      })
    ).status,
  ).toBe(200);
  return redeemed.access_token;
}

describe("opaque encrypted recovery checkpoints", () => {
  it("binds checkpoints to one household identity and does not claim a failed write", async () => {
    const server = await token();
    const first = envelope();
    const write = (
      expectedRevision: number,
      backup: MasterPinHouseholdBackup,
    ) =>
      f.request(path, {
        method: "PUT",
        token: server,
        data: { expectedRevision, envelope: backup },
      });
    expect((await write(2, first)).status).toBe(409);
    expect(
      await (
        await f.request("/v1/households/" + householdId, { token: server })
      ).json(),
    ).toMatchObject({
      household: { id: householdId, hasBackup: false, revision: 0 },
    });
    expect((await write(0, first)).status).toBe(200);
    expect(
      await (
        await f.request("/v1/households/" + householdId, { token: server })
      ).json(),
    ).toMatchObject({
      household: { id: first.envelope.datasetId, hasBackup: true, revision: 1 },
    });
    const other = envelope();
    other.envelope.datasetId = crypto.randomUUID();
    expect((await write(1, other)).status).toBe(409);
    expect((await write(1, first)).status).toBe(200);
  });
  it("isolates households, authenticates writers and retains revision tombstones", async () => {
    const server = await token();
    expect((await f.request(path)).status).toBe(401);
    expect(await (await f.request(path, { token: server })).json()).toEqual({
      revision: 0,
      envelope: null,
    });
    const encrypted = envelope();
    expect(
      (
        await f.request(path, {
          method: "PUT",
          account: "a",
          data: { expectedRevision: 0, envelope: encrypted },
        })
      ).status,
    ).toBe(403);
    const write = (expectedRevision: number) =>
      f.request(path, {
        method: "PUT",
        token: server,
        data: { expectedRevision, envelope: encrypted },
      });
    expect(await (await write(0)).json()).toEqual({ revision: 1 });
    expect((await write(0)).status).toBe(409);
    expect(await (await f.request(path, { token: server })).json()).toEqual({
      revision: 1,
      envelope: encrypted,
    });
    expect(await (await f.request(path, { account: "b" })).json()).toEqual({
      revision: 0,
      envelope: null,
    });
    expect(await (await write(1)).json()).toEqual({ revision: 2 });
    expect(
      (
        await f.request(path, {
          method: "DELETE",
          token: server,
          data: { expectedRevision: 1, confirm: "delete-encrypted-checkpoint" },
        })
      ).status,
    ).toBe(409);
    expect(
      await (
        await f.request(path, {
          method: "DELETE",
          token: server,
          data: { expectedRevision: 2, confirm: "delete-encrypted-checkpoint" },
        })
      ).json(),
    ).toEqual({ revision: 3, envelope: null });
    expect(await (await f.request(path, { token: server })).json()).toEqual({
      revision: 3,
      envelope: null,
    });
    expect((await write(0)).status).toBe(409);
    expect((await write(2)).status).toBe(409);
    expect(await (await write(3)).json()).toEqual({ revision: 4 });
  });

  it("rejects plaintext backup fields and oversize bodies while keeping account synchronization available", async () => {
    const server = await token();
    const encrypted = envelope();
    const invalid = await f.request(path, {
      method: "PUT",
      token: server,
      data: {
        expectedRevision: 0,
        envelope: { ...encrypted, credentials: "DO-NOT-STORE" },
      },
    });
    expect(invalid.status).toBe(400);
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM cloud_household_checkpoint")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      (
        await f.request(path, {
          method: "PUT",
          token: server,
          data: {
            expectedRevision: 0,
            envelope: {
              ...encrypted,
              envelope: {
                ...encrypted.envelope,
                payload: {
                  ...encrypted.envelope.payload,
                  ciphertext: "A".repeat(1_801_000),
                },
              },
            },
          },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await f.request(path, {
          method: "PUT",
          token: server,
          data: { expectedRevision: 0, envelope: encrypted },
        })
      ).status,
    ).toBe(200);
    const { audioOutputDeviceId: _device, ...playback } =
      DEFAULT_PLAYBACK_PREFERENCES;
    const sync = () =>
      f.request("/v1/sync/push", {
        method: "POST",
        token: server,
        data: {
          operations: [
            {
              id: crypto.randomUUID(),
              profileId: "viewer",
              entityId: "viewer",
              kind: "profile",
              action: "upsert",
              updatedAt: new Date(f.now()).toISOString(),
              payload: {
                name: "Viewer",
                locale: "en",
                genres: [],
                playback,
                appearance: DEFAULT_APPEARANCE_PREFERENCES,
                onboardingComplete: true,
              },
            },
          ],
        },
      });
    expect((await sync()).status).toBe(200);
    await f.request(path, {
      method: "DELETE",
      token: server,
      data: { expectedRevision: 1, confirm: "delete-encrypted-checkpoint" },
    });
    expect((await sync()).status).toBe(200);
    const stored = JSON.stringify(
      f.sqlite.prepare("SELECT * FROM cloud_household_checkpoint").all(),
    );
    expect(stored).not.toContain("DO-NOT-STORE");
  });

  it("cascades opaque checkpoints on explicit account deletion", async () => {
    const server = await token();
    await f.request(path, {
      method: "PUT",
      token: server,
      data: { expectedRevision: 0, envelope: envelope() },
    });
    expect(
      (await f.request("/v1/account", { method: "DELETE", account: "a" }))
        .status,
    ).toBe(200);
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM cloud_household_checkpoint")
        .get(),
    ).toEqual({ n: 0 });
    expect((await f.request(path, { token: server })).status).toBe(401);
  });

  it("refuses legacy account merges instead of discarding encrypted ownership", async () => {
    const server = await token();
    await f.request(path, {
      method: "PUT",
      token: server,
      data: { expectedRevision: 0, envelope: envelope() },
    });
    const result = await f.request("/v1/merges", {
      method: "POST",
      account: "a",
      data: { target: "account-b" },
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      error: "encrypted_household_merge_requires_export",
    });
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM cloud_account_merge").get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite
        .prepare("SELECT count(*) AS n FROM cloud_household_checkpoint")
        .get(),
    ).toEqual({ n: 1 });
  });
});
