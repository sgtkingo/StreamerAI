import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStreamerDatabase } from "@streamer-ai/database";
import {
  createServerBackup,
  inspectServerBackup,
  restoreServerBackup,
  recoverInterruptedServerRestore,
} from "../src/backup/server-backup.js";
import { acquireServerRuntimeLock } from "../src/services/runtime-lock.js";
import { EncryptedFileSecretStore } from "../src/stores/secret-store.js";
import { MasterPinService } from "../src/services/master-pin.js";

const switchFailure = vi.hoisted(() => ({
  target: undefined as string | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    rename: async (
      from: Parameters<typeof filesystem.rename>[0],
      to: Parameters<typeof filesystem.rename>[1],
    ) => {
      if (
        switchFailure.target &&
        String(from).includes(".restore-") &&
        String(to) === switchFailure.target
      )
        throw new Error("simulated destination disk failure");
      return await filesystem.rename(from, to);
    },
  };
});

const directories: string[] = [];
const password = "offline test passphrase 2026";
afterEach(async () => {
  switchFailure.target = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "streamer-backup-test-"));
  directories.push(directory);
  const state = join(directory, "source"),
    dataDirectory = join(state, "data"),
    keyFile = join(state, "keys", "master.key"),
    vaultFile = join(dataDirectory, "secrets.vault");
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(join(state, "keys"));
  await writeFile(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
  const db = openStreamerDatabase({
    filename: join(dataDirectory, "streamer-ai.db"),
  });
  db.accounts.upsert({ id: "other", name: "Other household" });
  db.accounts.linkCloudUser("local", { cloudUserId: "cloud-owner" });
  db.profiles.create({
    id: "viewer",
    name: "Czech viewer",
    locale: "cs",
    preferences: { nested: { enabled: true } },
  });
  db.profiles.create({
    id: "other-viewer",
    accountId: "other",
    name: "Other viewer",
    locale: "en",
  });
  db.profiles.setPinHash(
    "viewer",
    "scrypt:encoded-pin-verifier".padEnd(64, "0"),
  );
  db.settings.set("example.configuration", {
    sources: ["D:/old-media"],
    owner: "local",
  });
  db.settings.set("server.instanceId", "old-server-identity");
  db.settings.set("server.localAccess", {
    claimed: true,
    devices: [{ tokenHash: "fixture-device-hash" }],
  });
  db.auth.createSession({
    tokenHash: "a".repeat(64),
    accountId: "local",
    deviceId: "old-tv",
    expiresAt: "2100-01-01T00:00:00.000Z",
  });
  db.close();
  const vault = new EncryptedFileSecretStore({
    filename: vaultFile,
    keyFilename: keyFile,
  });
  await vault.set(
    "account.bG9jYWw.integration.webshare.wst",
    "provider-secret-should-survive",
  );
  await vault.set(
    "account.b3RoZXI.integration.webshare.wst",
    "other-household-secret",
  );
  await vault.set(
    "account.cloud-token.local.old-tv",
    "cloud-token-must-not-resurrect",
  );
  await vault.set("server.private-key", "old-instance-secret");
  return {
    directory,
    state,
    dataDirectory,
    keyFile,
    vaultFile,
    outputFile: join(directory, "portable.streamerai-backup"),
    passphrase: password,
    appVersion: "0.1.0",
  };
}

