import type { Env } from "./types.js";

/** Build an account-owned profile deletion guarded by a transaction-specific predicate. */
export function removeProfileStatements(
  env: Env,
  accountId: string,
  profileId: string,
  updatedAt: string,
  now: number,
  guard: string,
  guardBindings: string[],
): D1PreparedStatement[] {
  const operationId = crypto.randomUUID();
  const operation = JSON.stringify({
    id: operationId,
    profileId,
    kind: "profile",
    entityId: profileId,
    action: "delete",
    updatedAt,
    payload: null,
  });
  return [
    env.DB.prepare(
      `UPDATE cloud_profile SET active = 0, updated_at = ?, operation_id = ?
       WHERE account_id = ? AND id = ? AND active = 1 AND ${guard}`,
    ).bind(updatedAt, operationId, accountId, profileId, ...guardBindings),
    env.DB.prepare(
      `DELETE FROM cloud_entity WHERE account_id = ? AND profile_id = ? AND ${guard}`,
    ).bind(accountId, profileId, ...guardBindings),
    env.DB.prepare(
      `INSERT INTO cloud_entity
       (account_id, profile_id, kind, entity_id, operation_id, action, updated_at, operation_json)
       SELECT ?, ?, 'profile', ?, ?, 'delete', ?, ? WHERE ${guard}`,
    ).bind(
      accountId,
      profileId,
      profileId,
      operationId,
      updatedAt,
      operation,
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO cloud_sync_log
       (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
       SELECT ?, ?, 'profile', 'delete', ?, ?, ? WHERE ${guard}`,
    ).bind(accountId, profileId, operationId, operation, now, ...guardBindings),
  ];
}
