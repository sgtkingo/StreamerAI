import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
} from "@streamer-ai/contracts";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import type { FastifyInstance } from "fastify";
import { createApp } from "../src/app.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { remoteApiSecretKey } from "../src/integrations/remote-api-agent.js";
import { readRuntimeConfig } from "../src/runtime-config.js";

const apps: FastifyInstance[] = [];
const databases: StreamerDatabase[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const db of databases.splice(0)) db.close();
});
const cookie = (response: { headers: Record<string, unknown> }) =>
  String(response.headers["set-cookie"]).split(";")[0]!;

function local() {
  const database = openStreamerDatabase({ filename: ":memory:" });
  databases.push(database);
  const app = createApp({ environment: "test", logger: false, database });
  apps.push(app);
  return { app, database };
}
function cloud() {
  let identity = "owner-one";
  let purpose = "login";
  let pending = false;
  let now = Date.now();
  const tokens = new Map<string, string>();
  const pushes: {
    owner: string | undefined;
    operations: { kind: string; payload: unknown }[];
  }[] = [];
  const database = openStreamerDatabase({
    filename: ":memory:",
    clock: () => new Date(now),
  });
  databases.push(database);
  const secrets = new NonPersistentMemorySecretStore();
  let revoked = false;
  let deleted = false;
  let deletionStatusAvailable = true;
  let connectionsAvailable = true;
  let cloudAvailable = true;
  let ackAvailable = true;
  let omitMergeFlag = false;
  const aliases = new Map<string, string>();
  const pendingAcks = new Set<string>();
  const syncRequests: string[] = [];
  const acknowledgements: string[] = [];
  let tombstonePages: unknown[][] = [[]];
  let snapshotOperations: unknown[] = [];
  let tombstoneOwner: string | null = null;
  const tombstoneRequests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!cloudAvailable) throw new Error("Cloud offline");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const token =
      new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ??
      "";
    if (path === "/v1/device/code") {
      purpose = String(body.purpose ?? "login");
      return Response.json({
        device_code: `code-${identity}-${now}`,
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.example/device",
        verification_uri_complete:
          "https://accounts.example/device?user_code=ABCD-EFGH",
        expires_in: 300,
        interval: 3,
      });
    }
    if (path === "/v1/device/token") {
      if (pending)
        return Response.json(
          { error: "authorization_pending" },
          { status: 400 },
        );
      const accessToken = `cloud-private-token-${identity}-${now}`;
      tokens.set(accessToken, identity);
      return Response.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: purpose === "pin-reset" ? 300 : 2_592_000,
        purpose,
        account: {
          id: identity,
          email: `${identity}@example.com`,
          name: identity,
        },
        device: { id: `device-${identity}-${now}`, name: "Browser" },
      });
    }
    if (path === "/v1/account")
      return revoked || (deleted && tokens.get(token) === "owner-one")
        ? Response.json({ error: "revoked" }, { status: 401 })
        : Response.json({
            id: tokens.get(token),
            email: `${tokens.get(token)}@example.com`,
            name: tokens.get(token),
            ...(omitMergeFlag
              ? {}
              : { mergeAckRequired: pendingAcks.has(token) }),
          });
    if (path.startsWith("/v1/account/merged-from/")) {
      const old = decodeURIComponent(
        path.slice("/v1/account/merged-from/".length),
      );
      return aliases.get(old) === tokens.get(token)
        ? Response.json({ merged: true })
        : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (path === "/v1/account/merge-tombstones") {
      const after = new URL(String(input)).searchParams.get("after");
      tombstoneRequests.push(after ?? "");
      const index = after === null ? 0 : Number(after);
      return Response.json({
        accountId: tombstoneOwner ?? tokens.get(token),
        operations: tombstonePages[index] ?? [],
        next: index + 1 < tombstonePages.length ? String(index + 1) : null,
      });
    }
    if (path === "/v1/account/merge-ack") {
      if (!ackAvailable || body.accountId !== tokens.get(token))
        return Response.json({ error: "merge_changed" }, { status: 409 });
      acknowledgements.push(String(body.accountId));
      pendingAcks.delete(token);
      return Response.json({ ok: true });
    }
    if (path === "/v1/device/deletion-status")
      return !deletionStatusAvailable
        ? Response.json({ error: "offline" }, { status: 503 })
        : deleted && tokens.get(token) === "owner-one"
          ? Response.json({ error: "account_deleted" }, { status: 410 })
          : Response.json({ error: "not_found" }, { status: 404 });
    if (path === "/v1/account/connections")
      return connectionsAvailable
        ? Response.json({
            accountId: tokens.get(token),
            connections: [
              {
                provider: "google",
                name: "Google",
                connected: true,
                available: true,
                accessToken: "must-not-escape",
              },
              {
                provider: "apple",
                name: "Apple",
                connected: false,
                available: false,
              },
            ],
          })
        : Response.json({ error: "offline" }, { status: 503 });
    if (init?.method === "DELETE" && path.startsWith("/v1/devices/"))
      return new Response(null, { status: 204 });
    if (path.startsWith("/v1/sync/")) syncRequests.push(path);
    if (path === "/v1/sync/snapshot" || path === "/v1/sync/pull")
      return Response.json({
        cursor: "0",
        operations: path === "/v1/sync/snapshot" ? snapshotOperations : [],
        hasMore: false,
      });
    if (path === "/v1/sync/push") {
      pushes.push({
        owner: tokens.get(token),
        operations: body.operations as { kind: string; payload: unknown }[],
      });
      return Response.json({
        cursor: "1",
        acceptedIds: (body.operations as { id: string }[]).map((op) => op.id),
      });
    }
    throw new Error("Unexpected cloud request.");
  };
  const app = createApp({
    environment: "test",
    logger: false,
    database,
    secretStore: secrets,
    accountServiceUrl: "https://accounts.example",
    accountFetch: fetcher,
    now: () => new Date(now),
  });
  apps.push(app);
  const login = async (
    user: string,
    options: {
      cookie?: string;
      adoptLocalAccount?: boolean;
      disableSync?: boolean;
    } = {},
  ) => {
    identity = user;
    now += 1000;
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: options.cookie ? { cookie: options.cookie } : {},
      payload: {
        adoptLocalAccount: options.adoptLocalAccount,
        disableSync: options.disableSync,
      },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    const poll = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: {
        cookie: [cookie(start), options.cookie].filter(Boolean).join("; "),
      },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json().status).toBe("approved");
    expect(poll.body).not.toContain("cloud-private-token");
    return cookie(poll);
  };
  return {
    app,
    database,
    secrets,
    pushes,
    syncRequests,
    acknowledgements,
    tombstoneRequests,
    login,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      revoked = true;
    },
    deleteCloud: () => {
      deleted = true;
    },
    setDeletionStatusAvailable: (value: boolean) => {
      deletionStatusAvailable = value;
    },
    setConnectionsAvailable: (value: boolean) => {
      connectionsAvailable = value;
    },
    setIdentity: (user: string) => {
      identity = user;
    },
    merge: (from: string, to: string) => {
      aliases.set(from, to);
      for (const [token, owner] of tokens)
        if (owner === from) {
          tokens.set(token, to);
          pendingAcks.add(token);
        }
    },
    rebindWithoutProof: (from: string, to: string) => {
      for (const [token, owner] of tokens)
        if (owner === from) tokens.set(token, to);
    },
    setCloudAvailable: (value: boolean) => {
      cloudAvailable = value;
    },
    setAckAvailable: (value: boolean) => {
      ackAvailable = value;
    },
    setTombstonePages: (pages: unknown[][], owner: string | null = null) => {
      tombstonePages = pages;
      tombstoneOwner = owner;
    },
    setSnapshotOperations: (operations: unknown[]) => {
      snapshotOperations = operations;
    },
    restart: () => {
      const restarted = createApp({
        environment: "test",
        logger: false,
        database,
        secretStore: secrets,
        accountServiceUrl: "https://accounts.example",
        accountFetch: fetcher,
        now: () => new Date(now),
      });
      apps.push(restarted);
      return restarted;
    },
    setOmitMergeFlag: (value: boolean) => {
      omitMergeFlag = value;
    },
    setPending: (value: boolean) => {
      pending = value;
    },
  };
}

