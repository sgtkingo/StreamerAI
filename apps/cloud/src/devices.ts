import {
  body,
  enforceRateLimit,
  hash,
  HttpError,
  json,
  normalizeCode,
  randomToken,
  record,
  sameOrigin,
  string,
} from "./http.js";
import type { Account, Env, Principal, SessionReader } from "./types.js";

const CLIENT_ID = "streamer-ai-home";
const DEVICE_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const GRANT_LIFETIME_SECONDS = 300;

interface DeviceGrant {
  device_hash: string;
  client_id: string;
  device_name: string;
  purpose: "login" | "pin-reset";
  profile_name: string | null;
  status: "pending" | "approved" | "denied" | "consumed";
  account_id: string | null;
  expires_at: number;
  last_poll_at: number;
  interval_ms: number;
  household_id: string | null;
  household_name: string | null;
  server_id: string | null;
}

export async function authenticate(
  request: Request,
  env: Env,
  auth: SessionReader,
  now: number,
): Promise<Principal> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);
    if (!match?.[1]) throw new HttpError(401, "unauthorized");
    const row = await env.DB.prepare(
      `
      SELECT d.id AS device_id, d.purpose, d.merge_ack_required, d.household_id, u.id, u.email, u.name FROM cloud_device d
      JOIN "user" u ON u.id = d.account_id
      LEFT JOIN cloud_household h ON h.id = d.household_id
      WHERE d.token_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ?
        AND (d.household_id IS NULL OR (h.account_id = d.account_id AND h.merged_into IS NULL))
    `,
    )
      .bind(await hash(match[1]), now)
      .first<
        Account & {
          device_id: string;
          purpose: "login" | "pin-reset";
          merge_ack_required: number;
          household_id: string | null;
        }
      >();
    if (!row) throw new HttpError(401, "unauthorized");
    return {
      method: "device",
      deviceId: row.device_id,
      householdId: row.household_id ?? undefined,
      purpose: row.purpose,
      mergeAckRequired: !!row.merge_ack_required,
      account: { id: row.id, email: row.email, name: row.name },
    };
  }
  const account = await auth.getSession(request);
  if (!account) throw new HttpError(401, "unauthorized");
  return {
    account: { id: account.id, email: account.email, name: account.name },
    method: "browser",
    authenticatedAt: account.authenticatedAt,
  };
}

export function owner(principal: Principal): void {
  if (principal.method !== "browser")
    throw new HttpError(403, "browser_sign_in_required");
}

async function authorizeRequestedHousehold(
  env: Env,
  accountId: string,
  householdId: string | null,
) {
  if (!householdId) return;
  const household = await env.DB.prepare(
    "SELECT account_id,merged_into FROM cloud_household WHERE id = ?",
  )
    .bind(householdId)
    .first<{ account_id: string; merged_into: string | null }>();
  if (household && household.account_id !== accountId)
    throw new HttpError(403, "household_scope_forbidden");
  if (household?.merged_into) throw new HttpError(409, "household_merged");
}

function userCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (value) => alphabet[value % alphabet.length],
  ).join("");
}

export async function createGrant(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  await enforceRateLimit(
    env.DB,
    `device-create:${request.headers.get("cf-connecting-ip") ?? "local"}`,
    10,
    300,
    now,
  );
  const input = record(await body(request, 2048));
  if (input.client_id !== CLIENT_ID) throw new HttpError(400, "invalid_client");
  const deviceName = string(input.device_name, 80);
  const purpose = input.purpose ?? "login";
  if (purpose !== "login" && purpose !== "pin-reset")
    throw new HttpError(400, "invalid_request");
  const profileName =
    purpose === "pin-reset" ? string(input.profile_name ?? "Profil", 80) : null;
  const householdId =
    input.household_id == null ? null : string(input.household_id, 160);
  if (
    householdId &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      householdId,
    )
  )
    throw new HttpError(400, "invalid_household_id");
  const householdName =
    input.household_name == null ? null : string(input.household_name, 120);
  const serverId =
    input.server_id == null ? null : string(input.server_id, 160);
  const deviceCode = randomToken();
  const code = userCode();
  const displayCode = `${code.slice(0, 4)}-${code.slice(4)}`;
  await env.DB.prepare(
    `
    INSERT INTO cloud_device_grant
    (device_hash, user_hash, client_id, device_name, purpose, profile_name, status, expires_at, household_id, household_name, server_id)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `,
  )
    .bind(
      await hash(deviceCode),
      await hash(code),
      CLIENT_ID,
      deviceName,
      purpose,
      profileName,
      now + GRANT_LIFETIME_SECONDS * 1000,
      householdId,
      householdName,
      serverId,
    )
    .run();
  return json({
    device_code: deviceCode,
    user_code: displayCode,
    verification_uri: `${env.AUTH_ORIGIN}/device`,
    verification_uri_complete: `${env.AUTH_ORIGIN}/device?user_code=${displayCode}`,
    expires_in: GRANT_LIFETIME_SECONDS,
    interval: 5,
  });
}

