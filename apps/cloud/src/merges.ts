import { owner } from "./devices.js";
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
import { sendApprovalMail } from "./approval-mail.js";
import { removeProfileStatements } from "./profile-removal.js";
import { cursor, databaseError } from "./sync.js";
import type { Env, Principal } from "./types.js";

interface Merge {
  id: string;
  source_account_id: string;
  target_account_id: string;
  requested_by: string;
  approver_id: string;
  expires_at: number;
  source_email: string;
  target_email: string;
}

function fresh(principal: Principal, now: number) {
  owner(principal);
  if (!principal.authenticatedAt || now - principal.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
}

export async function createMerge(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
) {
  sameOrigin(request, env.AUTH_ORIGIN);
  fresh(principal, now);
  await enforceRateLimit(
    env.DB,
    `merge-create:${principal.account.id}`,
    5,
    600,
    now,
  );
  const input = record(await body(request, 2048));
  const target = string(input.target, 320);
  const other = await env.DB.prepare(
    'SELECT id FROM "user" WHERE id = ? OR (lower(email) = ? AND "emailVerified" = 1) ORDER BY id = ? DESC LIMIT 1',
  )
    .bind(target, target.toLowerCase(), target)
    .first<{ id: string }>();
  if (!other || other.id === principal.account.id)
    throw new HttpError(400, "target_account_unavailable");
  const enabled = await env.DB.prepare(
    `SELECT id AS user_id FROM "user" u WHERE id IN (?, ?)
      AND (EXISTS(SELECT 1 FROM cloud_email_login e WHERE e.user_id = u.id)
        OR NOT EXISTS(SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'google'))`,
  )
    .bind(principal.account.id, other.id)
    .all<{ user_id: string }>();
  if (enabled.results.length > 1)
    throw new HttpError(409, "merge_email_conflict");
  const survivor = enabled.results[0]?.user_id ?? principal.account.id;
  const source =
    survivor === principal.account.id ? other.id : principal.account.id;
  const id = crypto.randomUUID();
  const expiresAt = now + 86_400_000;
  await env.DB.prepare(
    `INSERT INTO cloud_account_merge
    (id, source_account_id, target_account_id, requested_by, approver_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, source, survivor, principal.account.id, other.id, now, expiresAt)
    .run();
  const emailStatus = await sendApprovalMail(
    env,
    { targetAccountId: other.id, kind: "merge", requestId: id },
    now,
  );
  return json(
    {
      id,
      expires_at: expiresAt,
      source_account_id: source,
      target_account_id: survivor,
      emailStatus,
    },
    201,
  );
}

export async function listMerges(env: Env, principal: Principal, now: number) {
  owner(principal);
  const rows = await env.DB.prepare(
    `SELECT m.id, m.source_account_id, m.target_account_id, m.requested_by,
    m.approver_id, m.expires_at, s.email AS source_email, t.email AS target_email
    FROM cloud_account_merge m JOIN "user" s ON s.id = m.source_account_id
    JOIN "user" t ON t.id = m.target_account_id
    WHERE (m.requested_by = ? OR m.approver_id = ?) AND m.accepted_at IS NULL AND m.expires_at > ?
    ORDER BY m.created_at DESC LIMIT 50`,
  )
    .bind(principal.account.id, principal.account.id, now)
    .all<Merge>();
  const merges = await Promise.all(
    rows.results.map(async (row) => {
      const incoming = row.approver_id === principal.account.id;
      const profiles = await env.DB.prepare(
        `SELECT p.id, p.account_id, e.operation_json FROM cloud_profile p
      JOIN cloud_entity e ON e.account_id = p.account_id AND e.profile_id = p.id AND e.kind = 'profile' AND e.action = 'upsert'
      WHERE p.active = 1 AND (p.account_id = ? OR (p.account_id = ? AND ? = 1))`,
      )
        .bind(principal.account.id, row.requested_by, incoming ? 1 : 0)
        .all<{ id: string; account_id: string; operation_json: string }>();
      return {
        ...row,
        source_email:
          incoming || row.source_account_id === principal.account.id
            ? row.source_email
            : null,
        target_email:
          incoming || row.target_account_id === principal.account.id
            ? row.target_email
            : null,
        incoming,
        profiles: profiles.results.map(({ operation_json, ...profile }) => ({
          ...profile,
          name: (JSON.parse(operation_json) as { payload: { name: string } })
            .payload.name,
        })),
      };
    }),
  );
  return json({ merges });
}

export async function decideMerge(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
  now: number,
) {
  sameOrigin(request, env.AUTH_ORIGIN);
  fresh(principal, now);
  await enforceRateLimit(
    env.DB,
    `merge-decide:${principal.account.id}`,
    10,
    600,
    now,
  );
  const input = record(await body(request, 4096));
  if (typeof input.approve !== "boolean")
    throw new HttpError(400, "invalid_request");
  const merge = await env.DB.prepare(
    `SELECT m.*, s.email AS source_email, t.email AS target_email FROM cloud_account_merge m
    JOIN "user" s ON s.id = m.source_account_id JOIN "user" t ON t.id = m.target_account_id
    WHERE m.id = ? AND m.approver_id = ? AND m.accepted_at IS NULL AND m.expires_at > ?`,
  )
    .bind(id, principal.account.id, now)
    .first<Merge>();
  if (!merge) throw new HttpError(404, "merge_not_found");
  if (!input.approve) {
    const declined = await env.DB.prepare(
      "DELETE FROM cloud_account_merge WHERE id = ? AND approver_id = ? AND accepted_at IS NULL",
    )
      .bind(id, principal.account.id)
      .run();
    if (!declined.meta.changes) throw new HttpError(409, "merge_changed");
    return json({ ok: true });
  }
  if (
    !Array.isArray(input.profileIds) ||
    input.profileIds.length > 5 ||
    input.profileIds.some(
      (id) => typeof id !== "string" || !id || id.length > 160,
    ) ||
    new Set(input.profileIds).size !== input.profileIds.length
  )
    throw new HttpError(400, "invalid_profile_selection");
  if (
    !Array.isArray(input.expectedProfileIds) ||
    input.expectedProfileIds.length > 10 ||
    input.expectedProfileIds.some(
      (id) => typeof id !== "string" || !id || id.length > 160,
    ) ||
    new Set(input.expectedProfileIds).size !== input.expectedProfileIds.length
  )
    throw new HttpError(400, "invalid_profile_selection");
  const selected = input.profileIds as string[];
  const profiles = await env.DB.prepare(
    "SELECT id, account_id FROM cloud_profile WHERE active = 1 AND account_id IN (?, ?)",
  )
    .bind(merge.source_account_id, merge.target_account_id)
    .all<{ id: string; account_id: string }>();
  if (selected.some((id) => !profiles.results.some((p) => p.id === id)))
    throw new HttpError(409, "merge_changed");
  if (
    profiles.results.length !== input.expectedProfileIds.length ||
    profiles.results.some(
      (p) => !(input.expectedProfileIds as string[]).includes(p.id),
    )
  )
    throw new HttpError(409, "merge_changed");
  const [sourceCursor, targetCursor] = await Promise.all([
    cursor(env, merge.source_account_id),
    cursor(env, merge.target_account_id),
  ]);
  // Read the maximum after the cursors. A concurrent write then either appears
  // here or invalidates the cursor guard before any merge mutations execute.
  const latest = await env.DB.prepare(
    "SELECT MAX(updated_at) AS updated_at FROM cloud_entity WHERE account_id IN (?, ?)",
  )
    .bind(merge.source_account_id, merge.target_account_id)
    .first<{ updated_at: string | null }>();
  const updatedAt = new Date(
    Math.max(now, latest?.updated_at ? Date.parse(latest.updated_at) : 0) + 1,
  ).toISOString();
  const nonce = randomToken();
  const guard =
    "EXISTS(SELECT 1 FROM cloud_account_merge WHERE id = ? AND accept_nonce = ?)";
  const bindings = [id, nonce];
  try {
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cloud_account_merge SET accepted_at = ?, accept_nonce = ?, source_cursor = ?, target_cursor = ?, profile_ids_json = ?, seen_profile_ids_json = ?,
          source_profile_ids_json = (SELECT json_group_array(id) FROM cloud_profile WHERE account_id = cloud_account_merge.source_account_id)
        WHERE id = ? AND approver_id = ? AND accepted_at IS NULL AND expires_at > ?`,
      ).bind(
        now,
        nonce,
        Number(sourceCursor),
        Number(targetCursor),
        JSON.stringify(selected),
        JSON.stringify(profiles.results.map((p) => p.id)),
        id,
        principal.account.id,
        now,
      ),
      ...profiles.results
        .filter((p) => !selected.includes(p.id))
        .flatMap((p) =>
          removeProfileStatements(
            env,
            p.account_id,
            p.id,
            updatedAt,
            now,
            guard,
            bindings,
          ),
        ),
      // A source device may have missed a previous profile transfer. Preserve
      // only the source's own deletion notices for that device, without making
      // them entities of the survivor or touching the third party's profile.
      env.DB.prepare(
        `INSERT INTO cloud_merge_device_tombstone (device_id, profile_id, operation_json)
        SELECT d.id, e.profile_id, e.operation_json FROM cloud_device d
        JOIN cloud_entity e ON e.account_id = d.account_id AND e.kind = 'profile' AND e.action = 'delete'
        JOIN cloud_profile p ON p.id = e.profile_id
        WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.purpose = 'login'
          AND p.account_id <> ? AND p.account_id <> ? AND ${guard}
        ON CONFLICT(device_id, profile_id) DO UPDATE SET operation_json = excluded.operation_json
        WHERE json_extract(excluded.operation_json, '$.updatedAt') > json_extract(cloud_merge_device_tombstone.operation_json, '$.updatedAt')`,
      ).bind(
        merge.source_account_id,
        merge.source_account_id,
        merge.target_account_id,
        ...bindings,
      ),
      // A profile may have been transferred away from this account earlier;
      // replace its old tombstone before restoring it from the source account.
      env.DB.prepare(
        `DELETE FROM cloud_entity WHERE account_id = ? AND profile_id IN
        (SELECT id FROM cloud_profile WHERE account_id = ?) AND ${guard}`,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `UPDATE cloud_profile SET account_id = ?, ownership_epoch = ownership_epoch + 1 WHERE account_id = ? AND ${guard}`,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `WITH moved AS MATERIALIZED (
        SELECT *, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
          || '-a' || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))) AS new_id
        FROM cloud_entity WHERE account_id = ? AND profile_id IN
          (SELECT value FROM json_each((SELECT source_profile_ids_json FROM cloud_account_merge WHERE id = ? AND accept_nonce = ?))) AND ${guard}
      ) INSERT INTO cloud_entity (account_id, profile_id, kind, entity_id, operation_id, action, updated_at, session_started_at, operation_json)
      SELECT ?, profile_id, kind, entity_id, new_id, action, ?, session_started_at,
        json_set(operation_json, '$.id', new_id, '$.updatedAt', ?) FROM moved
      ORDER BY CASE WHEN kind = 'profile' THEN 0 ELSE 1 END, kind, entity_id`,
      ).bind(
        merge.source_account_id,
        ...bindings,
        ...bindings,
        merge.target_account_id,
        updatedAt,
        updatedAt,
      ),
      env.DB.prepare(
        `UPDATE cloud_profile SET
        updated_at = (SELECT e.updated_at FROM cloud_entity e WHERE e.account_id = ? AND e.profile_id = cloud_profile.id AND e.kind = 'profile'),
        operation_id = (SELECT e.operation_id FROM cloud_entity e WHERE e.account_id = ? AND e.profile_id = cloud_profile.id AND e.kind = 'profile')
        WHERE account_id = ? AND id IN (SELECT profile_id FROM cloud_entity WHERE account_id = ? AND kind = 'profile')
          AND id IN (SELECT value FROM json_each((SELECT source_profile_ids_json FROM cloud_account_merge WHERE id = ? AND accept_nonce = ?))) AND ${guard}`,
      ).bind(
        merge.target_account_id,
        merge.target_account_id,
        merge.target_account_id,
        merge.target_account_id,
        ...bindings,
        ...bindings,
      ),
      env.DB.prepare(
        `INSERT INTO cloud_sync_log (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
        SELECT e.account_id, e.profile_id, e.kind, e.action, e.operation_id, e.operation_json, ? FROM cloud_entity e
        JOIN cloud_profile p ON p.id = e.profile_id WHERE e.account_id = ? AND e.updated_at = ?
        AND e.profile_id IN (SELECT value FROM json_each((SELECT source_profile_ids_json FROM cloud_account_merge WHERE id = ? AND accept_nonce = ?)))
        AND EXISTS (SELECT 1 FROM cloud_entity old WHERE old.account_id = ? AND old.profile_id = e.profile_id AND old.kind = e.kind AND old.entity_id = e.entity_id) AND ${guard}
        ORDER BY CASE WHEN e.kind = 'profile' THEN 0 ELSE 1 END, e.kind, e.entity_id`,
      ).bind(
        now,
        merge.target_account_id,
        updatedAt,
        ...bindings,
        merge.source_account_id,
        ...bindings,
      ),
      // Account feedback follows an explicit account merge independently of
      // the selected profiles. Preserve the latest judgement for each file.
      env.DB.prepare(
        `
        INSERT INTO cloud_account_entity (account_id, kind, entity_id, operation_id, action, updated_at, operation_json)
        SELECT ?, kind, entity_id, operation_id, action, updated_at, operation_json FROM cloud_account_entity
        WHERE account_id = ? AND ${guard}
        ON CONFLICT(account_id, kind, entity_id) DO UPDATE SET
          operation_id = excluded.operation_id, action = excluded.action,
          updated_at = excluded.updated_at, operation_json = excluded.operation_json
        WHERE excluded.updated_at > cloud_account_entity.updated_at OR
          (excluded.updated_at = cloud_account_entity.updated_at AND excluded.operation_id > cloud_account_entity.operation_id)
      `,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `
        INSERT OR IGNORE INTO cloud_sync_log (account_id, profile_id, kind, action, operation_id, operation_json, created_at)
        SELECT target.account_id, '$account', target.kind, target.action, target.operation_id, target.operation_json, ?
        FROM cloud_account_entity target JOIN cloud_account_entity source
          ON source.account_id = ? AND source.kind = target.kind AND source.entity_id = target.entity_id AND source.operation_id = target.operation_id
        WHERE target.account_id = ? AND ${guard}
      `,
      ).bind(
        now,
        merge.source_account_id,
        merge.target_account_id,
        ...bindings,
      ),
      // Preserve the implicit login of a legacy email-only survivor when
      // adding its first Google identity.
      env.DB.prepare(
        `INSERT OR IGNORE INTO cloud_email_login (user_id, enabled_at)
        SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM account WHERE userId = ? AND providerId = 'google') AND ${guard}`,
      ).bind(
        merge.target_account_id,
        now,
        merge.target_account_id,
        ...bindings,
      ),
      env.DB.prepare(
        `UPDATE account SET userId = ? WHERE userId = ? AND ${guard}`,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `UPDATE session SET userId = ? WHERE userId = ? AND ${guard}`,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `UPDATE cloud_device SET account_id = ?, merged_from_account_id = COALESCE(merged_from_account_id, ?), merge_ack_required = 1 WHERE account_id = ? AND ${guard}`,
      ).bind(
        merge.target_account_id,
        merge.source_account_id,
        merge.source_account_id,
        ...bindings,
      ),
      env.DB.prepare(
        `UPDATE cloud_account_merge_alias SET target_id = ? WHERE target_id = ? AND ${guard}`,
      ).bind(merge.target_account_id, merge.source_account_id, ...bindings),
      env.DB.prepare(
        `INSERT INTO cloud_account_merge_alias (source_id, target_id) SELECT ?, ? WHERE ${guard}`,
      ).bind(merge.source_account_id, merge.target_account_id, ...bindings),
      env.DB.prepare(`DELETE FROM "user" WHERE id = ? AND ${guard}`).bind(
        merge.source_account_id,
        ...bindings,
      ),
    ]);
    if (!result[0]?.meta.changes) throw new HttpError(409, "merge_changed");
  } catch (error) {
    if (error instanceof Error && error.message.includes("merge_changed"))
      throw new HttpError(409, "merge_changed");
    databaseError(error);
  }
  return json({ ok: true, accountId: merge.target_account_id });
}

