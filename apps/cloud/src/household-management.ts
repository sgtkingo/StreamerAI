import {
  MasterPinHouseholdBackupSchema,
  type AccountSyncOperation,
} from "@streamer-ai/contracts";
import {
  body,
  enforceRateLimit,
  hash,
  HttpError,
  json,
  record,
  string,
} from "./http.js";
import {
  findHousehold,
  requireHousehold,
  type HouseholdRow,
  uuid,
} from "./households.js";
import type { Env, Principal } from "./types.js";

interface RequestRow {
  id: string;
  kind: "ownership-transfer" | "profile-transfer" | "merge";
  source_household_id: string;
  target_household_id: string | null;
  source_account_id: string;
  target_account_id: string;
  profile_id: string | null;
  source_version: number;
  target_version: number | null;
  snapshot_hash: string | null;
  status: string;
  completed_at: number | null;
  approved_at: number | null;
  source_revision: number | null;
  target_revision: number | null;
  source_cursor: number | null;
  expires_at: number;
}
function fresh(principal: Principal, now: number) {
  if (principal.method !== "browser")
    throw new HttpError(403, "browser_sign_in_required");
  if (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
    throw new HttpError(403, "reauth_required");
}
async function state(env: Env, id: string) {
  const [profiles, entities, feedback, log] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id,active,ownership_epoch FROM cloud_household_sync_profile WHERE account_id=? ORDER BY id",
    ).bind(id),
    env.DB.prepare(
      "SELECT profile_id,kind,entity_id,operation_json FROM cloud_household_sync_entity WHERE account_id=? ORDER BY profile_id,kind,entity_id",
    ).bind(id),
    env.DB.prepare(
      "SELECT entity_id,operation_json FROM cloud_household_sync_account_entity WHERE account_id=? ORDER BY entity_id",
    ).bind(id),
    env.DB.prepare(
      "SELECT COALESCE(MAX(seq),0) AS seq FROM cloud_household_sync_log WHERE account_id=?",
    ).bind(id),
  ]);
  return {
    digest: await hash(
      JSON.stringify([profiles!.results, entities!.results, feedback!.results]),
    ),
    cursor: Number((log!.results[0] as { seq: number }).seq),
    profiles: profiles!.results as unknown as {
      id: string;
      active: number;
      ownership_epoch: number;
    }[],
  };
}

export async function listHouseholdProfiles(
  env: Env,
  principal: Principal,
  id: string,
) {
  await requireHousehold(env, principal, id);
  const profiles = await env.DB.prepare(
    `SELECT p.id,e.operation_json FROM cloud_household_sync_profile p
    JOIN cloud_household_sync_entity e ON e.account_id=p.account_id AND e.profile_id=p.id AND e.kind='profile' AND e.action='upsert'
    WHERE p.account_id=? AND p.active=1 ORDER BY p.id`,
  )
    .bind(id)
    .all<{ id: string; operation_json: string }>();
  return json({
    profiles: profiles.results.map(({ id, operation_json }) => ({
      id,
      name: (JSON.parse(operation_json) as { payload: { name: string } })
        .payload.name,
    })),
  });
}

