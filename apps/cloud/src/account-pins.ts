import {
  body,
  enforceRateLimit,
  HttpError,
  json,
  record,
  string,
} from "./http.js";
import { owner } from "./devices.js";
import type { Env, Principal } from "./types.js";

interface PinRow {
  verifier_json: string | null;
  setup_required: number;
}
interface Verifier {
  salt: string;
  hash: string;
  version: string;
  changeSalt?: string;
  changeHash?: string;
}
function freshOwner(principal: Principal, now: number) {
  owner(principal);
  if (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
    throw new HttpError(403, "reauth_required");
}
function readVerifier(value: unknown): Verifier {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "invalid_master_pin_verifier");
  const candidate = value as Partial<Verifier>;
  if (
    typeof candidate.salt !== "string" ||
    !/^[a-f0-9]{32}$/.test(candidate.salt) ||
    typeof candidate.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.hash) ||
    typeof candidate.version !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      candidate.version,
    )
  )
    throw new HttpError(400, "invalid_master_pin_verifier");
  if (
    (candidate.changeSalt !== undefined ||
      candidate.changeHash !== undefined) &&
    (typeof candidate.changeSalt !== "string" ||
      !/^[a-f0-9]{32}$/.test(candidate.changeSalt) ||
      typeof candidate.changeHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(candidate.changeHash))
  )
    throw new HttpError(400, "invalid_master_pin_verifier");
  return {
    salt: candidate.salt,
    hash: candidate.hash,
    version: candidate.version,
    ...(candidate.changeSalt && candidate.changeHash
      ? { changeSalt: candidate.changeSalt, changeHash: candidate.changeHash }
      : {}),
  };
}
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (part) => parseInt(part, 16));
function publicVerifier(verifier: Verifier) {
  return {
    salt: verifier.salt,
    hash: verifier.hash,
    version: verifier.version,
    ...(verifier.changeSalt ? { changeSalt: verifier.changeSalt } : {}),
  };
}
export async function requireMasterPin(
  env: Env,
  accountId: string,
): Promise<Verifier> {
  const row = await env.DB.prepare(
    "SELECT verifier_json, setup_required FROM cloud_master_pin WHERE account_id = ?",
  )
    .bind(accountId)
    .first<PinRow>();
  if (!row || row.setup_required)
    throw new HttpError(409, "master_pin_setup_required");
  // The browser derives PBKDF2-SHA256 at 600,000 iterations. Production Workers
  // cap native PBKDF2 at 100,000; keeping derivation off this path preserves the
  // existing verifier format and home-server compatibility.
  if (!row.verifier_json)
    throw new HttpError(409, "master_pin_initialization_required");
  return JSON.parse(row.verifier_json) as Verifier;
}
export async function masterPin(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  const accountId = principal.account.id;
  await enforceRateLimit(env.DB, `master-pin:${accountId}`, 30, 60, now);
  if (request.method === "PUT") {
    const input = record(await body(request, 1024));
    if ("pin" in input || "confirmation" in input)
      throw new HttpError(
        principal.method === "device" ? 403 : 400,
        "invalid_master_pin_verifier",
      );
    const verifier = readVerifier(input.verifier);
    if (principal.method === "device") {
      if (principal.mergeAckRequired || input.initialize === true)
        throw new HttpError(403, "home_server_required");
      await enforceRateLimit(
        env.DB,
        `master-pin-change:${accountId}`,
        5,
        300,
        now,
      );
      const row = await env.DB.prepare(
        "SELECT verifier_json, setup_required FROM cloud_master_pin WHERE account_id = ?",
      )
        .bind(accountId)
        .first<PinRow>();
      if (!row?.verifier_json || row.setup_required)
        throw new HttpError(409, "master_pin_setup_required");
      const current = readVerifier(JSON.parse(row.verifier_json));
      if (!current.changeSalt || !current.changeHash)
        throw new HttpError(409, "master_pin_upgrade_required");
      if (
        !verifier.changeSalt ||
        !verifier.changeHash ||
        input.expectedVersion !== current.version
      )
        throw new HttpError(409, "master_pin_changed");
      if (
        typeof input.proof !== "string" ||
        !/^[a-f0-9]{64}$/.test(input.proof)
      )
        throw new HttpError(403, "master_pin_incorrect");
      const message = JSON.stringify([
        accountId,
        current.version,
        verifier.version,
        verifier.salt,
        verifier.hash,
        verifier.changeSalt,
        verifier.changeHash,
      ]);
      const key = await crypto.subtle.importKey(
        "raw",
        unhex(current.changeHash),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          unhex(input.proof),
          new TextEncoder().encode(message),
        ))
      )
        throw new HttpError(403, "master_pin_incorrect");
      const result = await env.DB.prepare(
        "UPDATE cloud_master_pin SET verifier_json = ? WHERE account_id = ? AND verifier_json = ? AND setup_required = 0",
      )
        .bind(JSON.stringify(verifier), accountId, row.verifier_json)
        .run();
      if (!result.meta.changes) throw new HttpError(409, "master_pin_changed");
    } else if (input.initialize === true) {
      // Legacy initialization is one-time and cannot replace a chosen PIN or
      // bypass mandatory PIN selection for newly created accounts.
      await env.DB.prepare(
        "UPDATE cloud_master_pin SET verifier_json = ? WHERE account_id = ? AND verifier_json IS NULL AND setup_required = 0",
      )
        .bind(JSON.stringify(verifier), accountId)
        .run();
      await requireMasterPin(env, accountId);
    } else {
      freshOwner(principal, now);
      const result = await env.DB.prepare(
        "UPDATE cloud_master_pin SET verifier_json = ?, setup_required = 0 WHERE account_id = ?",
      )
        .bind(JSON.stringify(verifier), accountId)
        .run();
      if (!result.meta.changes)
        throw new HttpError(503, "master_pin_unavailable");
    }
    return json({ ok: true });
  }
  if (principal.method === "browser") {
    const row = await env.DB.prepare(
      "SELECT verifier_json, setup_required FROM cloud_master_pin WHERE account_id = ?",
    )
      .bind(accountId)
      .first<PinRow>();
    return json({
      setupRequired: !row || !!row.setup_required,
      initializationRequired:
        !!row && !row.setup_required && !row.verifier_json,
    });
  }
  if (principal.mergeAckRequired) throw new HttpError(409, "account_merged");
  return json({
    accountId,
    verifier: publicVerifier(await requireMasterPin(env, accountId)),
  });
}