export async function redeemGrant(
  request: Request,
  env: Env,
  now: number,
): Promise<Response> {
  await enforceRateLimit(
    env.DB,
    `device-poll:${request.headers.get("cf-connecting-ip") ?? "local"}`,
    120,
    60,
    now,
  );
  const input = record(await body(request, 2048));
  if (input.client_id !== CLIENT_ID) throw new HttpError(400, "invalid_client");
  if (input.grant_type !== "urn:ietf:params:oauth:grant-type:device_code")
    throw new HttpError(400, "unsupported_grant_type");
  const deviceHash = await hash(string(input.device_code));
  const grant = await env.DB.prepare(
    "SELECT * FROM cloud_device_grant WHERE device_hash = ? AND client_id = ?",
  )
    .bind(deviceHash, CLIENT_ID)
    .first<DeviceGrant>();
  if (!grant) throw new HttpError(400, "invalid_grant");
  if (grant.expires_at <= now) throw new HttpError(400, "expired_token");
  if (grant.status === "consumed") throw new HttpError(400, "invalid_grant");
  const tooFast = now - grant.last_poll_at < grant.interval_ms;
  const poll = await env.DB.prepare(
    `
    UPDATE cloud_device_grant SET last_poll_at = ?, interval_ms = ?
    WHERE device_hash = ? AND last_poll_at = ? AND status <> 'consumed'
  `,
  )
    .bind(
      now,
      tooFast ? Math.min(grant.interval_ms + 5000, 60_000) : grant.interval_ms,
      deviceHash,
      grant.last_poll_at,
    )
    .run();
  if (tooFast || !poll.meta.changes) throw new HttpError(400, "slow_down");
  if (grant.status === "denied") throw new HttpError(400, "access_denied");
  if (grant.status !== "approved" || !grant.account_id)
    throw new HttpError(400, "authorization_pending");
  const token = randomToken();
  const lifetime =
    grant.purpose === "pin-reset" ? 300 : DEVICE_LIFETIME_SECONDS;
  const deviceId = crypto.randomUUID();
  const nonce = randomToken();
  const results = await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE cloud_device_grant SET status = 'consumed', redeem_nonce = ?
      WHERE device_hash = ? AND status = 'approved' AND expires_at > ?
    `,
    ).bind(nonce, deviceHash, now),
    env.DB.prepare(
      `
      INSERT INTO cloud_device (id, account_id, name, purpose, token_hash, created_at, expires_at, household_id)
      SELECT ?, account_id, device_name, purpose, ?, ?, ?,
        (SELECT h.id FROM cloud_household h WHERE h.id = cloud_device_grant.household_id AND h.account_id = cloud_device_grant.account_id)
      FROM cloud_device_grant
      WHERE device_hash = ? AND redeem_nonce = ? AND status = 'consumed'
    `,
    ).bind(
      deviceId,
      await hash(token),
      now,
      now + lifetime * 1000,
      deviceHash,
      nonce,
    ),
  ]);
  if (!results[1]?.meta.changes) throw new HttpError(400, "invalid_grant");
  const account = await env.DB.prepare(
    'SELECT id, email, name FROM "user" WHERE id = ?',
  )
    .bind(grant.account_id)
    .first<Account>();
  if (!account) throw new HttpError(400, "invalid_grant");
  const scope = await env.DB.prepare(
    "SELECT household_id FROM cloud_device WHERE id = ?",
  )
    .bind(deviceId)
    .first<{ household_id: string | null }>();
  return json({
    access_token: token,
    token_type: "Bearer",
    expires_in: lifetime,
    purpose: grant.purpose,
    account,
    household_id: scope?.household_id ?? null,
    device: { id: deviceId, name: grant.device_name },
  });
}

export async function verifyGrant(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  await enforceRateLimit(
    env.DB,
    `device-verify:${principal.account.id}`,
    5,
    300,
    now,
  );
  const code = normalizeCode(
    string(new URL(request.url).searchParams.get("user_code"), 32),
  );
  const grant = await env.DB.prepare(
    `
    SELECT device_name, expires_at, purpose, profile_name, household_id, household_name, server_id FROM cloud_device_grant
    WHERE user_hash = ? AND status = 'pending' AND expires_at > ?
      AND (account_id IS NULL OR account_id = ?)
  `,
  )
    .bind(await hash(code), now, principal.account.id)
    .first<{
      device_name: string;
      expires_at: number;
      purpose: "login" | "pin-reset";
      profile_name: string | null;
      household_id: string | null;
      household_name: string | null;
      server_id: string | null;
    }>();
  if (!grant) throw new HttpError(400, "invalid_or_expired_code");
  await authorizeRequestedHousehold(
    env,
    principal.account.id,
    grant.household_id,
  );
  if (
    grant.purpose === "pin-reset" &&
    (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
  )
    throw new HttpError(401, "reauth_required");
  return json({
    user_code: `${code.slice(0, 4)}-${code.slice(4)}`,
    device_name: grant.device_name,
    expires_at: grant.expires_at,
    purpose: grant.purpose,
    profile_name: grant.profile_name,
    household_id: grant.household_id,
    household_name: grant.household_name,
    server_id: grant.server_id,
  });
}

export async function approveGrant(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  await enforceRateLimit(
    env.DB,
    `device-approve:${principal.account.id}`,
    10,
    300,
    now,
  );
  const input = record(await body(request, 2048));
  if (typeof input.approve !== "boolean")
    throw new HttpError(400, "invalid_request");
  const code = normalizeCode(string(input.user_code, 32));
  const grant = await env.DB.prepare(
    "SELECT purpose, household_id FROM cloud_device_grant WHERE user_hash = ? AND status = 'pending' AND expires_at > ? AND (account_id IS NULL OR account_id = ?)",
  )
    .bind(await hash(code), now, principal.account.id)
    .first<{ purpose: "login" | "pin-reset"; household_id: string | null }>();
  if (!grant) throw new HttpError(400, "invalid_or_expired_code");
  if (input.approve)
    await authorizeRequestedHousehold(
      env,
      principal.account.id,
      grant.household_id,
    );
  if (
    grant.purpose === "pin-reset" &&
    (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
  )
    throw new HttpError(401, "reauth_required");
  const result = await env.DB.prepare(
    `
    UPDATE cloud_device_grant SET status = ?, account_id = ?
    WHERE user_hash = ? AND status = 'pending' AND expires_at > ?
      AND (account_id IS NULL OR account_id = ?)
  `,
  )
    .bind(
      input.approve ? "approved" : "denied",
      principal.account.id,
      await hash(code),
      now,
      principal.account.id,
    )
    .run();
  if (!result.meta.changes) throw new HttpError(400, "invalid_or_expired_code");
  return json({ ok: true });
}

// Grants are created anonymously. Only a user who has supplied the displayed
// code can associate one with their account for later review.
export async function claimGrant(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  await enforceRateLimit(
    env.DB,
    `device-claim:${principal.account.id}`,
    5,
    300,
    now,
  );
  const input = record(await body(request, 2048));
  const code = normalizeCode(string(input.user_code, 32));
  const codeHash = await hash(code);
  const grant = await env.DB.prepare(
    "SELECT purpose FROM cloud_device_grant WHERE user_hash = ? AND status = 'pending' AND expires_at > ? AND (account_id IS NULL OR account_id = ?)",
  )
    .bind(codeHash, now, principal.account.id)
    .first<{ purpose: "login" | "pin-reset" }>();
  if (!grant) throw new HttpError(400, "invalid_or_expired_code");
  if (
    grant.purpose === "pin-reset" &&
    (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
  )
    throw new HttpError(401, "reauth_required");
  const result = await env.DB.prepare(
    `UPDATE cloud_device_grant SET account_id = ?, redeem_nonce = COALESCE(redeem_nonce, ?)
     WHERE user_hash = ? AND status = 'pending' AND expires_at > ?
       AND (account_id IS NULL OR account_id = ?)`,
  )
    .bind(
      principal.account.id,
      randomToken(),
      codeHash,
      now,
      principal.account.id,
    )
    .run();
  if (!result.meta.changes) throw new HttpError(400, "invalid_or_expired_code");
  return json({ ok: true });
}

export async function listPendingGrants(
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  owner(principal);
  const rows = await env.DB.prepare(
    `SELECT redeem_nonce AS id, device_name, expires_at, purpose, profile_name
     FROM cloud_device_grant WHERE account_id = ? AND status = 'pending' AND expires_at > ?
     ORDER BY expires_at DESC LIMIT 100`,
  )
    .bind(principal.account.id, now)
    .all();
  return json({ pairings: rows.results });
}

export async function decidePendingGrant(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
  now: number,
): Promise<Response> {
  owner(principal);
  sameOrigin(request, env.AUTH_ORIGIN);
  if (!/^[a-f0-9]{64}$/.test(id))
    throw new HttpError(400, "invalid_or_expired_code");
  await enforceRateLimit(
    env.DB,
    `device-approve:${principal.account.id}`,
    10,
    300,
    now,
  );
  const input = record(await body(request, 2048));
  if (typeof input.approve !== "boolean")
    throw new HttpError(400, "invalid_request");
  const grant = await env.DB.prepare(
    "SELECT purpose, user_hash, household_id FROM cloud_device_grant WHERE redeem_nonce = ? AND account_id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(id, principal.account.id, now)
    .first<{
      purpose: "login" | "pin-reset";
      user_hash: string;
      household_id: string | null;
    }>();
  if (!grant) throw new HttpError(400, "invalid_or_expired_code");
  if (input.approve)
    await authorizeRequestedHousehold(
      env,
      principal.account.id,
      grant.household_id,
    );
  // The list identifier alone cannot authorize approval; confirm the code too.
  if (
    input.approve &&
    (await hash(normalizeCode(string(input.user_code, 32)))) !== grant.user_hash
  )
    throw new HttpError(400, "invalid_or_expired_code");
  if (
    grant.purpose === "pin-reset" &&
    (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
  )
    throw new HttpError(401, "reauth_required");
  const result = await env.DB.prepare(
    "UPDATE cloud_device_grant SET status = ? WHERE redeem_nonce = ? AND account_id = ? AND status = 'pending' AND expires_at > ?",
  )
    .bind(input.approve ? "approved" : "denied", id, principal.account.id, now)
    .run();
  if (!result.meta.changes) throw new HttpError(400, "invalid_or_expired_code");
  return json({ ok: true });
}

export async function listDevices(
  env: Env,
  principal: Principal,
): Promise<Response> {
  owner(principal);
  const rows = await env.DB.prepare(
    `
    SELECT id, name, purpose, created_at, expires_at, revoked_at FROM cloud_device
    WHERE account_id = ? ORDER BY created_at DESC LIMIT 100
  `,
  )
    .bind(principal.account.id)
    .all();
  return json({ devices: rows.results });
}

export async function revokeDevice(
  request: Request,
  env: Env,
  principal: Principal,
  id: string,
  now: number,
): Promise<Response> {
  if (principal.method === "device" && principal.deviceId !== id)
    throw new HttpError(403, "browser_sign_in_required");
  if (principal.method === "browser") {
    sameOrigin(request, env.AUTH_ORIGIN);
    await env.DB.prepare(
      "DELETE FROM cloud_device WHERE id = ? AND account_id = ?",
    )
      .bind(id, principal.account.id)
      .run();
    return json({ ok: true });
  }
  await env.DB.prepare(
    "UPDATE cloud_device SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL",
  )
    .bind(now, id, principal.account.id)
    .run();
  return json({ ok: true });
}
