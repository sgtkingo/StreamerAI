import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_ACCOUNT_ID,
  MIGRATIONS,
  ProfileLimitError,
  openStreamerDatabase,
  type StreamerDatabase,
} from "../src/index.js";

const opened: StreamerDatabase[] = [];
const directories: string[] = [];
let now = new Date("2026-11-01T10:00:00.000Z");
function database(): StreamerDatabase {
  const db = openStreamerDatabase({ filename: ":memory:", clock: () => now });
  opened.push(db);
  return db;
}
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  now = new Date("2026-11-01T10:00:00.000Z");
});

describe("account ownership", () => {
  it("claims legacy installation once and never relinks another owner's account", () => {
    const db = database();
    const legacy = db.profiles.create({
      id: "default",
      name: "Viewer",
      locale: "cs",
    });
    const owner = db.accounts.ensureCloudAccount({
      id: "google-owner",
      email: "owner@example.com",
    });
    expect(owner.id).toBe(LOCAL_ACCOUNT_ID);
    expect(db.profiles.get("default")?.accountId).toBe(owner.id);
    expect(db.profiles.get("default")?.syncId).toBe(legacy.syncId);
    expect(db.accounts.ensureCloudAccount({ id: "google-owner" }).id).toBe(
      owner.id,
    );
    const other = db.accounts.ensureCloudAccount({ id: "google-other" });
    expect(other.id).not.toBe(owner.id);
    expect(db.profiles.list(other.id)).toEqual([]);
    expect(() =>
      db.accounts.linkCloudUser(owner.id, { cloudUserId: "google-other" }),
    ).toThrow(/cannot be replaced/);
  });

  it("enforces five profiles separately per account, including transfers", () => {
    const db = database();
    db.accounts.upsert({ id: "second" });
    for (const accountId of [LOCAL_ACCOUNT_ID, "second"]) {
      for (let index = 0; index < 5; index++)
        db.profiles.create({
          id: `${accountId}-${index}`,
          accountId,
          name: "Viewer",
          locale: "en",
        });
      expect(db.profiles.count(accountId)).toBe(5);
      expect(() =>
        db.profiles.create({
          id: `${accountId}-extra`,
          accountId,
          name: "Extra",
          locale: "cs",
        }),
      ).toThrow(ProfileLimitError);
    }
    expect(() => db.profiles.transfer("local-0", "second")).toThrow(
      ProfileLimitError,
    );
    expect(db.profiles.get("local-0")?.accountId).toBe(LOCAL_ACCOUNT_ID);
    db.profiles.delete("second-0");
    db.profiles.setPinHash("local-0", "scrypt:encoded-hash-".padEnd(64, "0"));
    const before = db.profiles.getPinRecord("local-0");
    const transferred = db.profiles.transfer("local-0", "second");
    expect(transferred).toMatchObject({
      accountId: "second",
      pinEnabled: false,
    });
    expect(db.profiles.getPinRecord("local-0").version).toBe(
      before.version + 1,
    );
  });

  it("shares provider state within the account and retains it after a profile is deleted", () => {
    const db = database();
    db.accounts.upsert({ id: "other" });
    for (const [id, accountId] of [
      ["default", "local"],
      ["child", "local"],
      ["other-profile", "other"],
    ] as const)
      db.profiles.create({ id, accountId, name: id, locale: "en" });
    db.integrations.upsert(
      {
        id: "webshare",
        enabled: true,
        setupStatus: "ready",
        healthStatus: "healthy",
        secretRef: "vault://account/webshare",
      },
      "default",
    );
    expect(db.integrations.get("webshare", "child")).toMatchObject({
      credentialStatus: "stored",
      setupStatus: "ready",
    });
    expect(db.integrations.get("webshare", "other-profile")).toBeNull();
    db.integrations.deleteProfile("default");
    db.profiles.delete("default");
    expect(db.integrations.get("webshare", "child")?.setupStatus).toBe("ready");
    db.profiles.transfer("child", "other");
    expect(db.integrations.get("webshare", "child")).toBeNull();
  });
});

describe("profile PIN state and account sessions", () => {
  it("persists PIN lockout and increments unlock version when resetting PIN", () => {
    const db = database();
    db.profiles.create({ id: "default", name: "Viewer", locale: "en" });
    db.profiles.setPinHash("default", "scrypt:encoded-hash-".padEnd(64, "0"));
    expect(db.profiles.get("default")).not.toHaveProperty("pin_hash");
    for (let i = 0; i < 5; i++) db.profiles.recordPinFailure("default");
    const locked = db.profiles.getPinRecord("default");
    expect(locked.attempts).toBe(5);
    expect(Date.parse(locked.lockedUntil!)).toBe(now.getTime() + 300_000);
    expect(db.profiles.recordPinFailure("default")).toEqual(locked);
    now = new Date(now.getTime() + 300_001);
    expect(db.profiles.recordPinFailure("default")).toMatchObject({
      attempts: 1,
      lockedUntil: null,
    });
    db.profiles.setPinHash("default", null);
    expect(db.profiles.getPinRecord("default")).toMatchObject({
      hash: null,
      attempts: 0,
      lockedUntil: null,
      version: locked.version + 1,
    });
  });

  it("stores only token hashes, rejects expired and revoked sessions, scopes device revocation", () => {
    const db = database();
    db.accounts.upsert({ id: "other" });
    for (const [tokenHash, accountId] of [
      ["a".repeat(64), "local"],
      ["b".repeat(64), "other"],
    ])
      db.auth.createSession({
        tokenHash: tokenHash!,
        accountId: accountId!,
        deviceId: "tv",
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
      });
    expect(db.auth.getSession("a".repeat(64))?.accountId).toBe("local");
    expect(db.auth.revokeDevice("local", "tv")).toBe(1);
    expect(db.auth.getSession("a".repeat(64))).toBeNull();
    expect(db.auth.getSession("b".repeat(64))).not.toBeNull();
    now = new Date(now.getTime() + 3_600_001);
    expect(db.auth.getSession("b".repeat(64))).toBeNull();
    expect(db.auth.listDevices("other")).toEqual([]);
  });
});

