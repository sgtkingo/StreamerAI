import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";

import { cursor } from "../src/sync.js";
import { accounts, fixture } from "./helpers.js";

const DAY = 86_400_000;
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());

function profile(profileId = "retained-profile"): AccountSyncOperation {
  const { audioOutputDeviceId: _device, ...playback } =
    DEFAULT_PLAYBACK_PREFERENCES;
  return {
    id: crypto.randomUUID(),
    profileId,
    entityId: profileId,
    kind: "profile",
    action: "upsert",
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      name: "Retained profile",
      locale: "cs",
      genres: [],
      playback,
      appearance: DEFAULT_APPEARANCE_PREFERENCES,
      onboardingComplete: true,
    },
  };
}

function library(): AccountSyncOperation {
  return {
    id: crypto.randomUUID(),
    profileId: "retained-profile",
    entityId: "tmdb:movie:1",
    kind: "library",
    action: "upsert",
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      title: {
        id: "tmdb:movie:1",
        kind: "movie",
        title: "Retained title",
        originalTitle: null,
        year: 2020,
        synopsis: "",
        genres: [],
        metadataProvider: "tmdb",
        metadataValidatedAt: new Date(f.now()).toISOString(),
      },
      membershipReason: "explicit",
      state: "saved",
      progressPercent: null,
      lastPlayedAt: null,
    },
  };
}

