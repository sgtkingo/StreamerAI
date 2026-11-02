import { owner } from "./devices.js";
import { sendApprovalMail } from "./approval-mail.js";
import {
  body,
  enforceRateLimit,
  HttpError,
  json,
  randomToken,
  record,
  sameOrigin,
  string,
} from "./http.js";
import { cursor, databaseError } from "./sync.js";
import { removeProfileStatements } from "./profile-removal.js";
import type { Env, Principal } from "./types.js";

interface Transfer {
  id: string;
  profile_id: string;
  source_account_id: string;
  target_account_id: string;
  ownership_epoch: number;
  expires_at: number;
  accepted_at: number | null;
}

export async function listProfiles(
  env: Env,
  principal: Principal,
): Promise<Response> {
  owner(principal);
  const profiles = await env.DB.prepare(
    `
    SELECT p.id, e.operation_json FROM cloud_profile p JOIN cloud_entity e ON e.profile_id = p.id AND e.account_id = p.account_id
    WHERE p.account_id = ? AND p.active = 1 AND e.kind = 'profile' AND e.action = 'upsert'
  `,
  )
    .bind(principal.account.id)
    .all<{ id: string; operation_json: string }>();
  return json({
    profiles: profiles.results.map((row) => ({
      id: row.id,
      name: (JSON.parse(row.operation_json) as { payload: { name: string } })
        .payload.name,
    })),
  });
}