/** A fresh browser session can add change protection to an older PIN without resetting it. */
export async function enrollMasterPinChange(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  freshOwner(principal, now);
  await enforceRateLimit(
    env.DB,
    `master-pin-enroll:${principal.account.id}`,
    8,
    300,
    now,
  );
  const row = await env.DB.prepare(
    "SELECT verifier_json, setup_required FROM cloud_master_pin WHERE account_id = ?",
  )
    .bind(principal.account.id)
    .first<PinRow>();
  if (!row?.verifier_json || row.setup_required)
    throw new HttpError(409, "master_pin_setup_required");
  const current = readVerifier(JSON.parse(row.verifier_json));
  if (request.method === "GET")
    return json({
      required: !current.changeHash,
      salt: current.salt,
      version: current.version,
    });
  if (current.changeHash) throw new HttpError(409, "master_pin_changed");
  const input = record(await body(request, 1024));
  if (
    typeof input.proof !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.proof) ||
    typeof input.changeSalt !== "string" ||
    !/^[a-f0-9]{32}$/.test(input.changeSalt) ||
    typeof input.changeHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.changeHash) ||
    input.version !== current.version
  )
    throw new HttpError(400, "invalid_master_pin_verifier");
  let difference = 0;
  for (let i = 0; i < current.hash.length; i++)
    difference |= current.hash.charCodeAt(i) ^ input.proof.charCodeAt(i);
  if (difference !== 0) throw new HttpError(403, "master_pin_incorrect");
  const updated = {
    ...current,
    changeSalt: input.changeSalt,
    changeHash: input.changeHash,
  };
  const result = await env.DB.prepare(
    "UPDATE cloud_master_pin SET verifier_json = ? WHERE account_id = ? AND verifier_json = ? AND setup_required = 0",
  )
    .bind(JSON.stringify(updated), principal.account.id, row.verifier_json)
    .run();
  if (!result.meta.changes) throw new HttpError(409, "master_pin_changed");
  return json({ ok: true });
}

export async function pinResets(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  id?: string,
  action?: string,
): Promise<Response> {
  const accountId = principal.account.id;
  if (!id && request.method === "GET") {
    owner(principal);
    const rows = await env.DB.prepare(
      "SELECT r.id, r.profile_name, r.expires_at, d.name AS device_name FROM cloud_pin_reset r JOIN cloud_device d ON d.id = r.device_id WHERE r.account_id = ? AND r.status = 'pending' AND r.expires_at > ? AND d.revoked_at IS NULL AND d.expires_at > ? ORDER BY r.expires_at DESC LIMIT 100",
    )
      .bind(accountId, now, now)
      .all();
    return json({ requests: rows.results });
  }
  await enforceRateLimit(env.DB, `pin-reset:${accountId}`, 30, 60, now);
  if (!id) {
    if (principal.method !== "device" || principal.mergeAckRequired)
      throw new HttpError(403, "home_server_required");
    await enforceRateLimit(
      env.DB,
      `pin-reset-create:${accountId}`,
      5,
      300,
      now,
    );
    const input = record(await body(request, 1024));
    const requestId = crypto.randomUUID(),
      expiresAt = now + 300_000;
    await env.DB.prepare(
      "INSERT INTO cloud_pin_reset (id, account_id, device_id, profile_name, status, expires_at) VALUES (?, ?, ?, ?, 'pending', ?)",
    )
      .bind(
        requestId,
        accountId,
        principal.deviceId,
        string(input.profileName, 80),
        expiresAt,
      )
      .run();
    return json({ id: requestId, expiresAt });
  }
  if (action === "decision") {
    freshOwner(principal, now);
    const input = record(await body(request, 1024));
    if (typeof input.approve !== "boolean")
      throw new HttpError(400, "invalid_request");
    const result = await env.DB.prepare(
      "UPDATE cloud_pin_reset SET status = ? WHERE id = ? AND account_id = ? AND status = 'pending' AND expires_at > ?",
    )
      .bind(input.approve ? "approved" : "denied", id, accountId, now)
      .run();
    if (!result.meta.changes) throw new HttpError(404, "request_unavailable");
    return json({ ok: true });
  }
  if (principal.method !== "device" || principal.mergeAckRequired)
    throw new HttpError(403, "home_server_required");
  const row = await env.DB.prepare(
    "SELECT status, expires_at FROM cloud_pin_reset WHERE id = ? AND account_id = ? AND device_id = ?",
  )
    .bind(id, accountId, principal.deviceId)
    .first<{ status: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return json({ status: "expired" });
  if (row.status === "approved") {
    const result = await env.DB.prepare(
      "UPDATE cloud_pin_reset SET status = 'consumed' WHERE id = ? AND status = 'approved' AND expires_at > ?",
    )
      .bind(id, now)
      .run();
    return json({ status: result.meta.changes ? "approved" : "expired" });
  }
  return json({ status: row.status === "consumed" ? "expired" : row.status });
}
