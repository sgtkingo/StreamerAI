import { HttpError } from "./http.js";
import type { Env, Principal } from "./types.js";

/** Migration 0011 had to invent an identity when an account had no checkpoint.
 * Reattach that namespace only when its complete profile set proves that it is
 * this server's household. Real households must use the explicit merge flow.
 */
export async function legacyHouseholdStatements(
  env: Env,
  principal: Principal,
  targetId: string,
  profileIds: unknown,
  now: number,
): Promise<D1PreparedStatement[]> {
  if (profileIds === undefined) return [];
  if (
    !Array.isArray(profileIds) ||
    profileIds.length > 5 ||
    profileIds.some((id) => typeof id !== "string" || !id || id.length > 160) ||
    new Set(profileIds).size !== profileIds.length
  )
    throw new HttpError(400, "invalid_profile_ids");
  if (!profileIds.length) return [];
  const placeholders = profileIds.map(() => "?").join(",");
  const overlaps = await env.DB.prepare(
    `SELECT DISTINCT account_id FROM cloud_household_sync_profile WHERE id IN (${placeholders}) AND account_id<>?`,
  )
    .bind(...profileIds, targetId)
    .all<{ account_id: string }>();
  if (!overlaps.results.length) return [];
  if (overlaps.results.length !== 1)
    throw new HttpError(409, "household_profile_conflict");
  const sourceId = overlaps.results[0]!.account_id;
  const eligible = await env.DB.prepare(
    `SELECT id FROM cloud_household h WHERE id=? AND account_id=?
    AND server_id='migrated' AND created_at=0 AND updated_at=0 AND merged_into IS NULL
    AND NOT EXISTS(SELECT 1 FROM cloud_household_checkpoint WHERE household_id=h.id)
    AND NOT EXISTS(SELECT 1 FROM cloud_device WHERE household_id=h.id AND revoked_at IS NULL AND expires_at>?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_request WHERE (source_household_id=h.id OR target_household_id=h.id)
      AND status IN ('pending','approved') AND completed_at IS NULL AND expires_at>?)
    AND (SELECT COUNT(*) FROM cloud_household_sync_profile WHERE account_id=h.id AND active=1)=?
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_profile WHERE account_id=h.id AND active=1 AND id NOT IN (${placeholders}))
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_profile WHERE account_id=?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_entity WHERE account_id=?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_account_entity WHERE account_id=?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_log WHERE account_id=?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_operation_receipt WHERE account_id=?)
    AND NOT EXISTS(SELECT 1 FROM cloud_household_sync_retention WHERE account_id=?)`,
  )
    .bind(
      sourceId,
      principal.account.id,
      now,
      now,
      profileIds.length,
      ...profileIds,
      targetId,
      targetId,
      targetId,
      targetId,
      targetId,
      targetId,
    )
    .first();
  if (!eligible) throw new HttpError(409, "household_profile_conflict");
  const guard = `EXISTS(SELECT 1 FROM cloud_household h JOIN cloud_device d
    ON d.household_id=? AND d.account_id=h.account_id
    WHERE h.id=? AND h.account_id=? AND h.server_id='migrated'
    AND h.created_at=0 AND h.updated_at=0 AND h.merged_into IS NULL
    AND d.id=? AND d.revoked_at IS NULL AND d.expires_at>?)`;
  const guardValues = [
    targetId,
    sourceId,
    principal.account.id,
    principal.deviceId!,
    now,
  ];
  return [
    // All updates join the registration batch: readers never see partial moves.
    ...[
      "cloud_household_sync_profile",
      "cloud_household_sync_entity",
      "cloud_household_sync_account_entity",
      "cloud_household_sync_log",
      "cloud_household_sync_operation_receipt",
      "cloud_household_sync_retention",
    ].map((table) =>
      env.DB.prepare(
        `UPDATE ${table} SET account_id=? WHERE account_id=? AND ${guard}`,
      ).bind(targetId, sourceId, ...guardValues),
    ),
    // Removing the synthetic row also retires its completed/denied requests.
    // The live household identity and encrypted checkpoint stay untouched.
    env.DB.prepare(`DELETE FROM cloud_household WHERE id=? AND ${guard}`).bind(
      sourceId,
      ...guardValues,
    ),
  ];
}
