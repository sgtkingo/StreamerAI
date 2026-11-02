import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountSyncOperationSchema,
  PlaybackPreferencesSchema,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import type { ProviderFetch } from "../src/integrations/tmdb-api-client.js";
import {
  AccountSyncService,
  compareAccountSyncOperations,
} from "../src/services/account-sync.js";

const opened: StreamerDatabase[] = [];
const directories: string[] = [];
let milliseconds = Date.parse("2026-11-01T10:00:00.000Z");
const now = () => new Date(milliseconds);
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  milliseconds = Date.parse("2026-11-01T10:00:00.000Z");
});
const key = (operation: AccountSyncOperation): string =>
  JSON.stringify([operation.kind, operation.profileId, operation.entityId]);

class Cloud {
  rows = new Map<string, AccountSyncOperation>();
  log: AccountSyncOperation[] = [];
  pushed: AccountSyncOperation[] = [];
  requests: string[] = [];
  offline = false;
  failPush = false;
  pageSize = 100;
  minimumCursor = 0;
  fetch: ProviderFetch = async (input, init) => {
    if (this.offline) throw new Error("offline");
    this.requests.push(input);
    expect(init.headers.authorization).toBe("Bearer cloud-token");
    const url = new URL(input);
    const response = (body: unknown) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    });
    if (url.pathname === "/v1/sync/push") {
      if (this.failPush) throw new Error("Simulated temporary push outage.");
      const operations = (
        JSON.parse(init.body!) as { operations: unknown[] }
      ).operations.map((item) => AccountSyncOperationSchema.parse(item));
      expect(operations.length).toBeLessThanOrEqual(10);
      this.pushed.push(...operations);
      for (const operation of operations) this.add(operation);
      return response({
        cursor: String(this.log.length),
        acceptedIds: operations.map((item) => item.id),
      });
    }
    if (url.pathname === "/v1/sync/snapshot") {
      const after = url.searchParams.get("after");
      if (after !== null && Number(after.split(":")[1]) < this.minimumCursor)
        return {
          ok: false,
          status: 410,
          text: async () => JSON.stringify({ error: "cursor_expired" }),
        };
      const start = after === null ? 0 : Number(after.split(":")[2]);
      const entries = [...this.rows.values()].sort(
        (a, b) => Number(b.kind === "profile") - Number(a.kind === "profile"),
      );
      const operations = entries.slice(start, start + this.pageSize);
      const hasMore = start + this.pageSize < entries.length;
      return response({
        cursor: hasMore
          ? `snapshot:${this.log.length}:${start + this.pageSize}`
          : String(this.log.length),
        operations,
        hasMore,
      });
    }
    const start = Number(url.searchParams.get("after") ?? "0");
    if (start < this.minimumCursor)
      return {
        ok: false,
        status: 410,
        text: async () => JSON.stringify({ error: "cursor_expired" }),
      };
    const operations = this.log.slice(start, start + this.pageSize);
    return response({
      cursor: String(start + operations.length),
      operations,
      hasMore: start + operations.length < this.log.length,
    });
  };
  add(operation: AccountSyncOperation) {
    const existing = this.rows.get(key(operation));
    if (
      existing !== undefined &&
      compareAccountSyncOperations(operation, existing) <= 0
    )
      return;
    this.rows.set(key(operation), operation);
    this.log.push(operation);
  }
}

function installation(cloud: Cloud, options: { secretProfile?: boolean } = {}) {
  const db = openStreamerDatabase({ filename: ":memory:", clock: now });
  opened.push(db);
  db.accounts.ensureCloudAccount({ id: "owner" });
  db.profiles.create({
    id: "default",
    name: "Viewer",
    locale: "en",
    preferences: options.secretProfile
      ? {
          prompt: "PRIVATE AI PROMPT",
          playback: {
            ...PlaybackPreferencesSchema.parse({}),
            audioOutputDeviceId: "PRIVATE DEVICE",
          },
        }
      : {},
  });
  const service = new AccountSyncService(
    db,
    "https://auth.example.com",
    cloud.fetch,
    now,
    {
      getCredential: async () => ({ token: "cloud-token", deviceId: "device" }),
    },
  );
  return { db, service };
}
function title(db: StreamerDatabase) {
  return db.titles.upsert({
    id: "tmdb:movie:42",
    kind: "movie",
    title: "Example",
    originalTitle: null,
    year: 2026,
    synopsis: "Example title.",
    genres: ["Drama"],
    metadataProvider: "tmdb",
    metadataValidatedAt: now().toISOString(),
    posterUrl: null,
    backdropUrl: null,
    accentColor: "#334455",
    ratings: [],
    availability: "unknown",
    availabilityProvider: null,
    availabilityCheckedAt: null,
    formats: [],
    seriesCoverage: null,
  });
}

