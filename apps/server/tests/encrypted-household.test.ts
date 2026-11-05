import { randomBytes, scryptSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  openStreamerDatabase,
  type StreamerDatabase,
} from "@streamer-ai/database";
import { type EncryptedHouseholdEnvelope } from "@streamer-ai/contracts";
import { accountSecretKey } from "../src/stores/account-integrations.js";
import { NonPersistentMemorySecretStore } from "../src/stores/secret-store.js";
import { EncryptedHouseholdService } from "../src/services/encrypted-household.js";
import { EncryptedCheckpointTransport } from "../src/services/encrypted-sync-transport.js";

const databases: StreamerDatabase[] = [];
const now = () => new Date("2026-11-04T12:00:00.000Z");
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function installation(secrets = new NonPersistentMemorySecretStore()) {
  const database = openStreamerDatabase({ filename: ":memory:", clock: now });
  databases.push(database);
  return {
    database,
    secrets,
    service: new EncryptedHouseholdService(database, secrets, now),
  };
}
async function source() {
  const result = installation();
  const { database: db, secrets, service } = result;
  db.profiles.create({
    id: "viewer",
    name: "Private Alice",
    locale: "cs",
    preferences: {
      prompt: "Private taste prompt",
      onboardingComplete: true,
      appearance: { theme: "dark" },
      playback: { audioOutputDeviceId: "local-speaker" },
    },
  });
  const salt = randomBytes(16).toString("hex");
  const pinHash = `${salt}:${scryptSync("1234", salt, 32).toString("hex")}`;
  db.profiles.setPinHash("viewer", pinHash);
  db.titles.upsert({
    id: "tmdb:movie:42",
    kind: "movie",
    title: "Private saved title",
    originalTitle: null,
    year: 2026,
    synopsis: "Example",
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
  db.library.upsert({
    profileId: "viewer",
    titleId: "tmdb:movie:42",
    membershipReason: "explicit",
    state: "in-progress",
    progressPercent: 25,
  });
  db.history.append({
    id: "event",
    profileId: "viewer",
    titleId: "tmdb:movie:42",
    eventType: "progress",
    episodeLabel: null,
    progressPercent: 25,
  });
  db.playbackPositions.upsert({
    profileId: "viewer",
    titleId: "tmdb:movie:42",
    seasonNumber: null,
    episodeNumber: null,
    positionSeconds: 250,
    durationSeconds: 1000,
    progressPercent: 25,
  });
  db.integrations.upsert(
    {
      id: "tmdb",
      enabled: true,
      setupStatus: "ready",
      healthStatus: "healthy",
    },
    "viewer",
  );
  db.sourceFeedback.set("local", {
    profileId: db.profiles.getRequired("viewer").syncId,
    titleId: "tmdb:movie:42",
    providerId: "provider",
    candidateId: "candidate",
    seasonNumber: null,
    episodeNumber: null,
    vote: "up",
  });
  await secrets.set(
    accountSecretKey("local", "integration.tmdb.read-token"),
    "PRIVATE-TMDB-TOKEN",
  );
  await secrets.set(
    accountSecretKey("local", "integration.webshare.wst"),
    "PRIVATE-PROVIDER-SESSION",
  );
  await secrets.set("account.cloud.token", "EXCLUDED-CLOUD-TOKEN");
  const activation = await service.activate("local");
  return {
    ...result,
    pinHash,
    key: activation.recoveryKey,
    envelope: await service.export("local"),
  };
}

describe("encrypted household recovery", () => {
  it("recovers complete registered profile records and portable secrets into a fresh vault without cloud access", async () => {
    const original = await source();
    const destination = installation();
    const serialized = JSON.stringify(original.envelope);
    for (const secret of [
      "Private Alice",
      "Private taste prompt",
      "PRIVATE-TMDB-TOKEN",
      "PRIVATE-PROVIDER-SESSION",
      original.pinHash,
      "Private saved title",
      original.key,
      "EXCLUDED-CLOUD-TOKEN",
    ])
      expect(serialized).not.toContain(secret);
    const preview = destination.service.preview(
      original.envelope,
      original.key,
    );
    expect(preview.profiles).toEqual([
      { name: "Private Alice", locale: "cs", pinEnabled: true },
    ]);
    expect(JSON.stringify(preview)).not.toContain("PRIVATE-TMDB-TOKEN");
    expect(preview.limitations.length).toBeGreaterThan(0);
    const restored = await destination.service.restore(
      "local",
      original.envelope,
      original.key,
    );
    const id = restored.profileIds[0]!;
    const profile = destination.database.profiles.getRequired(id);
    expect(id).not.toBe("viewer");
    expect(profile.preferences.prompt).toBe("Private taste prompt");
    expect(profile.preferences.playback).not.toHaveProperty(
      "audioOutputDeviceId",
    );
    expect(destination.database.profiles.getPinRecord(id).hash).toBe(
      original.pinHash,
    );
    expect(destination.database.library.list(id)).toHaveLength(1);
    expect(destination.database.history.listAll(id)).toHaveLength(1);
    expect(
      destination.database.playbackPositions.list(id)[0]?.positionSeconds,
    ).toBe(250);
    expect(
      destination.database.sourceFeedback.list("local")[0]?.payload.profileId,
    ).toBe(profile.syncId);
    expect(
      await destination.secrets.get(
        accountSecretKey("local", "integration.tmdb.read-token"),
      ),
    ).toBe("PRIVATE-TMDB-TOKEN");
    expect(
      await destination.secrets.get("account.cloud.token"),
    ).toBeUndefined();
    expect(destination.service.status("local")).toMatchObject({
      enabled: true,
      approvalAvailable: false,
      automaticMergeAvailable: false,
    });
    expect(
      await destination.service.restore(
        "local",
        original.envelope,
        original.key,
      ),
    ).toEqual(restored);
    expect(destination.database.profiles.count()).toBe(1);
    const second = await destination.service.export("local");
    expect(second.sequence).toBe(original.envelope.sequence + 1);
    expect(destination.service.preview(second, original.key).profiles).toEqual(
      preview.profiles,
    );
  });

  it("rejects wrong keys, modified ciphertext and every substituted authenticated header before writing", async () => {
    const original = await source();
    const destination = installation();
    const wrongKey = `STRM-R1-${randomBytes(32).toString("base64url")}`;
    await expect(
      destination.service.restore("local", original.envelope, wrongKey),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_AUTHENTICATION_FAILED" });
    const mutations: Array<(e: EncryptedHouseholdEnvelope) => void> = [
      (e) => {
        e.datasetId = "2c2c5c15-b8e8-4dd0-9df3-6a3ad7569a62";
      },
      (e) => {
        e.sequence++;
      },
      (e) => {
        e.keyVersion++;
      },
      (e) => {
        e.recoveryVersion++;
      },
      (e) => {
        e.snapshotId = "f88519b6-afaa-41ba-b4dd-30f6cf073841";
      },
      (e) => {
        e.createdAt = "2026-11-05T12:00:00.000Z";
      },
      (e) => {
        e.payload.ciphertext =
          (e.payload.ciphertext[0] === "A" ? "B" : "A") +
          e.payload.ciphertext.slice(1);
      },
      (e) => {
        e.payload.tag = "AAAAAAAAAAAAAAAAAAAAAA";
      },
      (e) => {
        e.recovery.ciphertext = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(original.envelope);
      mutate(tampered);
      await expect(
        destination.service.restore("local", tampered, original.key),
      ).rejects.toBeInstanceOf(Error);
    }
    expect(destination.database.profiles.count()).toBe(0);
    expect(
      await destination.secrets.has(
        accountSecretKey("local", "integration.tmdb.read-token"),
      ),
    ).toBe(false);
  });

  it("rotates the recovery wrapper, preserves independent old exports and uses fresh nonces", async () => {
    const original = await source();
    const changed = await original.service.rotateRecoveryKey("local");
    const next = await original.service.export("local");
    expect(next.recoveryVersion).toBe(2);
    expect(next.payload.nonce).not.toBe(original.envelope.payload.nonce);
    expect(next.recovery.nonce).not.toBe(original.envelope.recovery.nonce);
    expect(() => original.service.preview(next, original.key)).toThrow(
      "HOUSEHOLD_AUTHENTICATION_FAILED",
    );
    expect(
      original.service.preview(next, changed.recoveryKey).profiles,
    ).toHaveLength(1);
    expect(
      original.service.preview(original.envelope, original.key).profiles,
    ).toHaveLength(1);
    expect(() =>
      original.service.preview(original.envelope, changed.recoveryKey),
    ).toThrow("HOUSEHOLD_AUTHENTICATION_FAILED");
  });

  it("rejects overwrites of existing households and credentials", async () => {
    const original = await source();
    const destination = installation();
    destination.database.profiles.create({
      id: "existing",
      name: "Existing",
      locale: "en",
    });
    await expect(
      destination.service.restore("local", original.envelope, original.key),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_RESTORE_REQUIRES_EMPTY_ACCOUNT",
    });
    expect(destination.database.profiles.getRequired("existing").name).toBe(
      "Existing",
    );
    destination.database.profiles.delete("existing");
    await destination.secrets.set(
      accountSecretKey("local", "integration.tmdb.read-token"),
      "existing-token",
    );
    await expect(
      destination.service.restore("local", original.envelope, original.key),
    ).rejects.toMatchObject({ code: "HOUSEHOLD_CREDENTIAL_CONFLICT" });
    expect(
      await destination.secrets.get(
        accountSecretKey("local", "integration.tmdb.read-token"),
      ),
    ).toBe("existing-token");
  });

  it("restores over the unused first-run Viewer but preserves a configured Viewer", async () => {
    const original = await source();
    const destination = installation();
    destination.database.profiles.create({
      id: "default",
      name: "Viewer",
      locale: "en",
      preferences: {},
    });
    const imported = await destination.service.restore(
      "local",
      original.envelope,
      original.key,
    );
    expect(imported.profileIds).toHaveLength(1);
    expect(destination.database.profiles.get("default")).toBeNull();
    const configured = installation();
    configured.database.profiles.create({
      id: "default",
      name: "Viewer",
      locale: "en",
      preferences: {},
    });
    configured.database.settings.set("setup.completed", true);
    await expect(
      configured.service.restore("local", original.envelope, original.key),
    ).rejects.toMatchObject({
      code: "HOUSEHOLD_RESTORE_REQUIRES_EMPTY_ACCOUNT",
    });
    expect(configured.database.profiles.get("default")).not.toBeNull();
  });

  it("compensates failed vault writes and allows a clean retry", async () => {
    class FailingStore extends NonPersistentMemorySecretStore {
      fail = true;
      override async set(key: string, value: string) {
        if (this.fail && key.endsWith("integration.webshare.wst"))
          throw new Error("vault failure");
        return super.set(key, value);
      }
    }
    const original = await source();
    const store = new FailingStore();
    const destination = installation(store);
    await expect(
      destination.service.restore("local", original.envelope, original.key),
    ).rejects.toThrow("vault failure");
    expect(destination.database.profiles.count()).toBe(0);
    expect(
      await store.has(accountSecretKey("local", "integration.tmdb.read-token")),
    ).toBe(false);
    store.fail = false;
    expect(
      (
        await destination.service.restore(
          "local",
          original.envelope,
          original.key,
        )
      ).profileIds,
    ).toHaveLength(1);
  });
});

describe("opaque checkpoint transport", () => {
  it("sends only encrypted envelopes and a revision, rejects stale acknowledgements and HTTPS downgrades", async () => {
    const original = await source();
    let request = "";
    const transport = new EncryptedCheckpointTransport(
      "https://cloud.example.test",
      async (_url, init) => {
        request = String(init?.body);
        expect(init?.redirect).toBe("manual");
        return Response.json({ revision: 1 });
      },
    );
    expect(
      await transport.write(
        { token: "cloud-token", deviceId: "server" },
        0,
        original.envelope,
      ),
    ).toEqual({ revision: 1 });
    expect(request).not.toContain("PRIVATE-TMDB-TOKEN");
    expect(request).not.toContain("Private Alice");
    expect(request).not.toContain(original.key);
    await expect(
      transport.write(
        { token: "cloud-token", deviceId: "server" },
        1,
        original.envelope,
      ),
    ).rejects.toMatchObject({ code: "INVALID_ENCRYPTED_SYNC_RESPONSE" });
    expect(
      () => new EncryptedCheckpointTransport("http://cloud.example.test"),
    ).toThrow("ENCRYPTED_SYNC_REQUIRES_HTTPS");
  });
});
