import {
  body,
  enforceRateLimit,
  HttpError,
  json,
  record,
  string,
} from "./http.js";
import type { Env, Principal } from "./types.js";

export interface HouseholdRow {
  id: string;
  account_id: string;
  name: string;
  server_id: string;
  ownership_version: number;
  merged_into?: string | null;
  created_at: number;
  updated_at: number;
  revision?: number | null;
  envelope_json?: string | null;
  backup_updated_at?: number | null;
  profile_count?: number;
}
export const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    value,
  );

export function publicHousehold(row: HouseholdRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    serverId: row.server_id,
    ownershipVersion: row.ownership_version,
    mergedInto: row.merged_into ?? null,
    hasBackup: !!row.envelope_json,
    hasProfiles: (row.profile_count ?? 0) > 0,
    revision: row.revision ?? 0,
    lastBackupAt:
      row.backup_updated_at == null
        ? null
        : new Date(row.backup_updated_at).toISOString(),
  };
}
export async function findHousehold(
  env: Env,
  id: string,
): Promise<HouseholdRow | null> {
  return env.DB.prepare(
    `SELECT h.*, c.revision, CASE WHEN c.invalidated_at IS NULL THEN c.envelope_json END AS envelope_json, c.updated_at AS backup_updated_at,
    (SELECT COUNT(*) FROM cloud_household_sync_profile p WHERE p.account_id=h.id AND p.active=1) AS profile_count
    FROM cloud_household h LEFT JOIN cloud_household_checkpoint c ON c.household_id = h.id WHERE h.id = ?`,
  )
    .bind(id)
    .first<HouseholdRow>();
}
export async function requireHousehold(
  env: Env,
  principal: Principal,
  id: string,
  bound = false,
): Promise<HouseholdRow> {
  if (!uuid(id)) throw new HttpError(400, "invalid_household_id");
  if (
    principal.method === "device" &&
    ((bound && !principal.householdId) ||
      (principal.householdId && principal.householdId !== id))
  )
    throw new HttpError(403, "household_scope_forbidden");
  const row = await findHousehold(env, id);
  if (!row || row.account_id !== principal.account.id)
    throw new HttpError(404, "household_not_found");
  return row;
}
export async function household(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  id?: string,
): Promise<Response> {
  if (principal.mergeAckRequired) throw new HttpError(409, "account_merged");
  await enforceRateLimit(
    env.DB,
    `households:${principal.account.id}`,
    40,
    60,
    now,
  );
  if (request.method === "GET") {
    if (id)
      return json({
        household: publicHousehold(await requireHousehold(env, principal, id)),
      });
    const rows = await env.DB.prepare(
      `SELECT h.*, c.revision, CASE WHEN c.invalidated_at IS NULL THEN c.envelope_json END AS envelope_json, c.updated_at AS backup_updated_at,
      (SELECT COUNT(*) FROM cloud_household_sync_profile p WHERE p.account_id=h.id AND p.active=1) AS profile_count
      FROM cloud_household h LEFT JOIN cloud_household_checkpoint c ON c.household_id = h.id
      WHERE h.account_id = ? AND (? IS NULL OR h.id = ?) ORDER BY h.created_at, h.id`,
    )
      .bind(
        principal.account.id,
        principal.method === "device" ? (principal.householdId ?? null) : null,
        principal.householdId ?? null,
      )
      .all<HouseholdRow>();
    return json({
      account: principal.account,
      households: rows.results.map(publicHousehold),
    });
  }
  if (
    principal.method !== "device" ||
    principal.purpose !== "login" ||
    !principal.deviceId
  )
    throw new HttpError(403, "home_server_required");
  const input = record(await body(request, 2048));
  if (request.method === "PUT" && id) {
    await requireHousehold(env, principal, id, true);
    const name = string(input.name, 120);
    const result = await env.DB.prepare(
      `UPDATE cloud_household SET name=?,updated_at=? WHERE id=? AND account_id=? AND merged_into IS NULL
      AND EXISTS(SELECT 1 FROM cloud_device WHERE id=? AND account_id=? AND household_id=? AND revoked_at IS NULL)`,
    )
      .bind(
        name,
        now,
        id,
        principal.account.id,
        principal.deviceId,
        principal.account.id,
        id,
      )
      .run();
    if (!result.meta.changes) throw new HttpError(409, "household_conflict");
    return json({
      ok: true,
      household: publicHousehold(
        await requireHousehold(env, principal, id, true),
      ),
    });
  }
  if (!uuid(input.householdId))
    throw new HttpError(400, "invalid_household_id");
  if (principal.householdId && principal.householdId !== input.householdId)
    throw new HttpError(403, "household_scope_forbidden");
  const name = string(input.name, 120),
    serverId = string(input.serverId, 160);
  const existing = await findHousehold(env, input.householdId);
  if (existing && existing.account_id !== principal.account.id)
    throw new HttpError(409, "household_conflict");
  if (existing?.merged_into) throw new HttpError(409, "household_merged");
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO cloud_household (id,account_id,name,server_id,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM cloud_device WHERE id=? AND account_id=? AND revoked_at IS NULL AND (household_id IS NULL OR household_id=?))`,
    ).bind(
      input.householdId,
      principal.account.id,
      name,
      serverId,
      now,
      now,
      principal.deviceId,
      principal.account.id,
      input.householdId,
    ),
    env.DB.prepare(
      `UPDATE cloud_device SET household_id = ? WHERE id = ? AND account_id = ?
      AND (household_id IS NULL OR household_id = ?) AND revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM cloud_household WHERE id = ? AND account_id = ?)`,
    ).bind(
      input.householdId,
      principal.deviceId,
      principal.account.id,
      input.householdId,
      input.householdId,
      principal.account.id,
    ),
    env.DB.prepare(
      `UPDATE cloud_household SET name=?,server_id=?,updated_at=? WHERE id=? AND account_id=? AND merged_into IS NULL
      AND EXISTS(SELECT 1 FROM cloud_device WHERE id=? AND account_id=? AND household_id=? AND revoked_at IS NULL)`,
    ).bind(
      name,
      serverId,
      now,
      input.householdId,
      principal.account.id,
      principal.deviceId,
      principal.account.id,
      input.householdId,
    ),
  ]);
  if (!results[1]?.meta.changes) throw new HttpError(409, "household_conflict");
  const registered = await requireHousehold(env, principal, input.householdId);
  return json({
    ok: true,
    account: principal.account,
    household: publicHousehold(registered),
  });
}

export async function detachHousehold(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  id: string,
): Promise<Response> {
  await requireHousehold(env, principal, id, true);
  if (
    principal.method === "browser" &&
    (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
  )
    throw new HttpError(403, "reauth_required");
  const result =
    principal.method === "device"
      ? await env.DB.prepare(
          "UPDATE cloud_device SET revoked_at = ? WHERE id = ? AND household_id = ? AND account_id = ? AND revoked_at IS NULL",
        )
          .bind(now, principal.deviceId, id, principal.account.id)
          .run()
      : await env.DB.prepare(
          "UPDATE cloud_device SET revoked_at = ? WHERE household_id = ? AND account_id = ? AND revoked_at IS NULL",
        )
          .bind(now, id, principal.account.id)
          .run();
  void request;
  return json({
    ok: true,
    disconnected: result.meta.changes,
    householdPreserved: true,
  });
}