describe("account synchronization", () => {
  it("keeps another storage binding's ledger, cursor and outbox separate", async () => {
    const cloud = new Cloud();
    const { db, service } = installation(cloud);
    await service.sync("local");
    const received: AccountSyncOperation[] = [];
    const other = new AccountSyncService(
      db,
      "https://unused.example",
      async () => {
        throw new Error("The provider adapter must handle this exchange.");
      },
      now,
      {
        namespace: "another-provider:owner:dataset:generation-1",
        getCredential: async () => ({
          token: "another-credential",
          deviceId: "same-home",
        }),
        transport: {
          exchange: async (_credential, exchange) => {
            if (exchange.kind === "push") {
              received.push(...exchange.operations);
              return {
                cursor: "other:1",
                acceptedIds: exchange.operations.map((op) => op.id),
              };
            }
            return { cursor: "other:1", operations: [], hasMore: false };
          },
        },
      },
    );
    expect(other.status("local").lastSyncedAt).toBeNull();
    expect((await other.sync("local")).status).toBe("idle");
    expect(received.some((op) => op.kind === "profile")).toBe(true);
    // A new provider still exports current data after the original outbox was delivered.
    expect(service.status("local").configured).toBe(true);
    expect(cloud.pushed.filter((op) => op.kind === "profile")).toHaveLength(1);
  });
  it("pauses durably without sending or losing offline mutations, then resumes", async () => {
    const cloud = new Cloud();
    const { db, service } = installation(cloud);
    await service.sync("local");
    const count = cloud.requests.length;
    await service.setEnabled("local", false);
    db.profiles.update("default", { name: "Offline household" });
    service.capture("local");
    expect((await service.sync("local")).configured).toBe(false);
    expect(cloud.requests).toHaveLength(count);
    const restarted = new AccountSyncService(
      db,
      "https://auth.example.com",
      cloud.fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    expect(restarted.status("local").configured).toBe(false);
    await restarted.setEnabled("local", true);
    expect((await restarted.sync("local")).configured).toBe(true);
    expect(
      cloud.pushed.some(
        (op) =>
          op.kind === "profile" && op.payload?.name === "Offline household",
      ),
    ).toBe(true);
  });

  it("discards a response that arrives after synchronization was paused", async () => {
    const cloud = new Cloud();
    const { db } = installation(cloud);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const service = new AccountSyncService(
      db,
      "https://auth.example.com",
      async (url, init) => {
        waiting();
        await gate;
        return cloud.fetch(url, init);
      },
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    const running = service.sync("local");
    await started;
    const paused = service.setEnabled("local", false);
    resume();
    expect((await running).configured).toBe(false);
    expect((await paused).configured).toBe(false);
    expect(cloud.pushed).toHaveLength(0);
  });
  it("recovers an expired cursor with a full snapshot while preserving deferred offline writes", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Alex" });
    const item = title(first.db);
    first.db.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    await first.service.sync("local");
    const original = cloud.pushed.find(
      (operation) => operation.kind === "profile",
    )!;
    milliseconds += 91 * 86_400_000;
    first.db.profiles.update("default", { name: "Offline name" });
    first.db.library.remove("default", item.id);
    cloud.failPush = true;
    expect((await first.service.sync("local")).status).toBe("error");
    // Failed writes are not eligible again yet, but must survive the reset.
    expect(first.db.syncOutbox.listPending()).toEqual([]);
    const remoteId = randomUUID();
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...original,
        id: randomUUID(),
        profileId: remoteId,
        entityId: remoteId,
        payload: { ...original.payload, name: "Remote profile" },
        updatedAt: now().toISOString(),
      }),
    );
    cloud.minimumCursor = cloud.log.length;
    cloud.pageSize = 1;
    cloud.failPush = false;
    const pushed = cloud.pushed.length;
    expect((await first.service.sync("local")).status).toBe("pending");
    expect(first.db.profiles.get("default")?.name).toBe("Offline name");
    expect(first.db.library.list("default")).toEqual([]);
    expect(first.db.profiles.getBySyncId(remoteId)?.name).toBe(
      "Remote profile",
    );
    expect(cloud.pushed).toHaveLength(pushed);
    expect(
      cloud.requests.some((url) => url.includes("after=snapshot%3A")),
    ).toBe(true);
    milliseconds += 900_001;
    const deferred = first.db.syncOutbox.listPending<AccountSyncOperation>();
    expect(deferred).toHaveLength(2);
    expect(deferred.every((entry) => entry.attempts === 1)).toBe(true);
    const ids = deferred.map((entry) => entry.opId).sort();
    expect((await first.service.sync("local")).status).toBe("idle");
    expect(
      cloud.pushed
        .slice(pushed)
        .map((operation) => operation.id)
        .sort(),
    ).toEqual(ids);
    expect(cloud.rows.get(key(original))?.payload).toMatchObject({
      name: "Offline name",
    });
  });

  it("captures writes committed during an expired request before restarting the snapshot", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Alex" });
    await first.service.sync("local");
    const original = cloud.pushed[0]!;
    milliseconds += 91 * 86_400_000;
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...original,
        id: randomUUID(),
        payload: { ...original.payload, name: "Remote name" },
        updatedAt: now().toISOString(),
      }),
    );
    cloud.minimumCursor = cloud.log.length;
    let changed = false;
    const fetch: ProviderFetch = async (input, init) => {
      const response = await cloud.fetch(input, init);
      if (!changed && response.status === 410) {
        changed = true;
        milliseconds += 1_000;
        first.db.profiles.update("default", { name: "Committed during reset" });
      }
      return response;
    };
    const resumed = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    expect((await resumed.sync("local")).status).toBe("idle");
    expect(first.db.profiles.get("default")?.name).toBe(
      "Committed during reset",
    );
    expect(cloud.pushed.at(-1)?.payload).toMatchObject({
      name: "Committed during reset",
    });
  });

  it("retains authoritative profile deletions across retention even when offline edits are newer", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Alex" });
    await first.service.sync("local");
    const original = cloud.pushed[0]!;
    milliseconds += 86_400_000;
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...original,
        id: randomUUID(),
        action: "delete",
        payload: null,
        updatedAt: now().toISOString(),
      }),
    );
    cloud.minimumCursor = cloud.log.length;
    milliseconds += 91 * 86_400_000;
    first.db.profiles.update("default", { name: "Newer offline edit" });
    first.service.capture("local");
    expect(first.db.syncOutbox.listPending()).toHaveLength(1);
    const pushed = cloud.pushed.length;
    expect((await first.service.sync("local")).status).toBe("idle");
    expect(first.db.profiles.list("local")).toEqual([]);
    expect(first.db.syncOutbox.listPending()).toEqual([]);
    expect(cloud.pushed).toHaveLength(pushed);
  });

  it("restarts a snapshot when retention overtakes its continuation watermark", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Alex" });
    const item = title(first.db);
    first.db.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    await first.service.sync("local");
    cloud.pageSize = 1;
    const second = installation(cloud);
    let expired = false;
    const fetch: ProviderFetch = async (input, init) => {
      if (!expired && input.includes("after=snapshot%3A")) {
        expired = true;
        const original = cloud.pushed[0]!;
        milliseconds += 91 * 86_400_000;
        cloud.add(
          AccountSyncOperationSchema.parse({
            ...original,
            id: randomUUID(),
            payload: { ...original.payload, name: "Updated after first page" },
            updatedAt: now().toISOString(),
          }),
        );
        cloud.minimumCursor = cloud.log.length;
      }
      return cloud.fetch(input, init);
    };
    const resumed = new AccountSyncService(
      second.db,
      "https://auth.example.com",
      fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    const pushed = cloud.pushed.length;
    expect((await resumed.sync("local")).status).toBe("idle");
    expect(expired).toBe(true);
    const profiles = second.db.profiles.list("local");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("Updated after first page");
    expect(second.db.library.list(profiles[0]!.id)).toHaveLength(1);
    expect(cloud.pushed).toHaveLength(pushed);
  });

  it.each([
    { status: 410, body: { error: "not_found" } },
    { status: 410, body: "Gone" },
    { status: 403, body: { error: "cursor_expired" } },
  ])(
    "does not reset the cursor for an unrelated error $status: $body",
    async ({ status, body }) => {
      const cloud = new Cloud();
      const first = installation(cloud);
      await first.service.sync("local");
      const requests: string[] = [];
      const fetch: ProviderFetch = async (input) => {
        requests.push(input);
        return {
          ok: false,
          status,
          text: async () =>
            typeof body === "string" ? body : JSON.stringify(body),
        };
      };
      const resumed = new AccountSyncService(
        first.db,
        "https://auth.example.com",
        fetch,
        now,
        {
          getCredential: async () => ({
            token: "cloud-token",
            deviceId: "device",
          }),
        },
      );
      expect((await resumed.sync("local")).status).toBe("error");
      expect((await resumed.sync("local")).status).toBe("error");
      expect(requests).toHaveLength(2);
      expect(
        requests.every((input) => input.includes("/v1/sync/pull?after=1")),
      ).toBe(true);
    },
  );

  it("bounds cursor resets per sync run and can recover on the next attempt", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Alex" });
    await first.service.sync("local");
    milliseconds += 1_000;
    first.db.profiles.update("default", {
      name: "Queued while server is broken",
    });
    let broken = true;
    const requests: string[] = [];
    const fetch: ProviderFetch = async (input, init) => {
      requests.push(input);
      return broken
        ? {
            ok: false,
            status: 410,
            text: async () => JSON.stringify({ error: "cursor_expired" }),
          }
        : cloud.fetch(input, init);
    };
    const resumed = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    expect((await resumed.sync("local")).status).toBe("error");
    expect(requests).toHaveLength(3);
    expect(
      requests.slice(1).every((input) => input.endsWith("/sync/snapshot")),
    ).toBe(true);
    expect(first.db.syncOutbox.listPending()).toHaveLength(1);
    broken = false;
    expect((await resumed.sync("local")).status).toBe("idle");
    expect(cloud.pushed.at(-1)?.payload).toMatchObject({
      name: "Queued while server is broken",
    });
  });

  it("uses the same binary operation-ID ordering as the cloud database for tied clocks", () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.service.capture("local");
    const base =
      first.db.syncOutbox.listPending<AccountSyncOperation>()[0]!.payload;
    const uppercase = AccountSyncOperationSchema.parse({
      ...base,
      id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    });
    const lowercase = AccountSyncOperationSchema.parse({
      ...base,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
    expect(compareAccountSyncOperations(uppercase, lowercase)).toBe(-1);
    expect(compareAccountSyncOperations(lowercase, uppercase)).toBe(1);
  });

  it("imports existing account profiles, library, history and progress without duplicate placeholder profiles or echoing", async () => {
    const cloud = new Cloud();
    cloud.pageSize = 1;
    const first = installation(cloud, { secretProfile: true });
    const item = title(first.db);
    first.db.profiles.update("default", {
      name: "Alex",
      preferences: {
        ...first.db.profiles.get("default")!.preferences,
        onboardingComplete: true,
      },
    });
    first.db.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    first.db.history.append({
      id: randomUUID(),
      profileId: "default",
      titleId: item.id,
      eventType: "start",
      episodeLabel: null,
      progressPercent: 20,
    });
    first.db.playbackPositions.upsert({
      profileId: "default",
      titleId: item.id,
      seasonNumber: null,
      episodeNumber: null,
      positionSeconds: 120,
      durationSeconds: 600,
      progressPercent: 20,
    });
    expect((await first.service.sync("local")).status).toBe("idle");
    expect(JSON.stringify(cloud.pushed)).not.toContain("PRIVATE");
    const pushed = cloud.pushed.length;
    const second = installation(cloud);
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(second.db.profiles.list()).toHaveLength(1);
    const imported = second.db.profiles.list()[0]!;
    expect(imported.syncId).toBe(first.db.profiles.get("default")!.syncId);
    expect(imported.name).toBe("Alex");
    expect(second.db.library.list(imported.id)).toHaveLength(1);
    expect(second.db.history.listAll(imported.id)).toHaveLength(1);
    expect(
      second.db.playbackPositions.list(imported.id)[0]?.positionSeconds,
    ).toBe(120);
    expect(cloud.pushed).toHaveLength(pushed);
    expect(
      cloud.requests.some((url) => url.includes("after=snapshot%3A")),
    ).toBe(true);
    expect(second.db.titles.get(item.id)).toMatchObject({
      availability: "unknown",
      sources: [],
    });
  });

  it("does not echo user state when an installation has different cached title metadata", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    const item = title(first.db);
    first.db.profiles.update("default", {
      name: "Alex",
      preferences: { onboardingComplete: true },
    });
    first.db.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    await first.service.sync("local");
    const count = cloud.pushed.length;
    const second = installation(cloud);
    const local = title(second.db);
    const { createdAt: _created, updatedAt: _updated, ...data } = local;
    second.db.titles.upsert({
      ...data,
      title: "A localized title",
      synopsis: "Different local metadata.",
      metadataValidatedAt: new Date(milliseconds + 1_000).toISOString(),
    });
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(cloud.pushed).toHaveLength(count);
    expect(second.db.titles.get(item.id)?.title).toBe("A localized title");
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(cloud.pushed).toHaveLength(count);
  });

  it("captures offline changes durably, retries after a restart, and retains tombstones", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    const item = title(first.db);
    first.db.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    cloud.offline = true;
    expect((await first.service.sync("local")).status).toBe("error");
    expect(first.db.syncOutbox.listPending()).toHaveLength(2);
    const restarted = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      cloud.fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    cloud.offline = false;
    expect((await restarted.sync("local")).status).toBe("idle");
    milliseconds += 1_000;
    first.db.library.remove("default", item.id);
    restarted.capture("local");
    const pending = first.db.syncOutbox.listPending<AccountSyncOperation>();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({
      kind: "library",
      action: "delete",
      payload: null,
    });
    expect((await restarted.sync("local")).status).toBe("idle");
    const other = installation(cloud);
    expect((await other.service.sync("local")).status).toBe("idle");
    expect(other.db.library.list(other.db.profiles.list()[0]!.id)).toHaveLength(
      0,
    );
  });

  it("uses a new viewing session when playback restarts and rejects progress from an older session", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    const item = title(first.db);
    first.db.playbackPositions.upsert({
      profileId: "default",
      titleId: item.id,
      seasonNumber: null,
      episodeNumber: null,
      positionSeconds: 500,
      durationSeconds: 600,
      progressPercent: 83,
    });
    await first.service.sync("local");
    const old = cloud.pushed.find(
      (operation) => operation.kind === "progress",
    )!;
    milliseconds += 60_000;
    first.db.playbackPositions.upsert({
      profileId: "default",
      titleId: item.id,
      seasonNumber: null,
      episodeNumber: null,
      positionSeconds: 0,
      durationSeconds: 600,
      progressPercent: 0,
    });
    await first.service.sync("local");
    const latest = cloud.pushed
      .filter((operation) => operation.kind === "progress")
      .at(-1)!;
    expect(
      latest.kind === "progress" &&
        old.kind === "progress" &&
        latest.payload!.sessionId,
    ).not.toBe(old.kind === "progress" && old.payload!.sessionId);
    const stale = AccountSyncOperationSchema.parse({
      ...old,
      id: randomUUID(),
      updatedAt: new Date(milliseconds + 60_000).toISOString(),
    });
    cloud.add(stale);
    await first.service.sync("local");
    expect(
      first.db.playbackPositions.get("default", item.id)?.positionSeconds,
    ).toBe(0);
  });

  it("applies authoritative profile revocation before queued offline edits can recreate it", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    await first.service.sync("local");
    const profile = first.db.profiles.get("default")!;
    milliseconds += 10_000;
    first.db.profiles.update(profile.id, { name: "Offline edit" });
    first.service.capture("local");
    cloud.log.push(
      AccountSyncOperationSchema.parse({
        id: randomUUID(),
        kind: "profile",
        action: "delete",
        profileId: profile.syncId,
        entityId: profile.syncId,
        updatedAt: new Date(milliseconds - 5_000).toISOString(),
        payload: null,
      }),
    );
    const pushed = cloud.pushed.length;
    expect((await first.service.sync("local")).status).toBe("idle");
    expect(first.db.profiles.list("local")).toHaveLength(0);
    expect(cloud.pushed).toHaveLength(pushed);
  });

  it("keeps accounts' outgoing state separate and does not require a cloud credential for local use", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.accounts.upsert({ id: "other", cloudUserId: "other" });
    first.db.profiles.create({
      id: "other-profile",
      accountId: "other",
      name: "Other",
      locale: "cs",
    });
    first.service.capture("other");
    await first.service.sync("local");
    expect(
      cloud.pushed.some(
        (operation) =>
          operation.kind === "profile" && operation.payload?.name === "Other",
      ),
    ).toBe(false);
    const disconnected = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      cloud.fetch,
      now,
      { getCredential: async () => null },
    );
    expect(await disconnected.sync("other")).toMatchObject({
      configured: false,
      status: "idle",
    });
    expect(first.db.profiles.get("other-profile")?.name).toBe("Other");
  });

  it("recovers a committed mutation after process restart before capture ran", async () => {
    const cloud = new Cloud();
    const directory = mkdtempSync(join(tmpdir(), "streamer-sync-recovery-"));
    directories.push(directory);
    const filename = join(directory, "state.db");
    const first = openStreamerDatabase({ filename, clock: now });
    opened.push(first);
    first.accounts.ensureCloudAccount({ id: "owner" });
    first.profiles.create({ id: "default", name: "Alex", locale: "en" });
    const item = title(first);
    const sync = new AccountSyncService(
      first,
      "https://auth.example.com",
      cloud.fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    await sync.sync("local");
    expect(first.accounts.listDirtySyncAccounts()).toEqual([]);
    // Simulate a process stopping after committing a local API mutation, before its response hook.
    first.library.upsert({
      profileId: "default",
      titleId: item.id,
      membershipReason: "explicit",
    });
    expect(first.accounts.listDirtySyncAccounts()).toEqual(["local"]);
    first.close();
    const restarted = openStreamerDatabase({ filename, clock: now });
    opened.push(restarted);
    expect(restarted.accounts.listDirtySyncAccounts()).toEqual(["local"]);
    const resumed = new AccountSyncService(
      restarted,
      "https://auth.example.com",
      cloud.fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    expect((await resumed.sync("local")).status).toBe("idle");
    expect(
      cloud.pushed.some(
        (operation) =>
          operation.kind === "library" && operation.entityId === item.id,
      ),
    ).toBe(true);
    expect(restarted.accounts.listDirtySyncAccounts()).toEqual([]);
  });

  it.each(["source-first", "target-first"])(
    "transfers a profile between accounts on one server with %s synchronization",
    async (order) => {
      const source = new Cloud();
      const first = installation(source);
      const item = title(first.db);
      first.db.profiles.update("default", {
        name: "Alex",
        preferences: {
          onboardingComplete: true,
          prompt: "Source-only private taste",
          playback: { audioOutputDeviceId: "source-headphones" },
        },
      });
      first.db.profiles.setPinHash(
        "default",
        "scrypt:encoded-test-hash-".padEnd(64, "0"),
      );
      first.db.library.upsert({
        profileId: "default",
        titleId: item.id,
        membershipReason: "explicit",
      });
      await first.service.sync("local");
      const original = first.db.profiles.get("default")!;
      const pinVersion = first.db.profiles.getPinRecord("default").version;
      first.db.accounts.upsert({
        id: "target",
        cloudUserId: "target-cloud-user",
      });
      first.db.profiles.create({
        id: "target-placeholder",
        accountId: "target",
        name: "Viewer",
        locale: "en",
        preferences: { onboardingComplete: false },
      });
      milliseconds += 10_000;
      const target = new Cloud();
      for (const operation of source.rows.values())
        target.add(
          AccountSyncOperationSchema.parse({
            ...operation,
            id: randomUUID(),
            updatedAt: now().toISOString(),
          }),
        );
      source.add(
        AccountSyncOperationSchema.parse({
          id: randomUUID(),
          kind: "profile",
          action: "delete",
          profileId: original.syncId,
          entityId: original.syncId,
          updatedAt: now().toISOString(),
          payload: null,
        }),
      );
      const targetSync = new AccountSyncService(
        first.db,
        "https://target.example.com",
        target.fetch,
        now,
        {
          getCredential: async () => ({
            token: "cloud-token",
            deviceId: "target-device",
          }),
        },
      );
      if (order === "target-first") {
        expect((await targetSync.sync("target")).status).toBe("idle");
        expect((await first.service.sync("local")).status).toBe("idle");
      } else {
        expect((await first.service.sync("local")).status).toBe("idle");
        expect((await targetSync.sync("target")).status).toBe("idle");
      }
      expect(first.db.profiles.list("local")).toEqual([]);
      const moved = first.db.profiles.list("target");
      expect(moved).toHaveLength(1);
      expect(moved[0]).toMatchObject({
        syncId: original.syncId,
        name: "Alex",
        pinEnabled: false,
      });
      expect(moved[0]!.preferences.prompt).toBeUndefined();
      expect(
        (
          moved[0]!.preferences.playback as {
            audioOutputDeviceId: string | null;
          }
        ).audioOutputDeviceId,
      ).toBeNull();
      expect(first.db.library.list(moved[0]!.id)).toHaveLength(1);
      if (order === "target-first")
        expect(first.db.profiles.getPinRecord(moved[0]!.id).version).toBe(
          pinVersion + 1,
        );
      expect(
        source.pushed.filter((operation) => operation.kind === "profile"),
      ).toHaveLength(1);
    },
  );

  it("namespaces imported history IDs per profile without echoing them as new events", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    const item = title(first.db);
    first.db.history.append({
      id: "provider-event-42",
      profileId: "default",
      titleId: item.id,
      eventType: "start",
      episodeLabel: null,
      progressPercent: 0,
    });
    await first.service.sync("local");
    const profile = cloud.pushed.find(
      (operation) => operation.kind === "profile",
    )!;
    const history = cloud.pushed.find(
      (operation) => operation.kind === "history",
    )!;
    const secondProfileId = randomUUID();
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...profile,
        id: randomUUID(),
        profileId: secondProfileId,
        entityId: secondProfileId,
      }),
    );
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...history,
        id: randomUUID(),
        profileId: secondProfileId,
      }),
    );
    const before = cloud.pushed.length;
    const imported = installation(cloud);
    expect((await imported.service.sync("local")).status).toBe("idle");
    const profiles = imported.db.profiles.list("local");
    expect(profiles).toHaveLength(2);
    const events = profiles.flatMap((entry) =>
      imported.db.history.listAll(entry.id),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.id).not.toBe(events[1]!.id);
    expect(cloud.pushed).toHaveLength(before);
  });

  it("captures mutations committed during a pull before applying remote updates", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    first.db.profiles.update("default", { name: "Initial" });
    await first.service.sync("local");
    const original = cloud.pushed.find(
      (operation) => operation.kind === "profile",
    )!;
    milliseconds += 1_000;
    cloud.add(
      AccountSyncOperationSchema.parse({
        ...original,
        id: randomUUID(),
        updatedAt: now().toISOString(),
        payload: { ...original.payload, name: "Remote update" },
      }),
    );
    milliseconds += 1_000;
    let changed = false;
    const fetch: ProviderFetch = async (input, init) => {
      const response = await cloud.fetch(input, init);
      if (!changed && input.includes("/v1/sync/pull")) {
        changed = true;
        first.db.profiles.update("default", {
          name: "Committed during HTTP request",
        });
      }
      return response;
    };
    const service = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
      },
    );
    expect((await service.sync("local")).status).toBe("idle");
    expect(first.db.profiles.get("default")!.name).toBe(
      "Committed during HTTP request",
    );
    expect(cloud.pushed.at(-1)).toMatchObject({
      kind: "profile",
      payload: { name: "Committed during HTTP request" },
    });
  });

  it("retains failed push operations with jittered exponential backoff capped at fifteen minutes", async () => {
    const cloud = new Cloud();
    const first = installation(cloud);
    cloud.failPush = true;
    const service = new AccountSyncService(
      first.db,
      "https://auth.example.com",
      cloud.fetch,
      now,
      {
        getCredential: async () => ({
          token: "cloud-token",
          deviceId: "device",
        }),
        random: () => 0.5,
      },
    );
    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const startedAt = milliseconds;
      expect((await service.sync("local")).status).toBe("error");
      const pending = first.db.syncOutbox.listPending();
      // Deferred operations are deliberately absent from the eligible batch.
      expect(pending).toEqual([]);
      milliseconds += 900_001;
      const deferred = first.db.syncOutbox.listPending<AccountSyncOperation>();
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.attempts).toBe(attempt + 1);
      const delay = Date.parse(deferred[0]!.availableAt) - startedAt;
      delays.push(delay);
      expect(delay).toBeGreaterThanOrEqual(30_000);
      expect(delay).toBeLessThanOrEqual(900_000);
    }
    expect(delays[1]).toBe(delays[0]! * 2);
    expect(delays.at(-1)).toBe(900_000);
    cloud.failPush = false;
    expect((await service.sync("local")).status).toBe("idle");
    expect(first.db.syncOutbox.listPending()).toEqual([]);
  });
});
