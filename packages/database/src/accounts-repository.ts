import type BetterSqlite3 from "better-sqlite3";
import { DatabaseValidationError } from "./errors.js";
import {
  LOCAL_ACCOUNT_ID,
  type Account,
  type AccountSession,
  type Clock,
  type CreateAccountSessionInput,
  type UpsertAccountInput,
} from "./types.js";

function text(value: string, label: string, max = 120): string {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max)
    throw new DatabaseValidationError(
      `${label} must contain between 1 and ${max} characters.`,
    );
  return trimmed;
}

interface AccountRow {
  id: string;
  cloud_user_id: string | null;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

function account(row: AccountRow): Account {
  return {
    id: row.id,
    cloudUserId: row.cloud_user_id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AccountsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  get(id: string): Account | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(text(id, "Account id")) as AccountRow | undefined;
    return row === undefined ? null : account(row);
  }

  getRequired(id: string): Account {
    const found = this.get(id);
    if (found === null)
      throw new DatabaseValidationError(`Account '${id}' does not exist.`);
    return found;
  }

  getLocal(): Account {
    return this.getRequired(LOCAL_ACCOUNT_ID);
  }

  /** A server keeps one canonical household when cloud management is attached or detached. */
  getHousehold(): Account {
    const setting = this.database
      .prepare(
        "SELECT value_json FROM app_settings WHERE key = 'household.accountId'",
      )
      .get() as { value_json: string } | undefined;
    return setting
      ? this.getRequired(JSON.parse(setting.value_json) as string)
      : this.getLocal();
  }

  detachCloudUser(id: string, expectedCloudUserId: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE accounts SET cloud_user_id = NULL, email = NULL, updated_at = ? WHERE id = ? AND cloud_user_id = ?",
        )
        .run(this.clock().toISOString(), id, expectedCloudUserId).changes === 1
    );
  }

  getByCloudUserId(id: string): Account | null {
    const row = this.database
      .prepare("SELECT * FROM accounts WHERE cloud_user_id = ?")
      .get(text(id, "Cloud user id")) as AccountRow | undefined;
    return row === undefined ? null : account(row);
  }

  list(): Account[] {
    return (
      this.database
        .prepare("SELECT * FROM accounts ORDER BY created_at, id")
        .all() as AccountRow[]
    ).map(account);
  }

  listDirtySyncAccounts(): string[] {
    return (
      this.database
        .prepare(
          "SELECT account_id FROM account_sync_dirty ORDER BY account_id",
        )
        .all() as { account_id: string }[]
    ).map((row) => row.account_id);
  }

  /** Clear only in the same transaction that saves a captured state and outbox. */
  markSyncCaptured(accountId: string): void {
    this.database
      .prepare("DELETE FROM account_sync_dirty WHERE account_id = ?")
      .run(accountId);
  }

  upsert(input: UpsertAccountInput): Account {
    const id = text(input.id, "Account id");
    const existing = this.get(id);
    const cloudUserId =
      input.cloudUserId === undefined
        ? (existing?.cloudUserId ?? null)
        : input.cloudUserId;
    if (existing?.cloudUserId && cloudUserId !== existing.cloudUserId)
      throw new DatabaseValidationError(
        "An account's verified cloud identity cannot be replaced.",
      );
    this.database
      .prepare(
        `INSERT INTO accounts (id, cloud_user_id, name, email, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      cloud_user_id = excluded.cloud_user_id, name = excluded.name, email = excluded.email, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        cloudUserId === null ? null : text(cloudUserId, "Cloud user id"),
        text(input.name ?? existing?.name ?? "StreamerAI", "Account name"),
        input.email === undefined
          ? (existing?.email ?? null)
          : input.email === null
            ? null
            : text(input.email, "Email", 320),
        existing?.createdAt ?? this.clock().toISOString(),
        this.clock().toISOString(),
      );
    return this.getRequired(id);
  }

  linkCloudUser(
    id: string,
    identity: {
      cloudUserId: string;
      name?: string | undefined;
      email?: string | null | undefined;
    },
  ): Account {
    this.getRequired(id);
    return this.upsert({ id, ...identity });
  }

  /** Only call after the cloud has confirmed a merge from this exact identity. */
  reassignMergedCloudUser(
    id: string,
    expectedCloudUserId: string,
    newCloudUserId: string,
    identity: { name?: string; email?: string } = {},
  ): "updated" | "conflict" | "changed" {
    const current = this.getRequired(id);
    if (current.cloudUserId !== expectedCloudUserId) return "changed";
    const existing = this.getByCloudUserId(newCloudUserId);
    if (existing && existing.id !== id) return "conflict";
    const result = this.database
      .prepare(
        "UPDATE accounts SET cloud_user_id = ?, name = COALESCE(?, name), email = COALESCE(?, email), updated_at = ? WHERE id = ? AND cloud_user_id = ?",
      )
      .run(
        text(newCloudUserId, "Cloud user id"),
        identity.name === undefined
          ? null
          : text(identity.name, "Account name"),
        identity.email === undefined
          ? null
          : text(identity.email, "Email", 320),
        this.clock().toISOString(),
        id,
        expectedCloudUserId,
      );
    return result.changes === 1 ? "updated" : "changed";
  }

  /** Detach only the identity whose deletion was verified by the cloud. */
  detachDeletedCloudUser(id: string, expectedCloudUserId: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE accounts SET cloud_user_id = NULL, name = 'Local household', email = NULL, updated_at = ? WHERE id = ? AND cloud_user_id = ?",
        )
        .run(
          this.clock().toISOString(),
          text(id, "Account id"),
          text(expectedCloudUserId, "Cloud user id"),
        ).changes > 0
    );
  }

  /** A verified cloud identity may claim the legacy installation exactly once. */
  ensureCloudAccount(
    identity: {
      id: string;
      name?: string;
      email?: string | null;
    },
    claimAccountId?: string,
  ): Account {
    return this.database.transaction(() => {
      const found = this.getByCloudUserId(identity.id);
      if (claimAccountId && found && found.id !== claimAccountId)
        throw new DatabaseValidationError(
          "This online account already has local profiles. Open it separately before importing another household.",
        );
      if (found !== null)
        return this.upsert({
          id: found.id,
          name: identity.name,
          email: identity.email,
        });
      if (claimAccountId) {
        const source = this.getRequired(claimAccountId);
        if (source.cloudUserId !== null)
          throw new DatabaseValidationError(
            "This household already belongs to an online account.",
          );
        return this.linkCloudUser(source.id, {
          cloudUserId: identity.id,
          name: identity.name,
          email: identity.email,
        });
      }
      const explicitLocalEntry = this.database
        .prepare(
          "SELECT value_json FROM app_settings WHERE key = 'account.localEntryUsed'",
        )
        .get() as { value_json: string } | undefined;
      if (
        this.getLocal().cloudUserId === null &&
        explicitLocalEntry?.value_json !== "true"
      )
        return this.linkCloudUser(LOCAL_ACCOUNT_ID, {
          cloudUserId: identity.id,
          name: identity.name,
          email: identity.email,
        });
      const id = `cloud:${text(identity.id, "Cloud user id", 114)}`;
      return this.upsert({
        id,
        cloudUserId: identity.id,
        name: identity.name,
        email: identity.email,
      });
    })();
  }
}

interface SessionRow {
  token_hash: string;
  account_id: string;
  device_id: string;
  label: string;
  expires_at: string;
  created_at: string;
  last_seen_at: string;
  revoked_at: string | null;
}

function session(row: SessionRow): AccountSession {
  return {
    tokenHash: row.token_hash,
    accountId: row.account_id,
    deviceId: row.device_id,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
  };
}

export class AccountAuthRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  createSession(input: CreateAccountSessionInput): AccountSession {
    const hash = text(input.tokenHash, "Session hash", 128);
    if (!/^[a-f\d]{64}$/i.test(hash))
      throw new DatabaseValidationError(
        "Session token hash must be SHA-256 hexadecimal.",
      );
    if (
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      Date.parse(input.expiresAt) <= this.clock().getTime()
    )
      throw new DatabaseValidationError(
        "Session expiry must be in the future.",
      );
    const now = this.clock().toISOString();
    this.database
      .prepare(
        `INSERT INTO account_sessions
      (token_hash, account_id, device_id, label, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hash,
        text(input.accountId, "Account id"),
        text(input.deviceId, "Device id"),
        text(input.label ?? "StreamerAI device", "Device label"),
        new Date(input.expiresAt).toISOString(),
        now,
        now,
      );
    return this.getSession(hash)!;
  }

  /** Invalidated/expired sessions are never returned as authenticated sessions. */
  getSession(tokenHash: string): AccountSession | null {
    const row = this.database
      .prepare(
        `SELECT * FROM account_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, this.clock().toISOString()) as SessionRow | undefined;
    return row === undefined ? null : session(row);
  }

  touchSession(tokenHash: string): void {
    this.database
      .prepare(
        "UPDATE account_sessions SET last_seen_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .run(this.clock().toISOString(), tokenHash);
  }

  revokeSession(tokenHash: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE account_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .run(this.clock().toISOString(), tokenHash).changes > 0
    );
  }

  revokeDevice(accountId: string, deviceId: string): number {
    return this.database
      .prepare(
        "UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL",
      )
      .run(this.clock().toISOString(), accountId, deviceId).changes;
  }

  listDevices(accountId: string): AccountSession[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM account_sessions
      WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC`,
        )
        .all(
          text(accountId, "Account id"),
          this.clock().toISOString(),
        ) as SessionRow[]
    ).map(session);
  }

  /** Includes expired sessions so a home server can learn of later account deletion. */
  listDeviceHistory(accountId: string): AccountSession[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM account_sessions WHERE account_id = ? ORDER BY last_seen_at DESC",
        )
        .all(text(accountId, "Account id")) as SessionRow[]
    ).map(session);
  }

  pruneExpired(): number {
    return this.database
      .prepare("DELETE FROM account_sessions WHERE expires_at <= ?")
      .run(this.clock().toISOString()).changes;
  }
}