export async function createTransfer(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  if (!principal.authenticatedAt || now - principal.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
  await enforceRateLimit(
    env.DB,
    `transfer-create:${principal.account.id}`,
    5,
    600,
    now,
  );
  const input = record(await body(request, 2048));
  const profileId = string(input.profileId, 160);
  const targetIdentifier = string(input.target ?? input.targetEmail, 320);
  const profile = await env.DB.prepare(
    "SELECT ownership_epoch FROM cloud_profile WHERE id = ? AND account_id = ? AND active = 1",
  )
    .bind(profileId, principal.account.id)
    .first<{ ownership_epoch: number }>();
  if (!profile) throw new HttpError(404, "profile_not_found");
  const target = await env.DB.prepare(
    'SELECT id FROM "user" WHERE id = ? OR (lower(email) = ? AND "emailVerified" = 1) ORDER BY (id = ?) DESC LIMIT 1',
  )
    .bind(targetIdentifier, targetIdentifier.toLowerCase(), targetIdentifier)
    .first<{ id: string }>();
  if (!target || target.id === principal.account.id)
    throw new HttpError(400, "target_account_unavailable");
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `
    INSERT INTO cloud_transfer
      (id, profile_id, source_account_id, target_account_id, ownership_epoch, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
  )
    .bind(
      id,
      profileId,
      principal.account.id,
      target.id,
      profile.ownership_epoch,
      now,
      now + 86_400_000,
    )
    .run();
  const emailStatus = await sendApprovalMail(
    env,
    {
      targetAccountId: target.id,
      kind: "transfer",
      requestId: id,
    },
    now,
  );
  return json({ id, expires_at: now + 86_400_000, emailStatus }, 201);
}

export async function listTransfers(
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  const transfers = await env.DB.prepare(
    `
    SELECT t.id, t.profile_id, t.source_account_id, t.target_account_id, t.expires_at,
      s.email AS source_email, d.email AS target_email, e.operation_json
    FROM cloud_transfer t JOIN "user" s ON s.id = t.source_account_id
    JOIN "user" d ON d.id = t.target_account_id
    JOIN cloud_profile p ON p.id = t.profile_id AND p.account_id = t.source_account_id AND p.active = 1
      AND p.ownership_epoch = t.ownership_epoch
    JOIN cloud_entity e ON e.account_id = t.source_account_id AND e.profile_id = t.profile_id AND e.kind = 'profile'
    WHERE (t.source_account_id = ? OR t.target_account_id = ?) AND t.expires_at > ? AND t.accepted_at IS NULL
    ORDER BY t.created_at DESC LIMIT 50
  `,
  )
    .bind(principal.account.id, principal.account.id, now)
    .all<{
      id: string;
      profile_id: string;
      source_account_id: string;
      target_account_id: string;
      expires_at: number;
      source_email: string;
      target_email: string;
      operation_json: string;
    }>();
  return json({
    transfers: transfers.results.map(({ operation_json, ...row }) => ({
      ...row,
      target_email:
        row.target_account_id === principal.account.id
          ? row.target_email
          : null,
      profile_name: (
        JSON.parse(operation_json) as { payload: { name: string } }
      ).payload.name,
      incoming: row.target_account_id === principal.account.id,
    })),
  });
}

export async function acceptTransfer(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  if (!principal.authenticatedAt || now - principal.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
  await enforceRateLimit(
    env.DB,
    `transfer-accept:${principal.account.id}`,
    10,
    600,
    now,
  );
  const transfer = await env.DB.prepare(
    "SELECT * FROM cloud_transfer WHERE id = ? AND target_account_id = ? AND accepted_at IS NULL AND expires_at > ?",
  )
    .bind(id, principal.account.id, now)
    .first<Transfer>();
  if (!transfer) throw new HttpError(404, "transfer_not_found");
  const input = record(await body(request, 4096));
  const removeProfileIds = input.removeProfileIds ?? [];
  if (
    !Array.isArray(removeProfileIds) ||
    removeProfileIds.length > 5 ||
    removeProfileIds.some(
      (value) => typeof value !== "string" || !value || value.length > 160,
    ) ||
    new Set(removeProfileIds).size !== removeProfileIds.length
  ) {
    throw new HttpError(400, "invalid_request");
  }
  const sourceCursor = Number(await cursor(env, transfer.source_account_id));
  const targetCursor = Number(await cursor(env, transfer.target_account_id));
  const latest = await env.DB.prepare(
    `SELECT MAX(updated_at) AS updated_at FROM cloud_entity WHERE profile_id IN (${[transfer.profile_id, ...removeProfileIds].map(() => "?").join(", ")})`,
  )
    .bind(transfer.profile_id, ...removeProfileIds)
    .first<{ updated_at: string | null }>();
  const updatedAt = new Date(
    Math.max(now, latest?.updated_at ? Date.parse(latest.updated_at) : 0) + 1,
  ).toISOString();
  const nonce = randomToken();
  const tombstoneId = crypto.randomUUID();
  const tombstone = JSON.stringify({
    id: tombstoneId,
    profileId: transfer.profile_id,
    kind: "profile",
    entityId: transfer.profile_id,
    action: "delete",
    updatedAt,
    payload: null,
  });
  const guarded =
    "EXISTS(SELECT 1 FROM cloud_transfer WHERE id = ? AND accept_nonce = ?)";
  const guardBindings = [id, nonce];
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cloud_transfer SET accepted_at = ?, accept_nonce = ?, source_cursor = ?, target_cursor = ?
        WHERE id = ? AND target_account_id = ? AND accepted_at IS NULL AND expires_at > ?
          ${removeProfileIds.length ? `AND (SELECT COUNT(*) FROM cloud_profile WHERE account_id = ? AND active = 1 AND id IN (${removeProfileIds.map(() => "?").join(", ")})) = ?` : ""}`,
      ).bind(
        now,
        nonce,
        sourceCursor,
        targetCursor,
        id,
        principal.account.id,
        now,
        ...(removeProfileIds.length
          ? [principal.account.id, ...removeProfileIds, removeProfileIds.length]
          : []),
      ),
      ...removeProfileIds.flatMap((profileId: string) =>
        removeProfileStatements(
          env,
          transfer.target_account_id,
          profileId,
          updatedAt,
          now,
          guarded,
          guardBindings,
        ),
      ),
      env.DB.prepare(
        `UPDATE cloud_profile SET account_id = ?, ownership_epoch = ownership_epoch + 1, updated_at = ?
        WHERE id = ? AND account_id = ? AND active = 1 AND ownership_epoch = ? AND ${guarded}`,
      ).bind(
        transfer.target_account_id,
        updatedAt,
        transfer.profile_id,
        transfer.source_account_id,
        transfer.ownership_epoch,
        ...guardBindings,
      ),
      env.DB.prepare(
        `DELETE FROM cloud_entity WHERE account_id = ? AND profile_id = ? AND ${guarded}`,
      ).bind(transfer.target_account_id, transfer.profile_id, ...guardBindings),
      // MATERIALIZED keeps each generated UUID identical in the column and the JSON.
      env.DB.prepare(
        `WITH moved AS MATERIALIZED (
        SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
          || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) AS new_id
        FROM cloud_entity WHERE account_id = ? AND profile_id = ? AND ${guarded}
      ) INSERT INTO cloud_entity
        (account_id, profile_id, kind, entity_id, operation_id, action, updated_at, session_started_at, operation_json)
      SELECT ?, profile_id, kind, entity_id, new_id, action, ?, session_started_at,
        json_set(operation_json, '$.id', new_id, '$.updatedAt', ?) FROM moved
        ORDER BY CASE WHEN kind = 'profile' THEN 0 ELSE 1 END, kind, entity_id`,
      ).bind(
        transfer.source_account_id,
        transfer.profile_id,
        ...guardBindings,
        transfer.target_account_id,
        updatedAt,
        updatedAt,
      ),
      env.DB.prepare(
        `INSERT INTO cloud_sync_log
        (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
        SELECT account_id, profile_id, kind, action, operation_id, operation_json, ? FROM cloud_entity
        WHERE account_id = ? AND profile_id = ? AND ${guarded}
        ORDER BY CASE WHEN kind = 'profile' THEN 0 ELSE 1 END, kind, entity_id`,
      ).bind(
        now,
        transfer.target_account_id,
        transfer.profile_id,
        ...guardBindings,
      ),
      env.DB.prepare(
        `DELETE FROM cloud_entity WHERE account_id = ? AND profile_id = ? AND ${guarded}`,
      ).bind(transfer.source_account_id, transfer.profile_id, ...guardBindings),
      env.DB.prepare(
        `INSERT INTO cloud_entity
        (account_id, profile_id, kind, entity_id, operation_id, action, updated_at, operation_json)
        SELECT ?, ?, 'profile', ?, ?, 'delete', ?, ? WHERE ${guarded}`,
      ).bind(
        transfer.source_account_id,
        transfer.profile_id,
        transfer.profile_id,
        tombstoneId,
        updatedAt,
        tombstone,
        ...guardBindings,
      ),
      env.DB.prepare(
        `INSERT INTO cloud_sync_log
        (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
        SELECT ?, ?, 'profile', 'delete', ?, ?, ? WHERE ${guarded}`,
      ).bind(
        transfer.source_account_id,
        transfer.profile_id,
        tombstoneId,
        tombstone,
        now,
        ...guardBindings,
      ),
    ]);
    if (
      !result[0]?.meta.changes ||
      !result[1 + removeProfileIds.length * 4]?.meta.changes
    )
      throw new HttpError(409, "transfer_changed");
  } catch (error) {
    databaseError(error);
  }
  return json({ ok: true, profileId: transfer.profile_id });
}

export async function declineTransfer(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  if (!principal.authenticatedAt || now - principal.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
  await enforceRateLimit(
    env.DB,
    `transfer-decline:${principal.account.id}`,
    10,
    600,
    now,
  );
  const result = await env.DB.prepare(
    "DELETE FROM cloud_transfer WHERE id = ? AND target_account_id = ? AND accepted_at IS NULL AND expires_at > ?",
  )
    .bind(id, principal.account.id, now)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "transfer_not_found");
  return json({ ok: true });
}
