import BetterSqlite3 from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { applyMigrations } from "./migrations.js";
import {
  AccountAuthRepository,
  AccountsRepository,
} from "./accounts-repository.js";
import {
  CatalogTitlesRepository,
  DiscoverySessionsRepository,
  HistoryRepository,
  IdempotencyRepository,
  IntegrationsRepository,
  JobsRepository,
  LibraryRepository,
  PlaybackPositionsRepository,
  ProfilesRepository,
  SettingsRepository,
  SyncOutboxRepository,
} from "./repositories.js";
import type { Clock } from "./types.js";

export interface OpenStreamerDatabaseOptions {
  filename: string;
  clock?: Clock;
  busyTimeoutMs?: number;
}

export class StreamerDatabase {
  readonly accounts: AccountsRepository;
  readonly auth: AccountAuthRepository;
  readonly settings: SettingsRepository;
  readonly profiles: ProfilesRepository;
  readonly integrations: IntegrationsRepository;
  readonly titles: CatalogTitlesRepository;
  readonly library: LibraryRepository;
  readonly playbackPositions: PlaybackPositionsRepository;
  readonly history: HistoryRepository;
  readonly discoverySessions: DiscoverySessionsRepository;
  readonly idempotency: IdempotencyRepository;
  readonly jobs: JobsRepository;
  readonly syncOutbox: SyncOutboxRepository;

  private closed = false;

  constructor(
    private readonly connection: BetterSqlite3.Database,
    clock: Clock,
    readonly migrationBackupPath: string | null = null,
  ) {
    this.accounts = new AccountsRepository(connection, clock);
    this.auth = new AccountAuthRepository(connection, clock);
    this.settings = new SettingsRepository(connection, clock);
    this.profiles = new ProfilesRepository(connection, clock);
    this.integrations = new IntegrationsRepository(connection, clock);
    this.titles = new CatalogTitlesRepository(connection, clock);
    this.library = new LibraryRepository(connection, clock);
    this.playbackPositions = new PlaybackPositionsRepository(connection, clock);
    this.history = new HistoryRepository(connection, clock);
    this.discoverySessions = new DiscoverySessionsRepository(connection, clock);
    this.idempotency = new IdempotencyRepository(connection, clock);
    this.jobs = new JobsRepository(connection, clock);
    this.syncOutbox = new SyncOutboxRepository(connection, clock);
  }

  getJournalMode(): string {
    return String(
      this.connection.pragma("journal_mode", { simple: true }),
    ).toLowerCase();
  }

  getAppliedMigrationVersions(): number[] {
    return (
      this.connection
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>
    ).map(({ version }) => version);
  }

  /**
   * Executes synchronous repository work atomically. This is the boundary used
   * to persist a local change and its sync-outbox operation in one transaction.
   */
  transaction<T>(operation: () => T): T {
    return this.connection.transaction(operation)();
  }

  close(): void {
    if (!this.closed) {
      this.connection.close();
      this.closed = true;
    }
  }
}

/** VACUUM INTO includes committed WAL pages and produces a standalone rollback copy. */
function backupBeforeAccountMigration(
  database: BetterSqlite3.Database,
  filename: string,
  clock: Clock,
): string | null {
  if (database.memory) return null;
  const hasMigrations = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (hasMigrations === undefined) return null;
  const hasAccountMigration = database
    .prepare("SELECT 1 FROM schema_migrations WHERE version = 9")
    .get();
  const hasPreviousMigration = database
    .prepare("SELECT 1 FROM schema_migrations LIMIT 1")
    .get();
  if (hasAccountMigration !== undefined || hasPreviousMigration === undefined)
    return null;
  const timestamp = clock().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${resolve(filename)}.pre-accounts-${timestamp}-${randomUUID()}.db`;
  try {
    database.prepare("VACUUM INTO ?").run(backupPath);
    const backup = new BetterSqlite3(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      if (backup.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error(
          "The migration backup did not pass its integrity check.",
        );
      const sourceVersions = database
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all();
      const backupVersions = backup
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all();
      if (JSON.stringify(sourceVersions) !== JSON.stringify(backupVersions))
        throw new Error(
          "The migration backup does not match the original schema.",
        );
    } finally {
      backup.close();
    }
    return backupPath;
  } catch (cause) {
    throw new Error(
      "Account migration stopped because a verified backup could not be created.",
      { cause },
    );
  }
}

export function openStreamerDatabase(
  options: OpenStreamerDatabaseOptions,
): StreamerDatabase {
  const clock = options.clock ?? (() => new Date());
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (
    !Number.isInteger(busyTimeoutMs) ||
    busyTimeoutMs < 0 ||
    busyTimeoutMs > 60_000
  ) {
    throw new Error(
      "SQLite busy timeout must be an integer between 0 and 60000ms.",
    );
  }
  const database = new BetterSqlite3(options.filename);

  try {
    database.pragma("foreign_keys = ON");
    database.pragma(`busy_timeout = ${busyTimeoutMs}`);
    database.pragma("synchronous = NORMAL");
    const journalMode = String(
      database.pragma("journal_mode = WAL", { simple: true }),
    ).toLowerCase();
    if (options.filename !== ":memory:" && journalMode !== "wal") {
      throw new Error(
        `SQLite WAL mode is required; received '${journalMode}'.`,
      );
    }
    const migrationBackupPath = backupBeforeAccountMigration(
      database,
      options.filename,
      clock,
    );
    applyMigrations(database, () => clock().toISOString());
    return new StreamerDatabase(database, clock, migrationBackupPath);
  } catch (error) {
    database.close();
    throw error;
  }
}
