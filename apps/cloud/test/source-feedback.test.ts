import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  ACCOUNT_SYNC_SCOPE,
  type AccountSyncOperation,
  type SourceFeedback,
} from "@streamer-ai/contracts";
import { accounts, fixture } from "./helpers.js";

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});
afterEach(() => f.close());

function feedback(
  vote: SourceFeedback["vote"] = "up",
  candidateId = "file-1",
): AccountSyncOperation {
  const payload: SourceFeedback = {
    profileId: "profile-one",
    titleId: "sai:tmdb:movie:42",
    providerId: "webshare",
    candidateId,
    seasonNumber: null,
    episodeNumber: null,
    vote,
  };
  return {
    id: randomUUID(),
    profileId: ACCOUNT_SYNC_SCOPE,
    kind: "source-feedback",
    entityId: createHash("sha256")
      .update(
        JSON.stringify([
          payload.profileId,
          payload.titleId,
          payload.providerId,
          payload.candidateId,
          null,
          null,
        ]),
      )
      .digest("hex"),
    action: "upsert",
    payload,
    updatedAt: new Date(f.now()).toISOString(),
  };
}
const push = (operation: unknown, account = "a") =>
  f.request("/v1/sync/push", {
    method: "POST",
    account,
    data: { operations: [operation] },
  });

it("removes legacy cloud votes and advances the cursor floor without removing other data", async () => {
  const vote = feedback();
  expect((await push(vote)).status).toBe(200);
  const oldSequence = (
    f.sqlite.prepare("SELECT MAX(seq) AS seq FROM cloud_sync_log").get() as {
      seq: number;
    }
  ).seq;
  f.sqlite.exec(
    readFileSync(
      new URL(
        "../migrations/0008_profile_source_feedback.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  expect(f.sqlite.prepare("SELECT * FROM cloud_account_entity").all()).toEqual(
    [],
  );
  expect(
    f.sqlite
      .prepare("SELECT * FROM cloud_sync_log WHERE kind = 'source-feedback'")
      .all(),
  ).toEqual([]);
  expect(
    f.sqlite
      .prepare(
        "SELECT pruned_through FROM cloud_sync_retention WHERE account_id = ?",
      )
      .get(accounts.a!.id),
  ).toEqual({ pruned_through: oldSequence });
  expect(
    (await f.request("/v1/sync/pull?after=0", { account: "a" })).status,
  ).toBe(410);
  const oldOperation = { ...vote, payload: { ...vote.payload } };
  delete (oldOperation.payload as { profileId?: string }).profileId;
  expect(() =>
    f.sqlite
      .prepare(
        `INSERT INTO cloud_account_entity (account_id, kind, entity_id, operation_id, action, updated_at, operation_json) VALUES (?, 'source-feedback', 'legacy', 'legacy', 'upsert', ?, ?)`,
      )
      .run(accounts.a!.id, vote.updatedAt, JSON.stringify(oldOperation)),
  ).toThrow("feedback_profile_required");
});

it("enforces account scope and stable feedback identity without creating a profile", async () => {
  const vote = feedback();
  expect((await push({ ...vote, profileId: "some-profile" })).status).toBe(400);
  expect((await push({ ...vote, entityId: "fake-identity" })).status).toBe(400);
  expect(
    (
      await push({
        ...vote,
        payload: { ...vote.payload, directUrl: "https://example.test/file" },
      })
    ).status,
  ).toBe(400);
  expect((await push(vote)).status).toBe(200);
  expect(
    f.sqlite.prepare("SELECT COUNT(*) AS n FROM cloud_profile").get(),
  ).toEqual({ n: 0 });
  expect(
    f.sqlite.prepare("SELECT account_id FROM cloud_account_entity").get(),
  ).toEqual({ account_id: accounts.a!.id });
  expect(
    (
      (await (
        await f.request("/v1/sync/pull?after=0", { account: "b" })
      ).json()) as { operations: unknown[] }
    ).operations,
  ).toEqual([]);
});

it("retains the latest vote when accounts merge, including neutral clears and independent files", async () => {
  // A has Google login and B has implicit e-mail login, so B survives the merge.
  f.sqlite
    .prepare(
      `INSERT INTO account (id, accountId, providerId, userId, createdAt, updatedAt) VALUES ('google', 'subject', 'google', ?, ?, ?)`,
    )
    .run(accounts.a!.id, f.now(), f.now());
  const old = feedback("up");
  expect((await push(old, "a")).status).toBe(200);
  const independent = feedback("down", "file-2");
  expect((await push(independent, "a")).status).toBe(200);
  f.advance(1000);
  const cleared = feedback(null);
  expect((await push(cleared, "b")).status).toBe(200);
  const request = await f.request("/v1/merges", {
    method: "POST",
    account: "a",
    data: { target: accounts.b!.id },
  });
  expect(request.status).toBe(201);
  const merge = (await request.json()) as { id: string };
  const approved = await f.request(`/v1/merges/${merge.id}/decision`, {
    method: "POST",
    account: "b",
    data: { approve: true, profileIds: [], expectedProfileIds: [] },
  });
  expect(approved.status).toBe(200);
  const rows = f.sqlite
    .prepare(
      "SELECT account_id, operation_json FROM cloud_account_entity ORDER BY entity_id",
    )
    .all() as Array<{ account_id: string; operation_json: string }>;
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.account_id === accounts.b!.id)).toBe(true);
  const operations = rows.map((row) => JSON.parse(row.operation_json));
  expect(operations).toEqual(expect.arrayContaining([cleared, independent]));
  const delta = (await (
    await f.request("/v1/sync/pull?after=0", { account: "b" })
  ).json()) as { operations: AccountSyncOperation[] };
  expect(delta.operations).toEqual(
    expect.arrayContaining([cleared, independent]),
  );
});