describe("offline encrypted server backup", () => {
  it("automatically encrypts with the selected account's verified Master PIN and preserves it after offline restore", async () => {
    const source = await fixture();
    const master = new MasterPinService(
      new EncryptedFileSecretStore({
        filename: source.vaultFile,
        keyFilename: source.keyFile,
      }),
    );
    await master.setupLocal("local", "01234567");
    await createServerBackup({
      ...source,
      accountId: "local",
      passphrase: undefined,
    });
    const manifest = await inspectServerBackup({
      file: source.outputFile,
      passphrase: "01234567",
    });
    expect(
      manifest.database.accounts.some((account) => account.id === "local"),
    ).toBe(true);
    await expect(
      inspectServerBackup({ file: source.outputFile, passphrase: "76543210" }),
    ).rejects.toThrow();
    const restored = await restoreServerBackup({
      file: source.outputFile,
      passphrase: "01234567",
      targetDirectory: join(source.directory, "restored-master"),
      mode: "new-server",
    });
    const restoredMaster = new MasterPinService(
      new EncryptedFileSecretStore({
        filename: restored.vaultFile,
        keyFilename: restored.keyFile,
      }),
    );
    expect(await restoredMaster.verify("local", "01234567")).toBe(true);
    expect(await restoredMaster.read("other")).toBeNull();
  }, 15_000);
  it("refuses automatic backup until the selected account's Master PIN has been verified locally", async () => {
    const source = await fixture();
    await expect(
      createServerBackup({
        ...source,
        accountId: "local",
        passphrase: undefined,
      }),
    ).rejects.toThrow(/Master PIN/);
    expect(await readdir(source.directory)).not.toContain(
      "portable.streamerai-backup",
    );
  });
  it("restores actual profiles, PINs, configuration, account ownership and provider vault entirely offline", async () => {
    const source = await fixture(),
      fetch = vi.fn(() => {
        throw new Error("network forbidden");
      });
    vi.stubGlobal("fetch", fetch);
    const manifest = await createServerBackup(source);
    expect(manifest.database.accounts).toEqual([
      { id: "local", name: "StreamerAI", profiles: 1 },
      { id: "other", name: "Other household", profiles: 1 },
    ]);
    const encrypted = await readFile(source.outputFile);
    for (const secret of [
      password,
      "Czech viewer",
      "Other household",
      "provider-secret-should-survive",
      "keys/master.key",
      "old-server-identity",
    ])
      expect(encrypted.includes(Buffer.from(secret))).toBe(false);
    expect(
      await inspectServerBackup({
        file: source.outputFile,
        passphrase: password,
      }),
    ).toEqual(manifest);
    const targetDirectory = join(source.directory, "restored");
    const result = await restoreServerBackup({
      file: source.outputFile,
      passphrase: password,
      targetDirectory,
      mode: "new-server",
    });
    const db = openStreamerDatabase({ filename: result.databaseFile });
    try {
      expect(db.profiles.get("viewer")).toMatchObject({
        accountId: "local",
        name: "Czech viewer",
        locale: "cs",
        pinEnabled: true,
      });
      expect(db.profiles.list("other").map((profile) => profile.id)).toEqual([
        "other-viewer",
      ]);
      expect(db.profiles.getPinRecord("viewer").hash).toBe(
        "scrypt:encoded-pin-verifier".padEnd(64, "0"),
      );
      expect(db.accounts.get("local")?.cloudUserId).toBe("cloud-owner");
      expect(db.settings.get("example.configuration")).toEqual({
        sources: ["D:/old-media"],
        owner: "local",
      });
      expect(db.settings.get("server.instanceId")).not.toBe(
        "old-server-identity",
      );
      expect(db.settings.get("server.localAccess")).toBeNull();
      expect(db.auth.listDeviceHistory("local")).toEqual([]);
      const hash = createHash("sha256")
        .update(JSON.stringify("local"))
        .digest("hex");
      expect(db.settings.get(`accountSyncPaused.${hash}`)).toBe(true);
      expect(db.settings.get("server.offlineRestore")).toMatchObject({
        requiresLocalOwnerRecovery: true,
        cloudReconciliationRequired: true,
      });
    } finally {
      db.close();
    }
    const vault = new EncryptedFileSecretStore({
      filename: result.vaultFile,
      keyFilename: result.keyFile,
    });
    expect(await vault.get("account.bG9jYWw.integration.webshare.wst")).toBe(
      "provider-secret-should-survive",
    );
    expect(await vault.get("account.b3RoZXI.integration.webshare.wst")).toBe(
      "other-household-secret",
    );
    expect(await vault.has("account.cloud-token.local.old-tv")).toBe(false);
    expect(await vault.has("server.private-key")).toBe(false);
    expect(await readFile(result.keyFile, "utf8")).not.toBe(
      await readFile(source.keyFile, "utf8"),
    );
    expect(await readFile(result.environmentFile, "utf8")).toContain(
      'STREAMERAI_SECRET_BACKEND="encrypted-file"',
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(
      (await readdir(source.directory)).some(
        (file) =>
          file.includes("restore-") || file.endsWith("maintenance.lock"),
      ),
    ).toBe(false);
  });

  it("keeps replacement identity/key but invalidates browser and cloud sessions", async () => {
    const source = await fixture();
    await createServerBackup(source);
    const result = await restoreServerBackup({
      file: source.outputFile,
      passphrase: password,
      targetDirectory: join(source.directory, "replacement"),
      mode: "replace",
      sourceRetiredConfirmed: true,
    });
    expect(await readFile(result.keyFile, "utf8")).toBe(
      await readFile(source.keyFile, "utf8"),
    );
    const db = openStreamerDatabase({ filename: result.databaseFile });
    try {
      expect(db.settings.get("server.instanceId")).toBe("old-server-identity");
      expect(db.auth.listDeviceHistory("local")).toEqual([]);
    } finally {
      db.close();
    }
    expect(
      await new EncryptedFileSecretStore({
        filename: result.vaultFile,
        keyFilename: result.keyFile,
      }).get("server.private-key"),
    ).toBe("old-instance-secret");
  });

  it("rejects wrong passphrases, tampering and truncation before creating target state", async () => {
    const source = await fixture();
    await createServerBackup(source);
    const targetDirectory = join(source.directory, "untouched");
    await expect(
      restoreServerBackup({
        file: source.outputFile,
        passphrase: "wrong password",
        targetDirectory,
        mode: "new-server",
      }),
    ).rejects.toThrow(/authenticated/);
    const bytes = await readFile(source.outputFile),
      corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 18] ^= 0x01;
    const badFile = join(source.directory, "corrupted.backup");
    await writeFile(badFile, corrupted);
    await expect(
      restoreServerBackup({
        file: badFile,
        passphrase: password,
        targetDirectory,
        mode: "new-server",
      }),
    ).rejects.toThrow(/authenticated/);
    await writeFile(badFile, bytes.subarray(0, -35));
    await expect(
      inspectServerBackup({ file: badFile, passphrase: password }),
    ).rejects.toThrow();
    expect(await readdir(source.directory)).not.toContain("untouched");
  });

  it("requires explicit replacement and overwrite decisions and preserves a verified rollback", async () => {
    const source = await fixture();
    await createServerBackup(source);
    await expect(
      restoreServerBackup({
        file: source.outputFile,
        passphrase: password,
        targetDirectory: join(source.directory, "new"),
        mode: "replace",
      }),
    ).rejects.toThrow(/retired/);
    await expect(
      restoreServerBackup({
        file: source.outputFile,
        passphrase: password,
        targetDirectory: source.state,
        mode: "new-server",
      }),
    ).rejects.toThrow(/overwrite/);
    const db = openStreamerDatabase({
      filename: join(source.dataDirectory, "streamer-ai.db"),
    });
    db.settings.set("changed.after.backup", true);
    db.close();
    const result = await restoreServerBackup({
      file: source.outputFile,
      passphrase: password,
      targetDirectory: source.state,
      mode: "new-server",
      overwriteConfirmed: true,
    });
    expect(result.rollbackDirectory).toBeTruthy();
    expect(result.rollbackBackupFile).toBeTruthy();
    expect(
      await inspectServerBackup({
        file: result.rollbackBackupFile!,
        passphrase: password,
      }),
    ).toMatchObject({ format: "streamerai-offline-backup" });
    const old = openStreamerDatabase({
      filename: join(result.rollbackDirectory!, "data", "streamer-ai.db"),
    });
    try {
      expect(old.settings.get("changed.after.backup")).toBe(true);
    } finally {
      old.close();
    }
    const restored = openStreamerDatabase({ filename: result.databaseFile });
    try {
      expect(restored.settings.get("changed.after.backup")).toBeNull();
    } finally {
      restored.close();
    }
  });

  it("refuses export and restore while the server runtime owns the data directory", async () => {
    const source = await fixture();
    await createServerBackup(source);
    const lock = acquireServerRuntimeLock(source.dataDirectory);
    try {
      await expect(
        createServerBackup({
          ...source,
          outputFile: join(source.directory, "busy.backup"),
        }),
      ).rejects.toThrow(/already in use/);
      await expect(
        restoreServerBackup({
          file: source.outputFile,
          passphrase: password,
          targetDirectory: source.state,
          mode: "new-server",
          overwriteConfirmed: true,
        }),
      ).rejects.toThrow(/already in use/);
    } finally {
      lock.release();
    }
    expect(
      (await readdir(source.directory)).some((file) =>
        file.endsWith("maintenance.lock"),
      ),
    ).toBe(false);
  });

  it("refuses unsafe archive paths, case collisions and overwriting an existing backup", async () => {
    const source = await fixture(),
      extra = join(source.directory, "config.env");
    await writeFile(extra, "SECRET=fixture-value\n");
    await expect(
      createServerBackup({
        ...source,
        extraFiles: [
          { source: extra, path: "extras/../../escape", kind: "configuration" },
        ],
      }),
    ).rejects.toThrow(/unsafe/);
    await expect(
      createServerBackup({
        ...source,
        extraFiles: [
          { source: extra, path: "extras/config.env", kind: "configuration" },
          { source: extra, path: "extras/CONFIG.env", kind: "configuration" },
        ],
      }),
    ).rejects.toThrow(/colliding/);
    await createServerBackup(source);
    const original = await readFile(source.outputFile);
    await expect(createServerBackup(source)).rejects.toThrow();
    expect(await readFile(source.outputFile)).toEqual(original);
    expect(
      (await readdir(source.directory)).some((file) =>
        file.endsWith("partial"),
      ),
    ).toBe(false);
  });

  it("rejects future database schemas and invalid vault keys without producing a backup", async () => {
    const source = await fixture();
    const db = new DatabaseSync(join(source.dataDirectory, "streamer-ai.db"));
    db.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, 'future', ?)",
    ).run(new Date().toISOString());
    db.close();
    await expect(createServerBackup(source)).rejects.toThrow(
      /unsupported database schema/,
    );
    const db2 = new DatabaseSync(join(source.dataDirectory, "streamer-ai.db"));
    db2.exec("DELETE FROM schema_migrations WHERE version = 9999");
    db2.close();
    await writeFile(source.keyFile, randomBytes(32).toString("base64"));
    await expect(createServerBackup(source)).rejects.toThrow();
    expect(await readdir(source.directory)).not.toContain(
      "portable.streamerai-backup",
    );
  });

  it("rolls back the prior installation when the staged directory switch fails", async () => {
    const source = await fixture();
    await createServerBackup(source);
    switchFailure.target = source.state;
    await expect(
      restoreServerBackup({
        file: source.outputFile,
        passphrase: password,
        targetDirectory: source.state,
        mode: "new-server",
        overwriteConfirmed: true,
      }),
    ).rejects.toThrow(/simulated/);
    const old = openStreamerDatabase({
      filename: join(source.dataDirectory, "streamer-ai.db"),
    });
    try {
      expect(old.settings.get("server.instanceId")).toBe("old-server-identity");
    } finally {
      old.close();
    }
    expect(
      (await readdir(source.directory)).some(
        (name) =>
          name.includes(".restore-") || name.endsWith("maintenance.lock"),
      ),
    ).toBe(false);
  });

  it("recovers old state from a persisted interrupted-switch journal and removes protected staging", async () => {
    const source = await fixture();
    const rollback = `${source.state}.rollback-11111111-1111-1111-1111-111111111111`;
    const stage = join(
      source.directory,
      ".source.restore-22222222-2222-2222-2222-222222222222",
    );
    await fs.rename(source.state, rollback);
    await mkdir(stage);
    await writeFile(join(stage, "partial"), "staged plaintext fixture");
    await writeFile(
      `${source.state}.streamerai-maintenance.lock`,
      JSON.stringify({
        format: "streamerai-restore-journal",
        version: 1,
        pid: 2147483647,
        nonce: "fixture",
        target: source.state,
        stage,
        rollback,
      }),
    );
    expect(await recoverInterruptedServerRestore(source.state)).toEqual({
      recoveredPreviousState: true,
      retainedRollbackDirectory: null,
    });
    const old = openStreamerDatabase({
      filename: join(source.dataDirectory, "streamer-ai.db"),
    });
    try {
      expect(old.profiles.get("viewer")?.name).toBe("Czech viewer");
    } finally {
      old.close();
    }
    expect(
      (await readdir(source.directory)).some(
        (name) =>
          name.includes(".restore-") || name.endsWith("maintenance.lock"),
      ),
    ).toBe(false);
  });
});
