import { hash, HttpError, json, sameOrigin } from "./http.js";
import type { Env, Principal } from "./types.js";

export async function deleteAccount(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  sameOrigin(request, env.AUTH_ORIGIN);
  if (principal.method !== "browser")
    throw new HttpError(403, "browser_sign_in_required");
  if (!principal.authenticatedAt || now - principal.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
  const email = principal.account.email.toLowerCase();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO cloud_deleted_device (token_hash, deleted_at) SELECT token_hash, ? FROM cloud_device WHERE account_id = ? AND revoked_at IS NULL AND purpose = 'login'",
    ).bind(now, principal.account.id),
    env.DB.prepare("DELETE FROM verification WHERE identifier IN (?, ?)").bind(
      `sign-in-otp-${email}`,
      `email-verification-otp-${email}`,
    ),
    env.DB.prepare(
      "DELETE FROM cloud_email_cooldown WHERE email_hash = ?",
    ).bind(await hash(email)),
    env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(
      principal.account.id,
    ),
  ]);
  return json({ ok: true });
}

export async function deletionStatus(
  request: Request,
  env: Env,
): Promise<Response> {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match?.[1]) throw new HttpError(404, "not_found");
  const found = await env.DB.prepare(
    "SELECT 1 FROM cloud_deleted_device WHERE token_hash = ?",
  )
    .bind(await hash(match[1]))
    .first();
  if (!found) throw new HttpError(404, "not_found");
  return json({ error: "account_deleted" }, 410);
}
