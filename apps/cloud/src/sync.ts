import {
  AccountSyncOperationSchema,
  AccountSyncPushSchema,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";

import { body, enforceRateLimit, hash, HttpError, json } from "./http.js";
import type { Env, Principal } from "./types.js";

interface OperationRow {
  operation_json: string;
  seq?: number;
  rowid?: number;
}

interface CursorRow {
  seq: number;
  floor: number;
}

function cursorStatement(env: Env, accountId: string): D1PreparedStatement {
  return env.DB.prepare(
    `SELECT MAX(
      COALESCE((SELECT MAX(seq) FROM cloud_sync_log WHERE account_id = ?), 0),
      COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = ?), 0)
    ) AS seq,
    COALESCE((SELECT pruned_through FROM cloud_sync_retention WHERE account_id = ?), 0) AS floor`,
  ).bind(accountId, accountId, accountId);
}

export function retentionStatements(
  env: Env,
  now: number,
): D1PreparedStatement[] {
  const cutoff = now - 90 * 86_400_000;
  return [
    // Record the floor before removing rows in the same transaction. Current
    // entities, profile ownership and tombstones are deliberately untouched.
    env.DB.prepare(
      `INSERT INTO cloud_sync_retention (account_id, pruned_through)
      SELECT account_id, MAX(seq) FROM cloud_sync_log WHERE created_at < ? GROUP BY account_id
      ON CONFLICT(account_id) DO UPDATE SET
        pruned_through = MAX(cloud_sync_retention.pruned_through, excluded.pruned_through)`,
    ).bind(cutoff),
    env.DB.prepare("DELETE FROM cloud_sync_log WHERE created_at < ?").bind(
      cutoff,
    ),
    env.DB.prepare(
      "DELETE FROM cloud_operation_receipt WHERE created_at < ?",
    ).bind(cutoff),
  ];
}

export function canonicalize(
  operation: AccountSyncOperation,
): AccountSyncOperation {
  const result = {
    ...operation,
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (result.kind === "progress" && result.payload) {
    return {
      ...result,
      payload: {
        ...result.payload,
        sessionStartedAt: new Date(
          result.payload.sessionStartedAt,
        ).toISOString(),
      },
    };
  }
  return result;
}

export function operationStatements(
  env: Env,
  accountId: string,
  operation: AccountSyncOperation,
  now: number,
  operationHash: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
    INSERT OR IGNORE INTO cloud_operation_receipt (account_id, operation_id, operation_hash, created_at) VALUES (?, ?, ?, ?)
  `,
    ).bind(accountId, operation.id, operationHash, now),
  ];
  if (operation.kind === "profile") {
    statements.push(
      env.DB.prepare(
        `
      INSERT INTO cloud_profile (id, account_id, active, updated_at, operation_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET active = excluded.active, updated_at = excluded.updated_at, operation_id = excluded.operation_id
      WHERE cloud_profile.account_id = excluded.account_id
        AND (excluded.updated_at > cloud_profile.updated_at OR
          (excluded.updated_at = cloud_profile.updated_at AND excluded.operation_id > cloud_profile.operation_id))
    `,
      ).bind(
        operation.profileId,
        accountId,
        operation.action === "upsert" ? 1 : 0,
        operation.updatedAt,
        operation.id,
      ),
    );
  }
  const sessionStartedAt =
    operation.kind === "progress" && operation.payload
      ? operation.payload.sessionStartedAt
      : null;
  statements.push(
    env.DB.prepare(
      `
    INSERT INTO cloud_entity
      (account_id, profile_id, kind, entity_id, operation_id, action, updated_at, session_started_at, operation_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, profile_id, kind, entity_id) DO UPDATE SET
      operation_id = excluded.operation_id, action = excluded.action, updated_at = excluded.updated_at,
      session_started_at = excluded.session_started_at, operation_json = excluded.operation_json
    WHERE (
      excluded.kind = 'progress' AND excluded.session_started_at IS NOT NULL AND cloud_entity.session_started_at IS NOT NULL
      AND excluded.session_started_at > cloud_entity.session_started_at
    ) OR (
      (excluded.kind <> 'progress' OR excluded.session_started_at IS NULL OR cloud_entity.session_started_at IS NULL
        OR excluded.session_started_at = cloud_entity.session_started_at)
      AND (excluded.updated_at > cloud_entity.updated_at OR
        (excluded.updated_at = cloud_entity.updated_at AND excluded.operation_id > cloud_entity.operation_id))
    )
  `,
    ).bind(
      accountId,
      operation.profileId,
      operation.kind,
      operation.entityId,
      operation.id,
      operation.action,
      operation.updatedAt,
      sessionStartedAt,
      JSON.stringify(operation),
    ),
  );
  statements.push(
    env.DB.prepare(
      `
    INSERT OR IGNORE INTO cloud_sync_log
      (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
    SELECT account_id, profile_id, kind, action, operation_id, operation_json, ? FROM cloud_entity
    WHERE account_id = ? AND profile_id = ? AND kind = ? AND entity_id = ? AND operation_id = ?
  `,
    ).bind(
      now,
      accountId,
      operation.profileId,
      operation.kind,
      operation.entityId,
      operation.id,
    ),
  );
  return statements;
}

export async function cursor(env: Env, accountId: string): Promise<string> {
  const row = await cursorStatement(env, accountId).first<CursorRow>();
  return String(row?.seq ?? 0);
}

export function databaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  for (const code of [
    "profile_not_owned",
    "profile_limit",
    "profile_deleted",
    "transfer_changed",
    "operation_id_conflict",
  ]) {
    if (message.includes(code)) throw new HttpError(409, code);
  }
  throw error;
}

export async function push(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  await enforceRateLimit(
    env.DB,
    `sync-push:${principal.account.id}`,
    60,
    60,
    now,
  );
  const parsed = AccountSyncPushSchema.safeParse(await body(request));
  if (!parsed.success) throw new HttpError(400, "invalid_sync_operations");
  const operations = parsed.data.operations.map(canonicalize);
  if (
    new Set(operations.map((operation) => operation.id)).size !==
    operations.length
  ) {
    throw new HttpError(400, "duplicate_operation_id");
  }
  if (
    operations.some(
      (operation) =>
        Date.parse(operation.updatedAt) > now + 5 * 60_000 ||
        (operation.kind === "progress" &&
          operation.payload &&
          Date.parse(operation.payload.sessionStartedAt) > now + 5 * 60_000),
    )
  ) {
    throw new HttpError(400, "future_operation");
  }
  try {
    const operationHashes = await Promise.all(
      operations.map((operation) => hash(JSON.stringify(operation))),
    );
    await env.DB.batch(
      operations.flatMap((operation, index) =>
        operationStatements(
          env,
          principal.account.id,
          operation,
          now,
          operationHashes[index]!,
        ),
      ),
    );
  } catch (error) {
    databaseError(error);
  }
  return json({
    cursor: await cursor(env, principal.account.id),
    acceptedIds: operations.map((operation) => operation.id),
  });
}

export async function pull(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const after = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d{1,16}$/.test(after) || !Number.isSafeInteger(Number(after)))
    throw new HttpError(400, "invalid_cursor");
  // D1 batches execute in one transaction. Reading the floor and rows together
  // prevents a concurrent scheduled prune from silently dropping delta events.
  const [metadata, rows] = await env.DB.batch<CursorRow | OperationRow>([
    cursorStatement(env, principal.account.id),
    // Old source accounts may retain only a profile tombstone after a transfer.
    env.DB.prepare(
      `
    SELECT l.seq, l.operation_json FROM cloud_sync_log l
    LEFT JOIN cloud_profile p ON p.id = l.profile_id
    WHERE l.account_id = ? AND l.seq > ?
      AND (p.account_id = ? OR (l.kind = 'profile' AND l.action = 'delete'))
    ORDER BY l.seq LIMIT 101
  `,
    ).bind(principal.account.id, Number(after), principal.account.id),
  ]);
  const state = metadata?.results[0] as CursorRow;
  if (Number(after) < state.floor) throw new HttpError(410, "cursor_expired");
  const watermark = String(state.seq);
  const results = rows?.results as OperationRow[];
  const page = results.slice(0, 100);
  const next = page.at(-1)?.seq;
  return json({
    cursor:
      results.length > 100 && next !== undefined ? String(next) : watermark,
    operations: page.map((row) =>
      AccountSyncOperationSchema.parse(JSON.parse(row.operation_json)),
    ),
    hasMore: results.length > 100,
  });
}

export async function snapshot(
  request: Request,
  env: Env,
  principal: Principal,
): Promise<Response> {
  const after = new URL(request.url).searchParams.get("after");
  let watermark: string | undefined;
  let phase = 0;
  let rowid = 0;
  if (after) {
    const match = /^snapshot:(\d{1,16}):([01]):(\d{1,16})$/.exec(after);
    if (
      !match?.[1] ||
      !match[2] ||
      !match[3] ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[3]))
    ) {
      throw new HttpError(400, "invalid_cursor");
    }
    watermark = match[1];
    phase = Number(match[2]);
    rowid = Number(match[3]);
  }
  const [metadata, rows] = await env.DB.batch<CursorRow | OperationRow>([
    cursorStatement(env, principal.account.id),
    env.DB.prepare(
      `
    SELECT e.rowid, e.operation_json FROM cloud_entity e
    JOIN cloud_profile p ON p.id = e.profile_id
    WHERE e.account_id = ? AND e.rowid > ?
      AND ((? = 0 AND e.kind = 'profile') OR (? = 1 AND e.kind <> 'profile'))
      AND (p.account_id = ? OR (e.kind = 'profile' AND e.action = 'delete'))
    ORDER BY e.rowid LIMIT 101
  `,
    ).bind(principal.account.id, rowid, phase, phase, principal.account.id),
  ]);
  const state = metadata?.results[0] as CursorRow;
  // An earlier snapshot page may have missed a later update. If retention has
  // overtaken its original watermark, that update can no longer be replayed.
  if (watermark !== undefined && Number(watermark) < state.floor)
    throw new HttpError(410, "cursor_expired");
  watermark ??= String(state.seq);
  const results = rows?.results as OperationRow[];
  const page = results.slice(0, 100);
  const moreRows = results.length > 100;
  const hasMore = moreRows || phase === 0;
  return json({
    cursor: moreRows
      ? `snapshot:${watermark}:${phase}:${page.at(-1)?.rowid ?? rowid}`
      : phase === 0
        ? `snapshot:${watermark}:1:0`
        : watermark,
    operations: page.map((row) =>
      AccountSyncOperationSchema.parse(JSON.parse(row.operation_json)),
    ),
    hasMore,
  });
}
