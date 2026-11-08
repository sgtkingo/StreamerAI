import { afterEach, describe, expect, it } from "vitest";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";

import { accounts, fixture, origin } from "../../cloud/test/helpers.js";
import type { ProviderFetch } from "../src/integrations/tmdb-api-client.js";
import { AccountSyncService } from "../src/services/account-sync.js";

const DAY = 86_400_000;
const HOUSEHOLD = "11111111-1111-4111-8111-111111111111";
const OTHER_HOUSEHOLD = "22222222-2222-4222-8222-222222222222";
let cloud: ReturnType<typeof fixture> | undefined;
const databases: StreamerDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  cloud?.close();
  cloud = undefined;
});

async function pair(
  f: ReturnType<typeof fixture>,
  account = "a",
  householdId = HOUSEHOLD,
) {
  const grantResponse = await f.request("/v1/device/code", {
    method: "POST",
    data: {
      client_id: "streamer-ai-home",
      device_name: "Retention integration",
    },
  });
  const grant = (await grantResponse.json()) as {
    user_code: string;
    device_code: string;
  };
  const approved = await f.request("/v1/device/approve", {
    method: "POST",
    account,
    data: { user_code: grant.user_code, approve: true },
  });
  expect(approved.status).toBe(200);
  const redeemed = await f.request("/v1/device/token", {
    method: "POST",
    data: {
      client_id: "streamer-ai-home",
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  expect(redeemed.status).toBe(200);
  const token = (await redeemed.json()) as {
    access_token: string;
    device: { id: string };
  };
  const registered = await f.request("/v1/households", {
    method: "POST",
    token: token.access_token,
    data: {
      householdId,
      name: "Retention household",
      serverId: "retention-integration",
    },
  });
  expect(registered.status).toBe(200);
  return { token: token.access_token, deviceId: token.device.id };
}

function installation(
  f: ReturnType<typeof fixture>,
  fetcher: ProviderFetch,
  credential: () => ReturnType<typeof pair>,
) {
  const database = openStreamerDatabase({
    filename: ":memory:",
    clock: () => new Date(f.now()),
  });
  databases.push(database);
  database.accounts.ensureCloudAccount({ id: accounts.a!.id });
  const service = new AccountSyncService(
    database,
    origin,
    fetcher,
    () => new Date(f.now()),
    { getCredential: credential },
  );
  return { database, service };
}

function title(database: StreamerDatabase, id: string, timestamp: string) {
  return database.titles.upsert({
    id,
    kind: "movie",
    title: id,
    originalTitle: null,
    year: 2020,
    synopsis: "",
    genres: [],
    metadataProvider: "tmdb",
    metadataValidatedAt: timestamp,
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

describe("home client and actual identity Worker retention protocol", () => {
  it("syncs independent votes from different profiles without overwriting them", async () => {
    const f = (cloud = fixture());
    const failures: unknown[] = [];
    const fetcher: ProviderFetch = async (input, init) => {
      const response = await f.worker.fetch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        }),
        f.env,
      );
      if (!response.ok)
        failures.push({
          path: new URL(input).pathname,
          status: response.status,
          body: await response.clone().json(),
        });
      return response;
    };
    const credential = await pair(f);
    const first = installation(f, fetcher, async () => credential);
    const second = installation(f, fetcher, async () => credential);
    const a = first.database.profiles.create({
      id: "a",
      name: "A",
      locale: "cs",
    });
    const b = first.database.profiles.create({
      id: "b",
      name: "B",
      locale: "cs",
    });
    const base = {
      titleId: "movie",
      providerId: "webshare",
      candidateId: "file",
      seasonNumber: null,
      episodeNumber: null,
    };
    first.database.sourceFeedback.set("local", {
      ...base,
      profileId: a.syncId,
      vote: "up",
    });
    first.database.sourceFeedback.set("local", {
      ...base,
      profileId: b.syncId,
      vote: "down",
    });
    const result = await first.service.sync("local");
    expect(failures).toEqual([]);
    expect(result.status).toBe("idle");
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(
      second.database.sourceFeedback.list("local").map((item) => item.payload),
    ).toEqual(
      expect.arrayContaining([
        { ...base, profileId: a.syncId, vote: "up" },
        { ...base, profileId: b.syncId, vote: "down" },
      ]),
    );
    f.advance(1000);
    second.database.sourceFeedback.set("local", {
      ...base,
      profileId: b.syncId,
      vote: null,
    });
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    expect(
      first.database.sourceFeedback.list("local").map((item) => item.payload),
    ).toEqual(
      expect.arrayContaining([
        { ...base, profileId: a.syncId, vote: "up" },
        { ...base, profileId: b.syncId, vote: null },
      ]),
    );
  });
  it("syncs account feedback without profile ownership, resolves offline edits and preserves clear votes", async () => {
    const f = (cloud = fixture());
    const fetcher: ProviderFetch = async (input, init) =>
      f.worker.fetch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        }),
        f.env,
      );
    const credential = await pair(f);
    const first = installation(f, fetcher, async () => credential);
    first.database.profiles.create({
      id: "rater",
      name: "Rater",
      locale: "cs",
    });
    const vote = {
      profileId: first.database.profiles.get("rater")!.syncId,
      titleId: "sai:tmdb:series:42",
      providerId: "webshare",
      candidateId: "file-1",
      seasonNumber: 1,
      episodeNumber: 2,
      vote: "up" as const,
    };
    first.database.profiles.create({
      id: "disabled",
      name: "Disabled",
      locale: "cs",
      preferences: { sourceFeedbackEnabled: false },
    });
    first.database.sourceFeedback.set("local", vote);
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    first.database.profiles.delete("rater");
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    // A fresh snapshot must recover feedback even though its originating profile is gone.
    const second = installation(f, fetcher, async () => credential);
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(second.database.sourceFeedback.list("local")[0]?.payload).toEqual(
      vote,
    );
    expect(
      second.database.profiles.list()[0]?.preferences.sourceFeedbackEnabled,
    ).toBe(false);
    f.advance(1000);
    second.database.sourceFeedback.set("local", { ...vote, vote: "down" });
    second.service.capture("local");
    expect((await second.service.sync("local")).status).toBe("idle");
    f.advance(1000);
    first.database.sourceFeedback.set("local", { ...vote, vote: null });
    first.service.capture("local");
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(
      second.database.sourceFeedback.list("local")[0]?.payload.vote,
    ).toBeNull();
    const count = Number(
      (
        f.sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM cloud_household_sync_account_entity WHERE account_id = ?",
          )
          .get(HOUSEHOLD) as { n: number }
      ).n,
    );
    expect(count).toBe(1);
    const otherCredential = await pair(f, "b", OTHER_HOUSEHOLD);
    const other = await f.request("/v1/sync/pull?after=0", {
      token: otherCredential.token,
    });
    expect(other.status).toBe(200);
    expect(
      ((await other.json()) as { operations: unknown[] }).operations,
    ).toEqual([]);
    // The payload is only the judgement and opaque identifiers, never release names/URLs/secrets.
    const row = f.sqlite
      .prepare("SELECT operation_json FROM cloud_household_sync_account_entity")
      .get() as { operation_json: string };
    expect(JSON.parse(row.operation_json).payload).toEqual({
      ...vote,
      vote: null,
    });
  });
  it("reconnects after ninety days, retains offline edits and never revives a deleted profile", async () => {
    const f = (cloud = fixture());
    const responses: Array<{ path: string; status: number }> = [];
    const fetcher: ProviderFetch = async (input, init) => {
      const response = await f.worker.fetch(
        new Request(input, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: init.signal,
        }),
        f.env,
      );
      responses.push({
        path: new URL(input).pathname,
        status: response.status,
      });
      return response;
    };
    let firstCredential = await pair(f);
    let secondCredential = await pair(f);
    const first = installation(f, fetcher, async () => firstCredential);
    first.database.profiles.create({
      id: "alex",
      name: "Alex",
      locale: "cs",
      preferences: { onboardingComplete: true },
    });
    first.database.profiles.create({
      id: "removed",
      name: "Removed profile",
      locale: "cs",
    });
    const originalTitle = title(
      first.database,
      "tmdb:movie:1",
      new Date(f.now()).toISOString(),
    );
    first.database.library.upsert({
      profileId: "alex",
      titleId: originalTitle.id,
      membershipReason: "explicit",
    });
    first.database.history.append({
      id: "watched",
      profileId: "alex",
      titleId: originalTitle.id,
      eventType: "start",
      episodeLabel: null,
      progressPercent: 12,
    });
    first.database.playbackPositions.upsert({
      profileId: "alex",
      titleId: originalTitle.id,
      seasonNumber: null,
      episodeNumber: null,
      positionSeconds: 120,
      durationSeconds: 1000,
      progressPercent: 12,
      updatedAt: new Date(f.now()).toISOString(),
    });
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });

    const second = installation(f, fetcher, async () => secondCredential);
    second.database.profiles.create({
      id: "default",
      name: "Viewer",
      locale: "en",
    });
    expect((await second.service.sync("local")).status).toBe("idle");
    const alex = second.database.profiles
      .list()
      .find((profile) => profile.name === "Alex")!;
    const removed = second.database.profiles
      .list()
      .find((profile) => profile.name === "Removed profile")!;
    expect(second.database.library.list(alex.id)).toHaveLength(1);
    expect(second.database.history.listAll(alex.id)).toHaveLength(1);

    f.advance(1000);
    first.database.profiles.delete("removed");
    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    const before = f.sqlite
      .prepare("SELECT COUNT(*) AS n FROM cloud_household_sync_entity")
      .get();
    f.advance(91 * DAY);
    // A returning installation reauthorizes its expired 30-day device token.
    firstCredential = await pair(f);
    secondCredential = await pair(f);
    second.database.profiles.update(alex.id, { name: "Alex offline" });
    second.database.profiles.update(removed.id, { name: "Must not resurrect" });
    const offlineTitle = title(
      second.database,
      "tmdb:movie:2",
      new Date(f.now()).toISOString(),
    );
    second.database.library.upsert({
      profileId: alex.id,
      titleId: offlineTitle.id,
      membershipReason: "explicit",
    });
    second.service.capture("local");
    expect(second.database.syncOutbox.listPending().length).toBeGreaterThan(0);

    await f.worker.scheduled({} as never, f.env);
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM cloud_household_sync_log")
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM cloud_household_sync_operation_receipt",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS n FROM cloud_household_sync_entity")
        .get(),
    ).toEqual(before);
    const start = responses.length;
    expect((await second.service.sync("local")).status).toBe("idle");
    expect(responses.slice(start)).toContainEqual({
      path: "/v1/sync/pull",
      status: 410,
    });
    expect(responses.slice(start)).toContainEqual({
      path: "/v1/sync/snapshot",
      status: 200,
    });
    expect(second.database.profiles.getBySyncId(removed.syncId)).toBeNull();
    expect(second.database.profiles.get(alex.id)?.name).toBe("Alex offline");
    expect(
      second.database.library
        .list(alex.id)
        .map((item) => item.titleId)
        .sort(),
    ).toEqual([originalTitle.id, offlineTitle.id]);
    expect(second.database.history.listAll(alex.id)).toHaveLength(1);
    expect(
      second.database.playbackPositions.get(alex.id, originalTitle.id)
        ?.positionSeconds,
    ).toBe(120);
    expect(second.database.syncOutbox.listPending()).toEqual([]);

    expect(await first.service.sync("local")).toMatchObject({ status: "idle" });
    expect(first.database.profiles.get("alex")?.name).toBe("Alex offline");
    expect(first.database.profiles.list()).toHaveLength(1);
    expect(first.database.library.list("alex")).toHaveLength(2);
    expect(f.sqlite.prepare("SELECT COUNT(*) AS n FROM user").get()).toEqual({
      n: 3,
    });
    expect(
      f.sqlite
        .prepare("SELECT active FROM cloud_household_sync_profile WHERE id = ?")
        .get(removed.syncId),
    ).toEqual({ active: 0 });
  });
});