async function push(operations: AccountSyncOperation[], account = "a") {
  const response = await f.request("/v1/sync/push", {
    method: "POST",
    account,
    data: { operations },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ cursor: string }>;
}

async function cleanup() {
  await f.worker.scheduled({} as ScheduledController, f.env);
}

async function getSnapshot(after?: string) {
  return f.request(
    "/v1/sync/snapshot" + (after ? "?after=" + encodeURIComponent(after) : ""),
    { account: "a" },
  );
}

describe("sync retention", () => {
  it("timestamps receipts inserted by the previous Worker during migration rollout", async () => {
    const before = Date.now() - 1000;
    f.sqlite
      .prepare(
        "INSERT INTO cloud_operation_receipt (account_id, operation_id, operation_hash) VALUES (?, ?, ?)",
      )
      .run(accounts.a!.id, "previous-worker-operation", "operation-hash");
    const stored = f.sqlite
      .prepare("SELECT created_at FROM cloud_operation_receipt")
      .get() as { created_at: number };
    expect(stored.created_at).toBeGreaterThanOrEqual(before);
    expect(stored.created_at).toBeLessThanOrEqual(Date.now());
    await cleanup();
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM cloud_operation_receipt")
        .get(),
    ).toEqual({ n: 1 });
  });

  it("prunes only logs and receipts strictly older than ninety days", async () => {
    const first = profile();
    await push([first]);
    f.advance(1);
    const second = library();
    await push([second]);
    f.advance(90 * DAY - 1);
    await cleanup();
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM cloud_sync_log").get(),
    ).toEqual({ n: 2 });
    f.advance(1);
    await cleanup();
    expect(
      f.sqlite.prepare("SELECT operation_id FROM cloud_sync_log").all(),
    ).toEqual([{ operation_id: second.id }]);
    expect(
      f.sqlite
        .prepare("SELECT operation_id FROM cloud_operation_receipt")
        .all(),
    ).toEqual([{ operation_id: second.id }]);
    expect(
      f.sqlite.prepare("SELECT pruned_through FROM cloud_sync_retention").get(),
    ).toEqual({ pruned_through: 1 });
  });

  it("preserves current entities, deleted-profile tombstones, owners and Google identities", async () => {
    await push([profile(), library(), profile("deleted-profile")]);
    f.advance(1);
    await push([
      { ...profile("deleted-profile"), action: "delete", payload: null },
    ]);
    f.sqlite
      .prepare(
        `INSERT INTO session
      (id, "expiresAt", token, "createdAt", "updatedAt", "userId") VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "retained-session",
        f.now() + 100 * DAY,
        "session-token",
        f.now(),
        f.now(),
        accounts.a!.id,
      );
    const entities = f.sqlite
      .prepare("SELECT * FROM cloud_entity ORDER BY rowid")
      .all();
    const profiles = f.sqlite
      .prepare("SELECT * FROM cloud_profile ORDER BY id")
      .all();
    f.advance(90 * DAY + 1);
    await cleanup();
    expect(
      f.sqlite.prepare("SELECT COUNT(*) AS n FROM cloud_sync_log").get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite.prepare("SELECT * FROM cloud_entity ORDER BY rowid").all(),
    ).toEqual(entities);
    expect(
      f.sqlite.prepare("SELECT * FROM cloud_profile ORDER BY id").all(),
    ).toEqual(profiles);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({
      n: 3,
    });
    expect(f.sqlite.prepare('SELECT id FROM "session"').all()).toEqual([
      { id: "retained-session" },
    ]);
    const page = (await (await getSnapshot()).json()) as {
      operations: AccountSyncOperation[];
    };
    expect(
      page.operations.find(
        (operation) => operation.profileId === "deleted-profile",
      ),
    ).toMatchObject({ action: "delete", payload: null });
    const resurrection = await f.request("/v1/sync/push", {
      method: "POST",
      account: "a",
      data: { operations: [profile("deleted-profile")] },
    });
    expect(await resurrection.json()).toEqual({ error: "profile_deleted" });
  });

  it("keeps the cursor monotonic after pruning every log and expires old delta cursors", async () => {
    const initial = await push([profile(), library()]);
    f.advance(90 * DAY + 1);
    await cleanup();
    expect(await cursor(f.env, accounts.a!.id)).toBe(initial.cursor);
    const expired = await f.request("/v1/sync/pull?after=0", { account: "a" });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "cursor_expired" });
    const current = await f.request("/v1/sync/pull?after=" + initial.cursor, {
      account: "a",
    });
    expect(await current.json()).toEqual({
      cursor: initial.cursor,
      operations: [],
      hasMore: false,
    });
    const update = library();
    const latest = await push([update]);
    expect(Number(latest.cursor)).toBeGreaterThan(Number(initial.cursor));
    expect(
      await (
        await f.request("/v1/sync/pull?after=" + initial.cursor, {
          account: "a",
        })
      ).json(),
    ).toMatchObject({
      cursor: latest.cursor,
      operations: [{ id: update.id }],
    });
    await cleanup();
    expect(await cursor(f.env, accounts.a!.id)).toBe(latest.cursor);
  });

  it("rejects overtaken snapshot pages and lets a fresh snapshot finish from the retained state", async () => {
    await push([profile(), library()]);
    const oldPage = (await (await getSnapshot()).json()) as { cursor: string };
    f.advance(1);
    const changed = profile();
    await push([changed]);
    f.advance(90 * DAY + 1);
    await cleanup();
    const expired = await getSnapshot(oldPage.cursor);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "cursor_expired" });
    const fresh = (await (await getSnapshot()).json()) as {
      cursor: string;
      operations: AccountSyncOperation[];
    };
    expect(fresh.operations.map((operation) => operation.id)).toEqual([
      changed.id,
    ]);
    const last = (await (await getSnapshot(fresh.cursor)).json()) as {
      cursor: string;
      hasMore: boolean;
      operations: AccountSyncOperation[];
    };
    expect(last.operations.map((operation) => operation.kind)).toEqual([
      "library",
    ]);
    expect(last.hasMore).toBe(false);
    expect(last.cursor).toBe(await cursor(f.env, accounts.a!.id));
    expect(
      (await f.request("/v1/sync/pull?after=" + last.cursor, { account: "a" }))
        .status,
    ).toBe(200);
  });

  it("reads retention metadata and delta rows atomically when cleanup wins a concurrent pull", async () => {
    await push([profile(), library()]);
    f.advance(90 * DAY + 1);
    const originalBatch = f.db.batch.bind(f.db);
    let pruned = false;
    f.db.batch = async (statements) => {
      if (!pruned) {
        pruned = true;
        await cleanup();
      }
      return originalBatch(statements);
    };
    const response = await f.request("/v1/sync/pull?after=0", { account: "a" });
    expect(pruned).toBe(true);
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "cursor_expired" });
  });

  it("accepts transfers after source and target logs were compacted and keeps source ownership tombstones", async () => {
    await push([profile(), library()]);
    await push([profile("target-profile")], "b");
    f.advance(90 * DAY + 1);
    await cleanup();
    const sourceCursor = await cursor(f.env, accounts.a!.id);
    const targetCursor = await cursor(f.env, accounts.b!.id);
    const transfer = (await (
      await f.request("/v1/transfers", {
        method: "POST",
        account: "a",
        data: { profileId: "retained-profile", targetEmail: accounts.b!.email },
      })
    ).json()) as { id: string };
    const response = await f.request(`/v1/transfers/${transfer.id}/accept`, {
      method: "POST",
      account: "b",
      data: {},
    });
    expect(await response.json()).toEqual({
      ok: true,
      profileId: "retained-profile",
    });
    expect(Number(await cursor(f.env, accounts.a!.id))).toBeGreaterThan(
      Number(sourceCursor),
    );
    expect(Number(await cursor(f.env, accounts.b!.id))).toBeGreaterThan(
      Number(targetCursor),
    );
    f.advance(90 * DAY + 1);
    await cleanup();
    const page = (await (await getSnapshot()).json()) as {
      operations: AccountSyncOperation[];
    };
    expect(page.operations).toMatchObject([
      { profileId: "retained-profile", action: "delete" },
    ]);
    const wrongOwner = await f.request("/v1/sync/push", {
      method: "POST",
      account: "a",
      data: { operations: [profile()] },
    });
    expect(await wrongOwner.json()).toEqual({ error: "profile_not_owned" });
  });

  it("starts existing receipts at migration time because their original age is unknown", () => {
    const legacy = new Database(":memory:");
    try {
      for (const name of ["0001_identity.sql", "0002_sync.sql"]) {
        legacy.exec(
          readFileSync(
            new URL(`../migrations/${name}`, import.meta.url),
            "utf8",
          ),
        );
      }
      legacy
        .prepare(
          'INSERT INTO "user" (id, email, name, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
        )
        .run("old-user", "old@example.test", "Old", 0, 0);
      legacy
        .prepare(
          "INSERT INTO cloud_operation_receipt (account_id, operation_id, operation_hash) VALUES (?, ?, ?)",
        )
        .run("old-user", "old-operation", "old-hash");
      const before = Date.now() - 1000;
      legacy.exec(
        readFileSync(
          new URL("../migrations/0003_sync_retention.sql", import.meta.url),
          "utf8",
        ),
      );
      const stored = legacy
        .prepare("SELECT created_at FROM cloud_operation_receipt")
        .get() as { created_at: number };
      expect(stored.created_at).toBeGreaterThanOrEqual(before);
      expect(stored.created_at).toBeLessThanOrEqual(Date.now());
    } finally {
      legacy.close();
    }
  });
});