describe("account authentication and profile boundaries", () => {
  it("allows signing into the surviving account after a merge collision without exposing old profile credentials", async () => {
    const { app, database, secrets, login, merge, setSnapshotOperations } =
      cloud();
    const sourceCookie = await login("owner-one");
    await login("owner-two");
    const source = database.accounts.getByCloudUserId("owner-one")!;
    const target = database.accounts.getByCloudUserId("owner-two")!;
    const original = database.profiles.list(source.id)[0]!;
    database.profiles.setPinHash(
      original.id,
      "scrypt:encoded-test-hash-".padEnd(64, "0"),
    );
    await secrets.set(
      remoteApiSecretKey(original.id, "openai"),
      "original-private-key",
    );
    const { audioOutputDeviceId: _device, ...playback } =
      DEFAULT_PLAYBACK_PREFERENCES;
    setSnapshotOperations([
      {
        id: randomUUID(),
        profileId: original.syncId,
        entityId: original.syncId,
        kind: "profile",
        action: "upsert",
        updatedAt: new Date().toISOString(),
        payload: {
          name: "Transferred viewer",
          locale: "en",
          genres: [],
          playback,
          appearance: DEFAULT_APPEARANCE_PREFERENCES,
          onboardingComplete: true,
        },
      },
    ]);
    merge("owner-one", "owner-two");
    const conflict = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: sourceCookie },
    });
    expect(conflict.json()).toMatchObject({
      status: "error",
      error: "CLOUD_ACCOUNT_MERGE_CONFLICT",
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { cookie: sourceCookie },
    });
    const survivorCookie = await login("owner-two");
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: survivorCookie },
    });
    expect(sync.json().status).not.toBe("error");
    const imported = database.profiles.getBySyncId(original.syncId)!;
    expect(imported).toMatchObject({
      accountId: target.id,
      name: "Transferred viewer",
      pinEnabled: false,
    });
    expect(imported.id).not.toBe(original.id);
    expect(await secrets.get(remoteApiSecretKey(original.id, "openai"))).toBe(
      "original-private-key",
    );
    const credential = await app.inject({
      url: `/api/v1/inference/api-credential?profileId=${encodeURIComponent(imported.id)}&provider=openai`,
      headers: { cookie: survivorCookie },
    });
    expect(credential.json()).toMatchObject({
      provider: "openai",
      configured: false,
    });
  });
  it("persists missed transfer tombstones across restart, respects profile pause and preserves other accounts", async () => {
    const {
      app,
      database,
      login,
      merge,
      setAckAvailable,
      setTombstonePages,
      restart,
      tombstoneRequests,
      acknowledgements,
      pushes,
    } = cloud();
    const signed = await login("owner-one");
    await login("owner-two");
    const headers = { cookie: signed };
    const owner = database.accounts.getByCloudUserId("owner-one")!;
    const other = database.accounts.getByCloudUserId("owner-two")!;
    const profile = database.profiles.list(owner.id)[0]!;
    const foreign = database.profiles.list(other.id)[0]!;
    await app.inject({
      method: "PUT",
      url: `/api/v1/account/sync/profile/${profile.id}`,
      headers,
      payload: { paused: true },
    });
    database.profiles.update(profile.id, { name: "Offline changes" });
    const tombstone = (id: string) => ({
      id: randomUUID(),
      profileId: id,
      entityId: id,
      kind: "profile",
      action: "delete",
      updatedAt: new Date(0).toISOString(),
      payload: null,
    });
    setTombstonePages([
      [tombstone(profile.syncId)],
      [tombstone(foreign.syncId)],
    ]);
    merge("owner-one", "owner-merged");
    setAckAvailable(false);
    const failed = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(failed.json().status).toBe("error");
    expect(tombstoneRequests).toEqual(["", "1"]);
    expect(acknowledgements).toHaveLength(0);
    expect(database.profiles.get(profile.id)?.name).toBe("Offline changes");
    expect(database.profiles.get(foreign.id)?.accountId).toBe(other.id);

    const appAfterRestart = restart();
    setAckAvailable(true);
    const retried = await appAfterRestart.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(retried.json().status).not.toBe("error");
    expect(acknowledgements).toEqual(["owner-merged"]);
    expect(database.profiles.get(profile.id)).not.toBeNull();
    expect(database.profiles.get(foreign.id)?.accountId).toBe(other.id);
    const beforeResume = pushes.length;
    await appAfterRestart.inject({
      method: "PUT",
      url: `/api/v1/account/sync/profile/${profile.id}`,
      headers,
      payload: { paused: false },
    });
    await appAfterRestart.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(database.profiles.get(profile.id)).toBeNull();
    expect(database.profiles.get(foreign.id)?.accountId).toBe(other.id);
    expect(JSON.stringify(pushes.slice(beforeResume))).not.toContain(
      "Offline changes",
    );
  });

  it("rejects invalid tombstones or a different cloud identity without applying or acknowledging any page", async () => {
    const { app, database, login, merge, setTombstonePages, acknowledgements } =
      cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const profile = database.profiles.list(database.accounts.getLocal().id)[0]!;
    const deletion = {
      id: randomUUID(),
      profileId: profile.syncId,
      entityId: profile.syncId,
      kind: "profile",
      action: "delete",
      updatedAt: new Date().toISOString(),
      payload: null,
    };
    merge("owner-one", "owner-merged");
    setTombstonePages([[deletion], [{ ...deletion, action: "upsert" }]]);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(invalid.json().status).toBe("error");
    expect(database.profiles.get(profile.id)).not.toBeNull();
    expect(acknowledgements).toHaveLength(0);
    setTombstonePages([[deletion]], "different-owner");
    const wrongAccount = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(wrongAccount.json().status).toBe("error");
    expect(database.profiles.get(profile.id)).not.toBeNull();
    expect(acknowledgements).toHaveLength(0);
  });
  it("reconciles a verified merge before sync and preserves profile pause and queued changes", async () => {
    const {
      app,
      database,
      login,
      merge,
      syncRequests,
      acknowledgements,
      setAckAvailable,
      pushes,
    } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const profiles = await app.inject({ url: "/api/v1/profiles", headers });
    const profileId = profiles.json().items[0].id as string;
    await app.inject({ method: "POST", url: "/api/v1/account/sync", headers });
    await app.inject({
      method: "PUT",
      url: `/api/v1/account/sync/profile/${profileId}`,
      headers,
      payload: { paused: true },
    });
    database.profiles.update(profileId, { name: "Saved while paused" });
    const initialRequests = syncRequests.length;
    merge("owner-one", "owner-merged");
    setAckAvailable(false);
    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(blocked.json().status).toBe("error");
    expect(database.accounts.getLocal().cloudUserId).toBe("owner-merged");
    expect(database.accounts.getLocal()).toMatchObject({
      name: "owner-merged",
      email: "owner-merged@example.com",
    });
    expect(syncRequests.length).toBe(initialRequests);
    expect(
      (
        await app.inject({
          url: `/api/v1/account/sync/profile/${profileId}`,
          headers,
        })
      ).json(),
    ).toEqual({ paused: true });
    setAckAvailable(true);
    const after = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(after.json().status).not.toBe("error");
    expect(acknowledgements).toContain("owner-merged");
    expect(syncRequests.slice(initialRequests)[0]).toBe("/v1/sync/snapshot");
    expect(
      pushes
        .flatMap((batch) => batch.operations)
        .some((op) => JSON.stringify(op).includes("Saved while paused")),
    ).toBe(false);
    await app.inject({
      method: "PUT",
      url: `/api/v1/account/sync/profile/${profileId}`,
      headers,
      payload: { paused: false },
    });
    await app.inject({ method: "POST", url: "/api/v1/account/sync", headers });
    expect(
      pushes
        .flatMap((batch) => batch.operations)
        .some((op) => JSON.stringify(op).includes("Saved while paused")),
    ).toBe(true);
    const completedRequests = syncRequests.length;
    const completedAcks = acknowledgements.length;
    setAckAvailable(false);
    const unchanged = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers,
    });
    expect(unchanged.json().status).not.toBe("error");
    expect(syncRequests.length).toBeGreaterThan(completedRequests);
    expect(acknowledgements.length).toBe(completedAcks);
  });

  it("keeps both local accounts and blocks synchronization when a merged UID is already in use", async () => {
    const { app, database, login, merge, syncRequests } = cloud();
    const owner = await login("owner-one");
    await login("owner-two");
    const first = database.accounts.getByCloudUserId("owner-one")!;
    const second = database.accounts.getByCloudUserId("owner-two")!;
    merge("owner-one", "owner-two");
    const count = syncRequests.length;
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: owner },
    });
    expect(result.json()).toMatchObject({
      status: "error",
      error: "CLOUD_ACCOUNT_MERGE_CONFLICT",
    });
    expect(syncRequests.length).toBe(count);
    expect(database.accounts.get(first.id)?.cloudUserId).toBe("owner-one");
    expect(database.accounts.get(second.id)?.cloudUserId).toBe("owner-two");
  });

  it("does not sync if the cloud identity cannot be verified", async () => {
    const { app, login, setCloudAvailable, syncRequests } = cloud();
    const owner = await login("owner-one");
    const count = syncRequests.length;
    setCloudAvailable(false);
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: owner },
    });
    expect(result.json()).toMatchObject({
      status: "error",
      error: "CLOUD_SYNC_UNAVAILABLE",
    });
    expect(syncRequests.length).toBe(count);
  });

  it("continues syncing against an older worker when the identity matches", async () => {
    const { app, login, setOmitMergeFlag, setAckAvailable, syncRequests } =
      cloud();
    const signed = await login("owner-one");
    setOmitMergeFlag(true);
    setAckAvailable(false);
    const count = syncRequests.length;
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: signed },
    });
    expect(result.json().status).not.toBe("error");
    expect(syncRequests.length).toBeGreaterThan(count);
  });

  it("never switches local identity or syncs when the cloud cannot prove the merge", async () => {
    const { app, database, login, rebindWithoutProof, syncRequests } = cloud();
    const signed = await login("owner-one");
    rebindWithoutProof("owner-one", "unrelated-owner");
    const count = syncRequests.length;
    const result = await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: signed },
    });
    expect(result.statusCode).toBe(401);
    expect(database.accounts.getLocal().cloudUserId).toBe("owner-one");
    expect(syncRequests.length).toBe(count);
  });
  it("does not convert an account when the deletion check is unavailable", async () => {
    const { app, login, advance, revoke, setDeletionStatusAvailable } = cloud();
    const signed = await login("owner-one");
    revoke();
    setDeletionStatusAvailable(false);
    advance(61_000);
    const status = await app.inject({
      url: "/api/v1/auth/status",
      headers: { cookie: signed },
    });
    expect(status.json()).toMatchObject({
      authenticated: true,
      account: { cloudLinked: true },
    });
  });
  it("limits profile sync controls to the owning account", async () => {
    const { app, login } = cloud();
    const owner = await login("owner-one");
    const ownerHeaders = { cookie: owner };
    const profiles = await app.inject({
      url: "/api/v1/profiles",
      headers: ownerHeaders,
    });
    const id = profiles.json().items[0].id as string;
    const path = `/api/v1/account/sync/profile/${encodeURIComponent(id)}`;
    expect(
      (await app.inject({ url: path, headers: ownerHeaders })).json(),
    ).toEqual({ paused: false });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: path,
          headers: ownerHeaders,
          payload: { paused: true },
        })
      ).json(),
    ).toEqual({ paused: true });
    expect(
      (await app.inject({ url: path, headers: ownerHeaders })).json(),
    ).toEqual({ paused: true });
    const other = await login("owner-two");
    expect(
      (await app.inject({ url: path, headers: { cookie: other } })).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: path,
          headers: { cookie: other },
          payload: { paused: false },
        })
      ).statusCode,
    ).toBe(404);
  });
  it("converts only a confirmed deleted cloud account into a local account and permits explicit re-pairing", async () => {
    const { app, database, login, advance, deleteCloud, pushes } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const before = (
      await app.inject({ url: "/api/v1/profiles", headers })
    ).json().items;
    const profileId = before[0].id as string;
    database.profiles.update(profileId, { name: "Keep this profile" });
    deleteCloud();
    advance(61_000);
    const status = await app.inject({ url: "/api/v1/auth/status", headers });
    expect(status.json()).toMatchObject({
      authenticated: true,
      account: { cloudLinked: false },
    });
    expect(database.profiles.getRequired(profileId).name).toBe(
      "Keep this profile",
    );
    expect(
      (await app.inject({ url: "/api/v1/account", headers })).json().sync
        .configured,
    ).toBe(false);
    expect(
      (await app.inject({ url: "/api/v1/profiles", headers })).statusCode,
    ).toBe(200);
    const paired = await login("owner-two", {
      cookie: signed,
      adoptLocalAccount: true,
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/status",
          headers: { cookie: paired },
        })
      ).json().account.cloudLinked,
    ).toBe(true);
    expect(database.profiles.getRequired(profileId).name).toBe(
      "Keep this profile",
    );
    await app.inject({
      method: "POST",
      url: "/api/v1/account/sync",
      headers: { cookie: paired },
    });
    expect(
      pushes.some(
        (push) =>
          push.owner === "owner-two" &&
          push.operations.some(
            (operation) =>
              operation.kind === "profile" &&
              JSON.stringify(operation.payload).includes("Keep this profile"),
          ),
      ),
    ).toBe(true);
  });
  it("lets an expired session choose a converted household without merging an existing local household", async () => {
    const { app, database, login, advance, deleteCloud } = cloud();
    const local = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const localId = local.json().account.id as string;
    const signed = await login("owner-one");
    const original = (
      await app.inject({
        url: "/api/v1/auth/status",
        headers: { cookie: signed },
      })
    ).json().account.id as string;
    expect(original).not.toBe(localId);
    const profileId = database.profiles.list(original)[0]!.id;
    deleteCloud();
    advance(61_000);
    await app.inject({
      url: "/api/v1/auth/status",
      headers: { cookie: signed },
    });
    advance(31 * 24 * 60 * 60_000);
    const status = (await app.inject("/api/v1/auth/status")).json();
    expect(status.recoveredLocalAccounts).toHaveLength(1);
    const recoveredId = status.recoveredLocalAccounts[0].id as string;
    expect(recoveredId).not.toBe(original);
    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: { recoveredAccountId: recoveredId },
    });
    expect(recovered.json().account.id).toBe(original);
    expect(database.profiles.getRequired(profileId).accountId).toBe(original);
    const defaultLocal = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    expect(defaultLocal.json().account.id).toBe(localId);
    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: { recoveredAccountId: "arbitrary" },
    });
    expect(invalid.statusCode).toBe(404);
  });
  it("reports account synchronization in the integration catalog and respects pause and account isolation", async () => {
    const { app, login } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const profiles = await app.inject({ url: "/api/v1/profiles", headers });
    const profileId = profiles.json().items[0].id as string;
    const catalog = async () => {
      const response = await app.inject({
        url: `/api/v1/integrations?profileId=${profileId}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      return response
        .json()
        .items.find((item: { id: string }) => item.id === "cloudflare-sync");
    };
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: true,
      status: "connected",
    });
    const paused = await app.inject({
      method: "PUT",
      url: "/api/v1/account/sync",
      headers,
      payload: { enabled: false },
    });
    expect(paused.statusCode).toBe(200);
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: false,
      status: "action_required",
    });
    const localSession = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const localHeaders = { cookie: cookie(localSession) };
    const localProfiles = await app.inject({
      url: "/api/v1/profiles",
      headers: localHeaders,
    });
    const localProfileId = localProfiles.json().items[0].id as string;
    const localCatalog = await app.inject({
      url: `/api/v1/integrations?profileId=${localProfileId}`,
      headers: localHeaders,
    });
    expect(
      localCatalog
        .json()
        .items.find((item: { id: string }) => item.id === "cloudflare-sync"),
    ).toMatchObject({
      selected: false,
      configured: false,
      status: "not_configured",
    });
    await app.inject({
      method: "PUT",
      url: "/api/v1/account/sync",
      headers,
      payload: { enabled: true },
    });
    expect(await catalog()).toMatchObject({
      selected: true,
      configured: true,
      status: "connected",
    });
  });
  it("reads linked methods for the signed-in owner without exposing tokens and tolerates a cloud outage", async () => {
    const { app, login, setConnectionsAvailable } = cloud();
    const signed = await login("owner-one");
    const headers = { cookie: signed };
    const response = await app.inject({
      url: "/api/v1/account/connections",
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      connections: [
        { provider: "google", connected: true },
        { provider: "apple", available: false },
      ],
    });
    expect(response.body).not.toContain("must-not-escape");
    expect(response.body).not.toContain("cloud-private-token");
    const overview = await app.inject({ url: "/api/v1/account", headers });
    expect(
      new URL(overview.json().manageUrl).searchParams.get("account_id"),
    ).toBe("owner-one");
    setConnectionsAvailable(false);
    expect(
      (await app.inject({ url: "/api/v1/account/connections", headers }))
        .statusCode,
    ).toBe(503);
    expect(
      (await app.inject({ url: "/api/v1/account", headers })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/account/connections" })).statusCode,
    ).toBe(401);
  });
  it("opens an isolated household beside a claimed Google account without cloud credentials", async () => {
    const { app, database, login } = cloud();
    await login("owner-one");
    const owned = database.profiles.list("local")[0]!;
    database.profiles.update(owned.id, { name: "Private owner profile" });
    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    expect(entered.statusCode).toBe(200);
    const account = entered.json().account;
    expect(account.id).not.toBe("local");
    expect(account.cloudLinked).toBe(false);
    const headers = { cookie: cookie(entered) };
    const profiles = await app.inject({ url: "/api/v1/profiles", headers });
    expect(profiles.statusCode).toBe(200);
    expect(profiles.body).not.toContain("Private owner profile");
    expect(
      (
        await app.inject({
          url: `/api/v1/setup/status?profileId=${owned.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    const overview = (
      await app.inject({ url: "/api/v1/account", headers })
    ).json();
    expect(overview.manageUrl).toBeNull();
    expect(overview.sync.configured).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/device",
          headers,
          payload: {
            purpose: "pin-reset",
            profileId: profiles.json().items[0].id,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/auth/local",
          headers: { origin: "https://evil.example" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it("keeps local profiles local when a separate online account signs in later", async () => {
    const { app, database, login } = cloud();
    const entered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const localId = entered.json().account.id;
    const old = database.profiles.list(localId)[0]!;
    database.profiles.update(old.id, { name: "Local cinema" });
    const signed = await login("owner-one");
    expect(database.accounts.getLocal().cloudUserId).toBeNull();
    const profiles = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: signed },
    });
    expect(profiles.body).not.toContain("Local cinema");
    expect(database.profiles.getRequired(old.id).accountId).toBe(localId);
  });

  it("adopts only the explicitly reviewed household and invalidates its other sessions", async () => {
    const { app, database, login } = cloud();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/local",
      payload: {},
    });
    const accountId = first.json().account.id;
    const profileId = database.profiles.list(accountId)[0]!.id;
    const signed = await login("owner-one", {
      cookie: cookie(first),
      adoptLocalAccount: true,
      disableSync: true,
    });
    expect(database.accounts.getRequired(accountId).cloudUserId).toBe(
      "owner-one",
    );
    expect(database.profiles.getRequired(profileId).accountId).toBe(accountId);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: cookie(second) },
        })
      ).statusCode,
    ).toBe(401);
    const overview = (
      await app.inject({ url: "/api/v1/account", headers: { cookie: signed } })
    ).json();
    expect(overview.sync.configured).toBe(false);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/account/sync",
          headers: { cookie: signed },
          payload: { enabled: true },
        })
      ).json().configured,
    ).toBe(true);
  });
  it("marks local cookies Secure when HTTPS terminates at the configured web proxy", async () => {
    const runtimeConfig = readRuntimeConfig({
      NODE_ENV: "test",
      STREAMERAI_WEB_ORIGIN: "https://cinema.example",
    });
    const app = createApp({
      environment: "test",
      logger: false,
      runtimeConfig,
    });
    apps.push(app);
    const status = await app.inject("/api/v1/auth/status");
    expect(status.statusCode).toBe(200);
    expect(String(status.headers["set-cookie"])).toContain("; Secure");
  });
  it("keeps local-only installations available and masks locked profile data", async () => {
    const { app, database } = local();
    const status = await app.inject("/api/v1/auth/status");
    expect(status.json()).toMatchObject({
      enabled: false,
      authenticated: true,
      cloudConfigured: false,
    });
    const owner = cookie(status);
    database.profiles.update("default", {
      preferences: { prompt: "Private taste", genres: ["Drama"] },
    });
    const set = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    expect(set.statusCode).toBe(200);
    const locked = await app.inject("/api/v1/profiles");
    expect(locked.json().items[0]).toMatchObject({
      name: "Viewer",
      pinEnabled: true,
      prompt: "",
      genres: [],
    });
    expect(locked.body).not.toContain("Private taste");
    expect(
      (await app.inject("/api/v1/profiles/default/library")).statusCode,
    ).toBe(423);
    const unlock = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/unlock",
      payload: { pin: "1234" },
    });
    expect(unlock.statusCode).toBe(204);
    const opened = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: cookie(unlock) },
    });
    expect(opened.json().items[0].prompt).toBe("Private taste");
  });
  it("rejects bypassing an existing PIN through settings and locks after repeated failures", async () => {
    const { app } = local();
    const owner = cookie(await app.inject("/api/v1/auth/status"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const bypass = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      payload: { pin: null },
    });
    expect(bypass.statusCode).toBe(403);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/profiles/default/unlock",
            payload: { pin: "9999" },
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/profiles/default/unlock",
          payload: { pin: "1234" },
        })
      ).statusCode,
    ).toBe(429);
  });
  it("relocks on explicit switch and invalidates old unlocks when PIN changes", async () => {
    const { app } = local();
    const owner = cookie(await app.inject("/api/v1/auth/status"));
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const unlock = await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/unlock",
      payload: { pin: "1234" },
    });
    const viewer = cookie(unlock);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(200);
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "4567", currentPin: "1234" },
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: viewer },
        })
      ).statusCode,
    ).toBe(423);
    await app.inject({
      method: "POST",
      url: "/api/v1/profiles/default/lock",
      headers: { cookie: owner },
      payload: {},
    });
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(423);
  });
  it("requires authentication in cloud mode and rejects cross-origin account writes", async () => {
    const { app } = cloud();
    expect((await app.inject("/api/v1/profiles")).statusCode).toBe(401);
    expect((await app.inject("/api/v1/auth/status")).json().authenticated).toBe(
      false,
    );
    const cross = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { origin: "https://attacker.example" },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });
  it("claims legacy profiles once and isolates accounts, including body/query profile IDs", async () => {
    const { app, database, login } = cloud();
    const one = await login("owner-one");
    const two = await login("owner-two");
    expect(database.accounts.getLocal().cloudUserId).toBe("owner-one");
    const owned = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: one },
    });
    expect(owned.json().items.map((item: { id: string }) => item.id)).toContain(
      "default",
    );
    const second = await app.inject({
      url: "/api/v1/profiles",
      headers: { cookie: two },
    });
    expect(second.json().items).toHaveLength(1);
    expect(second.body).not.toContain('"id":"default"');
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status?profileId=default",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status?profileId=missing-profile",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/integrations/webshare/connect",
          headers: { cookie: two },
          payload: { profileId: "default", username: "x", password: "x" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status",
          headers: { cookie: two },
        })
      ).statusCode,
    ).toBe(200);
  });
  it("binds a pending pairing to the initiating browser", async () => {
    const { app } = cloud();
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      payload: {},
    });
    const attempt = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(attempt.statusCode).toBe(403);
    expect(attempt.body).not.toContain("cloud-private-token");
  });
  it("never falls back to another account's default profile when the account is empty", async () => {
    const { app, database, login } = cloud();
    await login("owner-one");
    const owner = await login("owner-two");
    const account = database.accounts.getByCloudUserId("owner-two")!;
    for (const profile of database.profiles.list(account.id))
      database.profiles.delete(profile.id);
    expect(
      (
        await app.inject({
          url: "/api/v1/setup/status",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: owner },
        })
      ).json().items,
    ).toEqual([]);
    expect(database.profiles.get("default")?.accountId).toBe("local");
  });
  it("keeps an active protected profile unlocked and relocks after thirty idle minutes", async () => {
    const { app, login, advance } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    for (let index = 0; index < 3; index++) {
      advance(20 * 60_000);
      expect(
        (
          await app.inject({
            url: "/api/v1/profiles/default/library",
            headers: { cookie: owner },
          })
        ).statusCode,
      ).toBe(200);
    }
    advance(31 * 60_000);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles/default/library",
          headers: { cookie: owner },
        })
      ).statusCode,
    ).toBe(423);
  });
  it("requires fresh same-account Google approval for PIN recovery and never replaces the login session", async () => {
    const { app, login } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { cookie: owner },
      payload: { purpose: "pin-reset", profileId: "default" },
    });
    const recovery = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: { cookie: `${owner}; ${cookie(start)}` },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(recovery.statusCode).toBe(200);
    expect(recovery.json().status).toBe("approved");
    expect(recovery.headers["set-cookie"]).toBeUndefined();
    const reset = await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: null },
    });
    expect(reset.json()).toEqual({ pinEnabled: false });
  });
  it("rejects recovery using another Google account", async () => {
    const { app, login, setIdentity } = cloud();
    const owner = await login("owner-one");
    await app.inject({
      method: "PUT",
      url: "/api/v1/profiles/default/pin",
      headers: { cookie: owner },
      payload: { pin: "1234" },
    });
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device",
      headers: { cookie: owner },
      payload: { purpose: "pin-reset", profileId: "default" },
    });
    setIdentity("owner-two");
    const recovered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/device/poll",
      headers: { cookie: `${owner}; ${cookie(start)}` },
      payload: { deviceCode: start.json().deviceCode },
    });
    expect(recovered.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/v1/profiles/default/pin",
          headers: { cookie: owner },
          payload: { pin: null },
        })
      ).statusCode,
    ).toBe(403);
  });
  it("invalidates logout locally and honors cloud device revocation", async () => {
    const { app, login, revoke, advance } = cloud();
    const session = await login("owner-one");
    expect(
      (
        await app.inject({
          url: "/api/v1/auth/status",
          headers: { cookie: session },
        })
      ).json().authenticated,
    ).toBe(true);
    revoke();
    advance(61_000);
    expect(
      (
        await app.inject({
          url: "/api/v1/profiles",
          headers: { cookie: session },
        })
      ).statusCode,
    ).toBe(401);
  });
});