export async function householdRequests(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  householdId?: string,
  kind?: RequestRow["kind"],
): Promise<Response> {
  if (request.method === "GET") {
    if (
      principal.method !== "browser" &&
      (!principal.householdId || principal.purpose !== "login")
    )
      throw new HttpError(403, "browser_sign_in_required");
    const rows = await env.DB.prepare(
      `SELECT r.*,s.name AS source_name,t.name AS target_name,u.email AS target_email
      FROM cloud_household_request r JOIN cloud_household s ON s.id=r.source_household_id
      LEFT JOIN cloud_household t ON t.id=r.target_household_id JOIN "user" u ON u.id=r.target_account_id
      WHERE (r.source_account_id=? OR r.target_account_id=?) AND r.expires_at>? AND (r.status='pending' OR (r.status='approved' AND r.completed_at IS NULL))
      AND (? IS NULL OR (r.kind='merge' AND r.target_household_id=?))
      ORDER BY r.created_at DESC LIMIT 100`,
    )
      .bind(
        principal.account.id,
        principal.account.id,
        now,
        principal.method === "device" ? principal.householdId : null,
        principal.householdId ?? null,
      )
      .all<RequestRow>();
    return json({
      requests: rows.results.map((row) => ({
        ...row,
        incoming: row.target_account_id === principal.account.id,
        requiresLocalImport:
          row.status === "approved" && row.completed_at === null,
      })),
    });
  }
  fresh(principal, now);
  if (!householdId || !kind)
    throw new HttpError(400, "invalid_household_request");
  const source = await requireHousehold(env, principal, householdId);
  if (source.merged_into) throw new HttpError(409, "household_merged");
  await enforceRateLimit(
    env.DB,
    `household-request:${principal.account.id}`,
    10,
    600,
    now,
  );
  const input = record(await body(request, 2048));
  let targetAccount: string,
    target: HouseholdRow | null = null,
    profileId: string | null = null,
    snapshotHash: string | null = null;
  if (kind === "ownership-transfer") {
    const identifier = string(
      input.targetAccountId ?? input.target ?? input.targetEmail,
      320,
    );
    const account = await env.DB.prepare(
      'SELECT id FROM "user" WHERE id=? OR (lower(email)=? AND "emailVerified"=1) ORDER BY (id=?) DESC LIMIT 1',
    )
      .bind(identifier, identifier.toLowerCase(), identifier)
      .first<{ id: string }>();
    if (!account || account.id === principal.account.id)
      throw new HttpError(400, "target_account_unavailable");
    targetAccount = account.id;
  } else {
    if (!uuid(input.targetHouseholdId))
      throw new HttpError(400, "invalid_household_id");
    target = await findHousehold(env, input.targetHouseholdId);
    if (!target || target.id === source.id || target.merged_into)
      throw new HttpError(404, "target_household_unavailable");
    targetAccount = target.account_id;
    if (kind === "profile-transfer") {
      profileId = string(input.profileId, 160);
      const profile = await env.DB.prepare(
        "SELECT 1 FROM cloud_household_sync_profile WHERE id=? AND account_id=? AND active=1",
      )
        .bind(profileId, source.id)
        .first();
      if (!profile) throw new HttpError(404, "profile_not_found");
    }
    const [sourceState, targetState] = await Promise.all([
      state(env, source.id),
      state(env, target.id),
    ]);
    if (
      targetState.profiles.filter((p) => p.active).length +
        (kind === "merge"
          ? sourceState.profiles.filter((p) => p.active).length
          : 1) >
      5
    )
      throw new HttpError(409, "profile_limit");
    snapshotHash = await hash(
      JSON.stringify([sourceState.digest, targetState.digest]),
    );
  }
  const id = crypto.randomUUID(),
    expiresAt = now + 86_400_000;
  await env.DB.prepare(
    `INSERT INTO cloud_household_request(id,kind,source_household_id,target_household_id,source_account_id,target_account_id,profile_id,source_version,target_version,snapshot_hash,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      kind,
      source.id,
      target?.id ?? null,
      source.account_id,
      targetAccount,
      profileId,
      source.ownership_version,
      target?.ownership_version ?? null,
      snapshotHash,
      now,
      expiresAt,
    )
    .run();
  if (kind !== "ownership-transfer" && targetAccount === principal.account.id) {
    try {
      const decision = await decideHouseholdRequest(
        new Request(request.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approve: true }),
        }),
        env,
        principal,
        now,
        id,
      );
      const result = (await decision.json()) as Record<string, unknown>;
      return json({ ...result, id, expiresAt }, 201);
    } catch (error) {
      await env.DB.prepare(
        "DELETE FROM cloud_household_request WHERE id=? AND status='pending'",
      )
        .bind(id)
        .run();
      throw error;
    }
  }
  return json({ id, expiresAt, emailStatus: "unavailable" }, 201);
}

async function moveProfile(
  env: Env,
  requestId: string,
  nonce: string,
  source: string,
  target: string,
  profileId: string,
  now: number,
): Promise<D1PreparedStatement[]> {
  const guard =
    "EXISTS(SELECT 1 FROM cloud_household_request WHERE id=? AND accept_nonce=? AND status='approved')";
  const bindings = [requestId, nonce];
  const [entities, feedback, previous, duplicate] = await Promise.all([
    env.DB.prepare(
      "SELECT operation_json FROM cloud_household_sync_entity WHERE account_id=? AND profile_id=? ORDER BY kind,entity_id",
    )
      .bind(source, profileId)
      .all<{ operation_json: string }>(),
    env.DB.prepare(
      "SELECT entity_id,operation_json FROM cloud_household_sync_account_entity WHERE account_id=? AND action='upsert' AND json_extract(operation_json,'$.payload.profileId')=?",
    )
      .bind(source, profileId)
      .all<{ entity_id: string; operation_json: string }>(),
    env.DB.prepare(
      "SELECT updated_at FROM cloud_household_sync_entity WHERE account_id=? AND profile_id=?",
    )
      .bind(target, profileId)
      .all<{ updated_at: string }>(),
    env.DB.prepare(
      `SELECT 1 FROM cloud_household_sync_account_entity s JOIN cloud_household_sync_account_entity t ON t.kind=s.kind AND t.entity_id=s.entity_id
      WHERE s.account_id=? AND t.account_id=? AND s.action='upsert' AND t.action='upsert' AND json_extract(s.operation_json,'$.payload.profileId')=? AND s.operation_json<>t.operation_json LIMIT 1`,
    )
      .bind(source, target, profileId)
      .first(),
  ]);
  if (duplicate) throw new HttpError(409, "transfer_data_conflict");
  const originals = entities.results.map(
    (row) => JSON.parse(row.operation_json) as AccountSyncOperation,
  );
  const votes = feedback.results.map((row) => ({
    ...row,
    original: JSON.parse(row.operation_json) as AccountSyncOperation,
  }));
  // Fresh operation IDs and timestamps also make a move back to an earlier
  // household observable to clients that already consumed the original log.
  const latest = Math.max(
    now,
    ...originals.map((o) => Date.parse(o.updatedAt)),
    ...votes.map((o) => Date.parse(o.original.updatedAt)),
    ...previous.results.map((o) => Date.parse(o.updated_at)),
  );
  const updatedAt = new Date(latest + 1).toISOString();
  const profile = originals.find((o) => o.kind === "profile");
  if (!profile) throw new HttpError(409, "profile_not_found");
  const ids = Object.fromEntries(
    originals.map((o) => [o.id, crypto.randomUUID()]),
  );
  const entityIds = JSON.stringify(ids),
    feedbackIds = JSON.stringify(
      Object.fromEntries(
        votes.map((v) => [
          v.entity_id,
          [crypto.randomUUID(), crypto.randomUUID()],
        ]),
      ),
    );
  const deleteId = crypto.randomUUID(),
    tombstone = JSON.stringify({
      id: deleteId,
      profileId,
      entityId: profileId,
      kind: "profile",
      action: "delete",
      updatedAt,
      payload: null,
    });
  // SQL copies whole collections; batch size stays bounded for large libraries.
  const statements = [
    env.DB.prepare(
      `UPDATE cloud_household_sync_profile SET account_id=?,ownership_epoch=ownership_epoch+1,updated_at=?,operation_id=? WHERE id=? AND account_id=? AND active=1 AND ${guard}`,
    ).bind(target, updatedAt, ids[profile.id], profileId, source, ...bindings),
    env.DB.prepare(
      `INSERT INTO cloud_household_sync_entity(account_id,profile_id,kind,entity_id,operation_id,action,updated_at,session_started_at,operation_json)
      SELECT ?,e.profile_id,e.kind,e.entity_id,j.value,e.action,?,e.session_started_at,json_set(e.operation_json,'$.id',j.value,'$.updatedAt',?)
      FROM cloud_household_sync_entity e JOIN json_each(?) j ON j.key=e.operation_id WHERE e.account_id=? AND e.profile_id=? AND ${guard}
      ON CONFLICT(account_id,profile_id,kind,entity_id) DO UPDATE SET operation_id=excluded.operation_id,action=excluded.action,updated_at=excluded.updated_at,session_started_at=excluded.session_started_at,operation_json=excluded.operation_json`,
    ).bind(
      target,
      updatedAt,
      updatedAt,
      entityIds,
      source,
      profileId,
      ...bindings,
    ),
    env.DB.prepare(
      `INSERT INTO cloud_household_sync_log(account_id,profile_id,kind,action,operation_id,operation_json,created_at)
      SELECT e.account_id,e.profile_id,e.kind,e.action,e.operation_id,e.operation_json,? FROM cloud_household_sync_entity e JOIN json_each(?) j ON j.value=e.operation_id WHERE e.account_id=? AND e.profile_id=? AND ${guard}`,
    ).bind(now, entityIds, target, profileId, ...bindings),
    env.DB.prepare(
      `DELETE FROM cloud_household_sync_entity WHERE account_id=? AND profile_id=? AND ${guard}`,
    ).bind(source, profileId, ...bindings),
    env.DB.prepare(
      `INSERT INTO cloud_household_sync_entity(account_id,profile_id,kind,entity_id,operation_id,action,updated_at,operation_json) SELECT ?,?,'profile',?,?,'delete',?,? WHERE ${guard}`,
    ).bind(
      source,
      profileId,
      profileId,
      deleteId,
      updatedAt,
      tombstone,
      ...bindings,
    ),
    env.DB.prepare(
      `INSERT INTO cloud_household_sync_log(account_id,profile_id,kind,action,operation_id,operation_json,created_at) SELECT ?,?,'profile','delete',?,?,? WHERE ${guard}`,
    ).bind(source, profileId, deleteId, tombstone, now, ...bindings),
  ];
  if (votes.length)
    statements.push(
      env.DB.prepare(
        `INSERT INTO cloud_household_sync_account_entity(account_id,kind,entity_id,operation_id,action,updated_at,operation_json)
      SELECT ?,e.kind,e.entity_id,json_extract(j.value,'$[0]'),e.action,?,json_set(e.operation_json,'$.id',json_extract(j.value,'$[0]'),'$.updatedAt',?)
      FROM cloud_household_sync_account_entity e JOIN json_each(?) j ON j.key=e.entity_id WHERE e.account_id=? AND ${guard}
      ON CONFLICT(account_id,kind,entity_id) DO UPDATE SET operation_id=excluded.operation_id,action=excluded.action,updated_at=excluded.updated_at,operation_json=excluded.operation_json`,
      ).bind(target, updatedAt, updatedAt, feedbackIds, source, ...bindings),
      env.DB.prepare(
        `INSERT INTO cloud_household_sync_log(account_id,profile_id,kind,action,operation_id,operation_json,created_at)
      SELECT e.account_id,json_extract(e.operation_json,'$.profileId'),e.kind,e.action,e.operation_id,e.operation_json,? FROM cloud_household_sync_account_entity e JOIN json_each(?) j ON j.key=e.entity_id WHERE e.account_id=? AND ${guard}`,
      ).bind(now, feedbackIds, target, ...bindings),
      env.DB.prepare(
        `UPDATE cloud_household_sync_account_entity AS e SET action='delete',operation_id=json_extract(j.value,'$[1]'),updated_at=?,
      operation_json=json_set(e.operation_json,'$.id',json_extract(j.value,'$[1]'),'$.action','delete','$.updatedAt',?,'$.payload',NULL)
      FROM json_each(?) j WHERE e.account_id=? AND e.entity_id=j.key AND ${guard}`,
      ).bind(updatedAt, updatedAt, feedbackIds, source, ...bindings),
      env.DB.prepare(
        `INSERT INTO cloud_household_sync_log(account_id,profile_id,kind,action,operation_id,operation_json,created_at)
      SELECT e.account_id,json_extract(e.operation_json,'$.profileId'),e.kind,e.action,e.operation_id,e.operation_json,? FROM cloud_household_sync_account_entity e JOIN json_each(?) j ON j.key=e.entity_id WHERE e.account_id=? AND ${guard}`,
      ).bind(now, feedbackIds, source, ...bindings),
    );
  return statements;
}

export async function decideHouseholdRequest(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  id: string,
): Promise<Response> {
  fresh(principal, now);
  const input = record(await body(request, 1024));
  if (typeof input.approve !== "boolean")
    throw new HttpError(400, "invalid_household_decision");
  const row = await env.DB.prepare(
    "SELECT * FROM cloud_household_request WHERE id=? AND target_account_id=? AND status='pending' AND expires_at>?",
  )
    .bind(id, principal.account.id, now)
    .first<RequestRow>();
  if (!row) throw new HttpError(404, "household_request_unavailable");
  if (!input.approve) {
    await env.DB.prepare(
      "UPDATE cloud_household_request SET status='denied',completed_at=? WHERE id=? AND status='pending'",
    )
      .bind(now, id)
      .run();
    return json({ ok: true });
  }
  const source = await findHousehold(env, row.source_household_id),
    target = row.target_household_id
      ? await findHousehold(env, row.target_household_id)
      : null;
  if (
    !source ||
    source.account_id !== row.source_account_id ||
    source.ownership_version !== row.source_version ||
    source.merged_into ||
    (row.target_household_id &&
      (!target ||
        target.account_id !== row.target_account_id ||
        target.ownership_version !== row.target_version ||
        target.merged_into))
  )
    throw new HttpError(409, "household_request_changed");
  const nonce = crypto.randomUUID(),
    guard =
      "EXISTS(SELECT 1 FROM cloud_household_request WHERE id=? AND accept_nonce=? AND status='approved')";
  if (row.kind === "ownership-transfer") {
    const result = await env.DB.batch([
      env.DB.prepare(
        `UPDATE cloud_household_request SET status='approved',accept_nonce=?,completed_at=? WHERE id=? AND status='pending' AND expires_at>?
        AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=?)`,
      ).bind(
        nonce,
        now,
        id,
        now,
        source.id,
        source.account_id,
        source.ownership_version,
      ),
      env.DB.prepare(
        `UPDATE cloud_household SET account_id=?,ownership_version=ownership_version+1,updated_at=? WHERE id=? AND ${guard}`,
      ).bind(row.target_account_id, now, source.id, id, nonce),
      env.DB.prepare(
        `UPDATE cloud_device SET revoked_at=? WHERE household_id=? AND ${guard}`,
      ).bind(now, source.id, id, nonce),
    ]);
    if (!result[0]?.meta.changes)
      throw new HttpError(409, "household_request_changed");
    return json({ ok: true, householdId: source.id });
  }
  if (!target) throw new HttpError(409, "household_request_changed");
  const [sourceState, targetState] = await Promise.all([
    state(env, source.id),
    state(env, target.id),
  ]);
  if (
    (await hash(JSON.stringify([sourceState.digest, targetState.digest]))) !==
    row.snapshot_hash
  )
    throw new HttpError(409, "household_request_changed");
  const ids =
    row.kind === "profile-transfer"
      ? [row.profile_id!]
      : sourceState.profiles.filter((p) => p.active).map((p) => p.id);
  if (targetState.profiles.filter((p) => p.active).length + ids.length > 5)
    throw new HttpError(409, "profile_limit");
  if (row.kind === "merge" && (source.envelope_json || target.envelope_json)) {
    const approved = await env.DB.prepare(
      `UPDATE cloud_household_request SET status='approved',accept_nonce=?,approved_at=?,source_cursor=?,
      source_revision=COALESCE((SELECT revision FROM cloud_household_checkpoint WHERE household_id=source_household_id AND envelope_json IS NOT NULL AND invalidated_at IS NULL),0),
      target_revision=COALESCE((SELECT revision FROM cloud_household_checkpoint WHERE household_id=target_household_id),0)
      WHERE id=? AND status='pending' AND expires_at>?
      AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=? AND merged_into IS NULL)
      AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=? AND merged_into IS NULL)
      AND (SELECT COALESCE(MAX(seq),0) FROM cloud_household_sync_log WHERE account_id=?)=?
      AND (SELECT COALESCE(MAX(seq),0) FROM cloud_household_sync_log WHERE account_id=?)=?`,
    )
      .bind(
        nonce,
        now,
        sourceState.cursor,
        id,
        now,
        source.id,
        source.account_id,
        source.ownership_version,
        target.id,
        target.account_id,
        target.ownership_version,
        source.id,
        sourceState.cursor,
        target.id,
        targetState.cursor,
      )
      .run();
    if (!approved.meta.changes)
      throw new HttpError(409, "household_request_changed");
    return json({
      ok: true,
      requiresLocalImport: true,
      sourceHouseholdId: source.id,
      targetHouseholdId: target.id,
    });
  }
  const statements = [
    env.DB.prepare(
      `UPDATE cloud_household_request SET status='approved',accept_nonce=?,completed_at=? WHERE id=? AND status='pending' AND expires_at>?
    AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=?)
    AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=?)
    AND (SELECT COALESCE(MAX(seq),0) FROM cloud_household_sync_log WHERE account_id=?)=?
    AND (SELECT COALESCE(MAX(seq),0) FROM cloud_household_sync_log WHERE account_id=?)=?
    AND (? <> 'merge' OR NOT EXISTS(SELECT 1 FROM cloud_household_checkpoint WHERE household_id IN (?,?) AND envelope_json IS NOT NULL AND invalidated_at IS NULL))`,
    ).bind(
      nonce,
      now,
      id,
      now,
      source.id,
      source.account_id,
      source.ownership_version,
      target.id,
      target.account_id,
      target.ownership_version,
      source.id,
      sourceState.cursor,
      target.id,
      targetState.cursor,
      row.kind,
      source.id,
      target.id,
    ),
  ];
  for (const profileId of ids)
    statements.push(
      ...(await moveProfile(
        env,
        id,
        nonce,
        source.id,
        target.id,
        profileId,
        now,
      )),
    );
  statements.push(
    env.DB.prepare(
      `UPDATE cloud_household_checkpoint SET invalidated_at=? WHERE household_id IN (?,?) AND ${guard}`,
    ).bind(now, source.id, target.id, id, nonce),
  );
  if (row.kind === "merge") {
    statements.push(
      env.DB.prepare(
        `UPDATE cloud_household SET merged_into=?,updated_at=? WHERE id=? AND ${guard}`,
      ).bind(target.id, now, source.id, id, nonce),
    );
    statements.push(
      env.DB.prepare(
        `UPDATE cloud_device SET revoked_at=? WHERE household_id=? AND ${guard}`,
      ).bind(now, source.id, id, nonce),
    );
  }
  try {
    const result = await env.DB.batch(statements);
    if (!result[0]?.meta.changes)
      throw new HttpError(409, "household_request_changed");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("profile_limit"))
      throw new HttpError(409, "profile_limit");
    throw error;
  }
  return json({
    ok: true,
    sourceHouseholdId: source.id,
    targetHouseholdId: target.id,
  });
}

async function approvedMerge(
  env: Env,
  principal: Principal,
  now: number,
  id: string,
) {
  if (
    principal.method !== "device" ||
    principal.purpose !== "login" ||
    !principal.householdId
  )
    throw new HttpError(403, "home_server_required");
  const row = await env.DB.prepare(
    `SELECT * FROM cloud_household_request WHERE id=? AND kind='merge' AND status='approved'
    AND target_household_id=? AND target_account_id=?`,
  )
    .bind(id, principal.householdId, principal.account.id)
    .first<RequestRow>();
  if (!row || (!row.completed_at && row.expires_at <= now))
    throw new HttpError(404, "household_request_unavailable");
  const target = await requireHousehold(
    env,
    principal,
    principal.householdId,
    true,
  );
  const source = await findHousehold(env, row.source_household_id);
  if (
    !source ||
    target.ownership_version !== row.target_version ||
    source.account_id !== row.source_account_id ||
    source.ownership_version !== row.source_version ||
    target.merged_into
  )
    throw new HttpError(409, "household_request_changed");
  return { row, source, target };
}

/** Authorizes only the approved source ciphertext, never the source PIN. */
export async function importHouseholdMerge(
  env: Env,
  principal: Principal,
  now: number,
  id: string,
): Promise<Response> {
  const { row, source, target } = await approvedMerge(env, principal, now, id);
  if (row.completed_at) throw new HttpError(409, "household_request_completed");
  const current = await state(env, source.id);
  if (
    source.merged_into ||
    current.cursor !== row.source_cursor ||
    (source.revision ?? 0) !== row.source_revision
  )
    throw new HttpError(409, "household_request_changed");
  if (!source.envelope_json || !row.source_revision)
    throw new HttpError(409, "source_backup_required");
  const envelope = MasterPinHouseholdBackupSchema.parse(
    JSON.parse(source.envelope_json),
  );
  return json({
    requestId: row.id,
    sourceHouseholdId: source.id,
    sourceName: source.name,
    targetHouseholdId: target.id,
    sourceRevision: row.source_revision,
    targetRevision: row.target_revision ?? 0,
    currentTargetRevision: target.revision ?? 0,
    envelope,
  });
}

/** Finalization retains the original source ciphertext for recovery. */
export async function completeHouseholdMerge(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  id: string,
): Promise<Response> {
  const { row, source, target } = await approvedMerge(env, principal, now, id);
  const input = record(await body(request, 1024));
  const sourceRevision = input.sourceRevision,
    targetRevision = input.targetRevision;
  if (
    !Number.isSafeInteger(sourceRevision) ||
    !Number.isSafeInteger(targetRevision) ||
    typeof sourceRevision !== "number" ||
    typeof targetRevision !== "number" ||
    sourceRevision < 1 ||
    targetRevision < 1
  )
    throw new HttpError(400, "invalid_merge_completion");
  if (row.completed_at)
    return json({
      ok: true,
      alreadyCompleted: true,
      sourceHouseholdId: source.id,
      targetHouseholdId: target.id,
    });
  if (
    source.merged_into ||
    sourceRevision !== row.source_revision ||
    (source.revision ?? 0) !== sourceRevision ||
    !source.envelope_json
  )
    throw new HttpError(409, "household_request_changed");
  if (
    targetRevision <= (row.target_revision ?? 0) ||
    (target.revision ?? 0) !== targetRevision ||
    !target.envelope_json
  )
    throw new HttpError(409, "target_backup_required");
  MasterPinHouseholdBackupSchema.parse(JSON.parse(target.envelope_json));
  const nonce = crypto.randomUUID(),
    guard =
      "EXISTS(SELECT 1 FROM cloud_household_request WHERE id=? AND accept_nonce=? AND status='approved' AND completed_at=?)";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE cloud_household_request SET completed_at=?,accept_nonce=? WHERE id=? AND status='approved' AND completed_at IS NULL AND expires_at>?
      AND source_revision=? AND target_revision<?
      AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=? AND merged_into IS NULL)
      AND EXISTS(SELECT 1 FROM cloud_household WHERE id=? AND account_id=? AND ownership_version=? AND merged_into IS NULL)
      AND EXISTS(SELECT 1 FROM cloud_household_checkpoint WHERE household_id=? AND revision=? AND envelope_json IS NOT NULL AND invalidated_at IS NULL)
      AND EXISTS(SELECT 1 FROM cloud_household_checkpoint WHERE household_id=? AND revision=? AND envelope_json IS NOT NULL AND invalidated_at IS NULL)
      AND (SELECT COALESCE(MAX(seq),0) FROM cloud_household_sync_log WHERE account_id=?)=source_cursor`,
    ).bind(
      now,
      nonce,
      id,
      now,
      sourceRevision,
      targetRevision,
      source.id,
      source.account_id,
      source.ownership_version,
      target.id,
      target.account_id,
      target.ownership_version,
      source.id,
      sourceRevision,
      target.id,
      targetRevision,
      source.id,
    ),
    env.DB.prepare(
      `UPDATE cloud_household SET merged_into=?,updated_at=? WHERE id=? AND ${guard}`,
    ).bind(target.id, now, source.id, id, nonce, now),
    env.DB.prepare(
      `UPDATE cloud_device SET revoked_at=? WHERE household_id=? AND ${guard}`,
    ).bind(now, source.id, id, nonce, now),
  ]);
  if (!results[0]?.meta.changes)
    throw new HttpError(409, "household_request_changed");
  return json({
    ok: true,
    sourceHouseholdId: source.id,
    targetHouseholdId: target.id,
  });
}
