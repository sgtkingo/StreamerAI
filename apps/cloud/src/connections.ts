import { HttpError, json } from "./http.js";
import { mailConfigured } from "./mail.js";
import type { Env, Principal, SessionReader } from "./types.js";

/** Removing either method must never leave the owner unable to sign in. */
export async function removeLoginMethod(
  request: Request,
  env: Env,
  auth: SessionReader,
  now: number,
): Promise<Response> {
  const owner = await auth.getSession(request);
  if (!owner) throw new HttpError(401, "unauthorized");
  if (!owner.authenticatedAt || now - owner.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");

  const google = new URL(request.url).pathname.endsWith("/google-login");
  if (google && !mailConfigured(env))
    throw new HttpError(503, "email_unavailable");

  // The condition is part of the DELETE itself so concurrent removals cannot
  // both pass a stale read and leave the account without a sign-in method.
  const statement = google
    ? `DELETE FROM account WHERE userId = ? AND providerId = 'google'
       AND EXISTS (SELECT 1 FROM cloud_email_login WHERE user_id = ?)`
    : `DELETE FROM cloud_email_login WHERE user_id = ?
       AND EXISTS (SELECT 1 FROM account WHERE userId = ? AND providerId = 'google')`;
  const result = await env.DB.prepare(statement).bind(owner.id, owner.id).run();
  if (!result.meta.changes) {
    const existing = await env.DB.prepare(
      google
        ? "SELECT id FROM account WHERE userId = ? AND providerId = 'google'"
        : "SELECT user_id FROM cloud_email_login WHERE user_id = ?",
    )
      .bind(owner.id)
      .first();
    if (!existing) throw new HttpError(404, "method_not_connected");
    throw new HttpError(409, "last_sign_in_method");
  }
  return json({ success: true });
}

/** Only provider names and enrollment state leave the identity service. */
export async function listConnections(env: Env, principal: Principal) {
  const [providers, email] = await Promise.all([
    env.DB.prepare("SELECT DISTINCT providerId FROM account WHERE userId = ?")
      .bind(principal.account.id)
      .all<{ providerId: string }>(),
    env.DB.prepare("SELECT user_id FROM cloud_email_login WHERE user_id = ?")
      .bind(principal.account.id)
      .first(),
  ]);
  return json({
    accountId: principal.account.id,
    connections: [
      {
        provider: "email",
        name: "StreamerAI e-mail",
        connected: !!email,
        available: mailConfigured(env),
      },
      {
        provider: "google",
        name: "Google",
        connected: providers.results.some((row) => row.providerId === "google"),
        available: true,
      },
      { provider: "apple", name: "Apple", connected: false, available: false },
    ],
  });
}