describe("legacy account migration", () => {
  it("chooses the first created profile, retaining profile data and using global sync ids", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "streamer-account-migration-"),
    );
    directories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacy = new BetterSqlite3(filename);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((item) => item.version < 9)) {
      legacy.exec(migration.sql);
      legacy
        .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now.toISOString());
    }
    legacy
      .prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "oldest",
        "Original viewer",
        "cs",
        '{"genres":["Drama"]}',
        "2026-01-01T00:00:00.000Z",
        now.toISOString(),
      );
    legacy
      .prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "default",
        "Later viewer",
        "en",
        "{}",
        "2026-02-01T00:00:00.000Z",
        now.toISOString(),
      );
    legacy
      .prepare(
        `INSERT INTO profile_integration_connections (profile_id, integration_id, enabled, setup_status, health_status, secret_ref, created_at, updated_at)
      VALUES ('oldest', 'tmdb', 1, 'ready', 'healthy', 'vault://oldest/tmdb', ?, ?)`,
      )
      .run(now.toISOString(), now.toISOString());
    legacy.close();
    const db = openStreamerDatabase({ filename });
    opened.push(db);
    expect(db.settings.get("migration.accountIntegrations.sourceProfile")).toBe(
      "oldest",
    );
    expect(db.integrations.getSecretRef("tmdb", "default")).toBe(
      "vault://oldest/tmdb",
    );
    expect(db.profiles.get("oldest")).toMatchObject({
      accountId: "local",
      preferences: { genres: ["Drama"] },
    });
    expect(db.profiles.get("oldest")?.syncId).not.toBe(
      db.profiles.get("default")?.syncId,
    );
    expect(db.migrationBackupPath).toContain(".pre-accounts-");
    const backup = new BetterSqlite3(db.migrationBackupPath!, {
      readonly: true,
    });
    try {
      expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(
        backup
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 8 });
      expect(
        backup
          .prepare(
            "SELECT id, preferences_json FROM profiles WHERE id = 'oldest'",
          )
          .get(),
      ).toEqual({
        id: "oldest",
        preferences_json: '{"genres":["Drama"]}',
      });
      expect(
        backup
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'accounts'")
          .get(),
      ).toBeUndefined();
    } finally {
      backup.close();
    }
    db.close();
    const reopened = openStreamerDatabase({ filename });
    opened.push(reopened);
    expect(reopened.migrationBackupPath).toBeNull();
    expect(
      readdirSync(directory).filter((name) => name.includes(".pre-accounts-")),
    ).toHaveLength(1);
  });

  it("does not back up a fresh database or a current schema on reopen", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "streamer-fresh-account-database-"),
    );
    directories.push(directory);
    const filename = join(directory, "fresh.db");
    const db = openStreamerDatabase({ filename });
    opened.push(db);
    expect(db.migrationBackupPath).toBeNull();
    db.close();
    const reopened = openStreamerDatabase({ filename });
    opened.push(reopened);
    expect(reopened.migrationBackupPath).toBeNull();
    expect(
      readdirSync(directory).some((name) => name.includes(".pre-accounts-")),
    ).toBe(false);
  });

  it("stops before migration when a rollback backup cannot be written", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "streamer-account-backup-failure-"),
    );
    directories.push(directory);
    const filename = join(directory, "legacy.db");
    const legacy = new BetterSqlite3(filename);
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT UNIQUE, applied_at TEXT NOT NULL)",
    );
    for (const migration of MIGRATIONS.filter((item) => item.version < 9)) {
      legacy.exec(migration.sql);
      legacy
        .prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
        .run(migration.version, migration.name, now.toISOString());
    }
    legacy.close();
    const original = BetterSqlite3.prototype.prepare;
    const spy = vi
      .spyOn(BetterSqlite3.prototype, "prepare")
      .mockImplementation(function (
        this: BetterSqlite3.Database,
        source: string,
      ) {
        if (source === "VACUUM INTO ?")
          throw new Error("Simulated disk-full backup failure.");
        return original.call(this, source);
      });
    try {
      expect(() => openStreamerDatabase({ filename })).toThrow(
        /verified backup could not be created/,
      );
    } finally {
      spy.mockRestore();
    }
    const unchanged = new BetterSqlite3(filename, { readonly: true });
    try {
      expect(
        unchanged
          .prepare("SELECT max(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 8 });
      expect(
        unchanged
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'accounts'")
          .get(),
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });
});
