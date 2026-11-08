import {
  body,
  enforceRateLimit,
  HttpError,
  json,
  record,
  string,
} from "./http.js";
import { requireHousehold } from "./households.js";
import type { Env, Principal } from "./types.js";

/** Cloud approves ownership only; the PIN and its verifier remain on the server. */
export async function householdResets(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
  householdId: string,
  id?: string,
  action?: string,
): Promise<Response> {
  await requireHousehold(env, principal, householdId, true);
  if (!id && request.method === "GET") {
    if (principal.method !== "browser")
      throw new HttpError(403, "browser_sign_in_required");
    const rows = await env.DB.prepare(
      `SELECT r.id,r.profile_name,r.purpose,r.expires_at,d.name AS device_name FROM cloud_household_reset r JOIN cloud_device d ON d.id=r.device_id
      WHERE r.household_id=? AND r.status='pending' AND r.expires_at>? AND d.revoked_at IS NULL AND d.expires_at>? ORDER BY r.expires_at DESC LIMIT 100`,
    )
      .bind(householdId, now, now)
      .all();
    return json({ requests: rows.results });
  }
  await enforceRateLimit(
    env.DB,
    `household-reset:${householdId}`,
    20,
    300,
    now,
  );
  if (!id) {
    if (principal.method !== "device" || principal.purpose !== "login")
      throw new HttpError(403, "home_server_required");
    const input = record(await body(request, 1024));
    const purpose = input.purpose ?? "profile-pin";
    if (purpose !== "master-pin" && purpose !== "profile-pin")
      throw new HttpError(400, "invalid_reset_purpose");
    const profileName = string(input.profileName ?? "Household", 80),
      requestId = crypto.randomUUID(),
      expiresAt = now + 300_000;
    await env.DB.prepare(
      "INSERT INTO cloud_household_reset(id,household_id,device_id,profile_name,purpose,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        requestId,
        householdId,
        principal.deviceId,
        profileName,
        purpose,
        expiresAt,
      )
      .run();
    return json({
      id: requestId,
      expiresAt,
      manageUrl: `${env.AUTH_ORIGIN}/account?household=${encodeURIComponent(householdId)}#requests`,
    });
  }
  if (action === "decision") {
    if (principal.method !== "browser")
      throw new HttpError(403, "browser_sign_in_required");
    if (!principal.authenticatedAt || principal.authenticatedAt < now - 300_000)
      throw new HttpError(403, "reauth_required");
    const input = record(await body(request, 1024));
    if (typeof input.approve !== "boolean")
      throw new HttpError(400, "invalid_request");
    const result = await env.DB.prepare(
      "UPDATE cloud_household_reset SET status=? WHERE id=? AND household_id=? AND status='pending' AND expires_at>?",
    )
      .bind(input.approve ? "approved" : "denied", id, householdId, now)
      .run();
    if (!result.meta.changes) throw new HttpError(404, "request_unavailable");
    return json({ ok: true });
  }
  if (principal.method !== "device" || principal.purpose !== "login")
    throw new HttpError(403, "home_server_required");
  const row = await env.DB.prepare(
    "SELECT status,expires_at FROM cloud_household_reset WHERE id=? AND household_id=? AND device_id=?",
  )
    .bind(id, householdId, principal.deviceId)
    .first<{ status: string; expires_at: number }>();
  if (!row || row.expires_at <= now) return json({ status: "expired" });
  if (row.status === "approved") {
    const updated = await env.DB.prepare(
      "UPDATE cloud_household_reset SET status='consumed' WHERE id=? AND status='approved' AND expires_at>?",
    )
      .bind(id, now)
      .run();
    return json({ status: updated.meta.changes ? "approved" : "expired" });
  }
  return json({ status: row.status === "consumed" ? "expired" : row.status });
}
