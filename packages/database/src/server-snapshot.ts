import BetterSqlite3 from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { openStreamerDatabase } from "./database.js";
import { MIGRATIONS } from "./migrations.js";

export interface ServerDatabaseSummary {
  schemaVersions: number[];
  accounts: Array<{ id: string; name: string; profiles: number }>;
}

function check(database: BetterSqlite3.Database): ServerDatabaseSummary {
  if (database.pragma("integrity_check", { simple: true }) !== "ok")
    throw new Error("Backup database integrity check failed.");
  if ((database.pragma("foreign_key_check") as unknown[]).length !== 0)
    throw new Error("Backup database contains invalid ownership references.");
  const schemaVersions = (
    database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>
  ).map((row) => row.version);
  const supported = new Set(MIGRATIONS.map((migration) => migration.version));
  if (
    schemaVersions.length === 0 ||
    schemaVersions.some((version) => !supported.has(version))
  )
    throw new Error(
      "Backup requires an unsupported database schema. Install a compatible StreamerAI version.",
    );
  const hasAccounts = schemaVersions.includes(9);
  return {
    schemaVersions,
    accounts: hasAccounts
      ? (database
          .prepare(
            "SELECT a.id, a.name, count(p.id) AS profiles FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id GROUP BY a.id ORDER BY a.id",
          )
          .all() as ServerDatabaseSummary["accounts"])
      : [],
  };
}

/** sqlite3_serialize reads the connection's complete committed image, including WAL pages. */
export function snapshotStreamerDatabaseFile(filename: string): {
  bytes: Buffer;
  summary: ServerDatabaseSummary;
} {
  const database = new BetterSqlite3(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.transaction(() => ({
      bytes: database.serialize(),
      summary: check(database),
    }))();
  } finally {
    database.close();
  }
}

/** Validate untrusted backup bytes in memory before writing or migrating any live database. */
export function inspectStreamerDatabaseSnapshot(
  bytes: Buffer,
): ServerDatabaseSummary {
  // Serialized WAL databases are standalone snapshots; restore the header's
  // journaling bytes to rollback mode before opening an in-memory image.
  const image = Buffer.from(bytes);
  if (image.subarray(0, 16).toString("binary") !== "SQLite format 3\0")
    throw new Error("Backup database is not a SQLite database.");
  image[18] = 1;
  image[19] = 1;
  const database = new BetterSqlite3(image);
  try {
    return check(database);
  } finally {
    database.close();
    image.fill(0);
  }
}

/** Only call against a private staged copy. All restored cloud sync starts paused. */
export function prepareRestoredStreamerDatabase(
  filename: string,
  mode: "replace" | "new-server",
  createdAt: string,
): void {
  const migrated = openStreamerDatabase({ filename });
  migrated.close();
  const database = new BetterSqlite3(filename);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    database.transaction(() => {
      // Even replacement restores must not resurrect revoked browser sessions.
      database.exec(
        "DELETE FROM account_sessions; DELETE FROM idempotency_records;",
      );
      const setting = database.prepare(
        "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
      );
      const accounts = database
        .prepare("SELECT id FROM accounts")
        .all() as Array<{ id: string }>;
      for (const { id } of accounts) {
        const hash = createHash("sha256")
          .update(JSON.stringify(id))
          .digest("hex");
        setting.run(`accountSyncPaused.${hash}`, "true", createdAt);
      }
      setting.run(
        "server.offlineRestore",
        JSON.stringify({
          mode,
          createdAt,
          requiresLocalOwnerRecovery: true,
          cloudReconciliationRequired: true,
        }),
        createdAt,
      );
      // Pending work and sync outboxes are preserved for explicit reconciliation.
      // Lease ownership belonged to a process that no longer exists.
      database.exec(
        "UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE state = 'running'",
      );
      if (mode === "new-server") {
        database
          .prepare(
            "DELETE FROM app_settings WHERE key = 'server.localAccess' OR key GLOB 'server.identity*' OR key GLOB 'server.instance*' OR key GLOB 'device.*' OR key GLOB 'pairing.*'",
          )
          .run();
        setting.run(
          "server.instanceId",
          JSON.stringify(randomUUID()),
          createdAt,
        );
      }
    })();
    check(database);
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.pragma("journal_mode = DELETE");
  } finally {
    database.close();
  }
}