export async function mergedFrom(
  env: Env,
  principal: Principal,
  oldId: string,
  now: number,
) {
  if (principal.method !== "device")
    throw new HttpError(403, "device_required");
  if (!oldId || oldId.length > 160) throw new HttpError(404, "not_found");
  await enforceRateLimit(
    env.DB,
    `merge-alias:${principal.deviceId}`,
    60,
    60,
    now,
  );
  const alias = await env.DB.prepare(
    "SELECT 1 FROM cloud_account_merge_alias WHERE source_id = ? AND target_id = ?",
  )
    .bind(oldId, principal.account.id)
    .first();
  if (!alias) throw new HttpError(404, "not_found");
  return json({ merged: true });
}

export async function acknowledgeMerge(
  request: Request,
  env: Env,
  principal: Principal,
) {
  if (
    principal.method !== "device" ||
    !principal.deviceId ||
    principal.purpose !== "login"
  )
    throw new HttpError(403, "device_required");
  const input = record(await body(request, 1024));
  if (string(input.accountId, 160) !== principal.account.id)
    throw new HttpError(409, "merge_changed");
  const [result] = await env.DB.batch([
    env.DB.prepare(
      "UPDATE cloud_device SET merge_ack_required = 0 WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    ).bind(principal.deviceId, principal.account.id),
    env.DB.prepare(
      `DELETE FROM cloud_merge_device_tombstone WHERE device_id = ? AND EXISTS (
      SELECT 1 FROM cloud_device WHERE id = ? AND account_id = ? AND revoked_at IS NULL AND merge_ack_required = 0)`,
    ).bind(principal.deviceId, principal.deviceId, principal.account.id),
  ]);
  if (!result?.meta.changes) throw new HttpError(409, "merge_changed");
  return json({ ok: true });
}

export async function mergeTombstones(
  request: Request,
  env: Env,
  principal: Principal,
) {
  if (
    principal.method !== "device" ||
    !principal.deviceId ||
    principal.purpose !== "login"
  )
    throw new HttpError(403, "device_required");
  const after = new URL(request.url).searchParams.get("after") ?? "";
  if (after.length > 160) throw new HttpError(400, "invalid_cursor");
  const [device, rows] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id FROM cloud_device WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
    ).bind(principal.deviceId, principal.account.id),
    env.DB.prepare(
      `SELECT t.profile_id, t.operation_json FROM cloud_merge_device_tombstone t
      JOIN cloud_device d ON d.id = t.device_id AND d.account_id = ? AND d.revoked_at IS NULL
      LEFT JOIN cloud_profile p ON p.id = t.profile_id
      WHERE t.device_id = ? AND t.profile_id > ? AND (p.id IS NULL OR p.account_id <> d.account_id) ORDER BY t.profile_id LIMIT 101`,
    ).bind(principal.account.id, principal.deviceId, after),
  ]);
  if (!device?.results.length) throw new HttpError(409, "merge_changed");
  const tombstones = rows?.results as Array<{
    profile_id: string;
    operation_json: string;
  }>;
  const page = tombstones.slice(0, 100);
  return json({
    accountId: principal.account.id,
    operations: page.map((row) => JSON.parse(row.operation_json)),
    next: tombstones.length > 100 ? (page.at(-1)?.profile_id ?? null) : null,
  });
}
