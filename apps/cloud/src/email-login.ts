import {
  body,
  enforceRateLimit,
  hash,
  HttpError,
  json,
  record,
  string,
} from "./http.js";
import { mailConfigured } from "./mail.js";
import type { Env, SessionReader } from "./types.js";

function address(value: unknown): string {
  const email = string(value, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HttpError(400, "invalid_email");
  return email;
}

async function emailUser(env: Env, email: string) {
  return env.DB.prepare(
    `SELECT u.id,
    EXISTS(SELECT 1 FROM cloud_email_login e WHERE e.user_id = u.id) AS enabled,
    EXISTS(SELECT 1 FROM account a WHERE a.userId = u.id AND a.providerId = 'google') AS google
    FROM user u WHERE lower(u.email) = ?`,
  )
    .bind(email)
    .first<{ id: string; enabled: number; google: number }>();
}

async function reserveMail(
  request: Request,
  env: Env,
  email: string,
  now: number,
) {
  const emailHash = await hash(email);
  // A repeat click during cooldown must not spend hourly/daily send budgets.
  const cooldown = await env.DB.prepare(
    "SELECT next_send_at FROM cloud_email_cooldown WHERE email_hash = ?",
  )
    .bind(emailHash)
    .first<{ next_send_at: number }>();
  if (cooldown && cooldown.next_send_at > now)
    throw new HttpError(
      429,
      "rate_limited",
      Math.max(1, Math.ceil((cooldown.next_send_at - now) / 1000)),
    );
  await enforceRateLimit(
    env.DB,
    `mail:ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    10,
    3600,
    now,
  );
  await enforceRateLimit(env.DB, `mail:email:${email}`, 6, 3600, now);
  await enforceRateLimit(env.DB, "mail:global", 250, 86400, now);
  const reserved = await env.DB.prepare(
    `INSERT INTO cloud_email_cooldown (email_hash, next_send_at) VALUES (?, ?)
    ON CONFLICT(email_hash) DO UPDATE SET next_send_at = excluded.next_send_at
    WHERE cloud_email_cooldown.next_send_at <= ? RETURNING email_hash`,
  )
    .bind(emailHash, now + 60_000, now)
    .first();
  if (!reserved) {
    const cooldown = await env.DB.prepare(
      "SELECT next_send_at FROM cloud_email_cooldown WHERE email_hash = ?",
    )
      .bind(emailHash)
      .first<{ next_send_at: number }>();
    throw new HttpError(
      429,
      "rate_limited",
      Math.max(
        1,
        Math.ceil(((cooldown?.next_send_at ?? now + 60_000) - now) / 1000),
      ),
    );
  }
}

function pluginRequest(
  request: Request,
  env: Env,
  path: string,
  data: unknown,
) {
  return new Request(env.AUTH_ORIGIN + "/api/auth" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: env.AUTH_ORIGIN,
      cookie: request.headers.get("cookie") ?? "",
      "cf-connecting-ip": request.headers.get("cf-connecting-ip") ?? "unknown",
    },
    body: JSON.stringify(data),
  });
}

/** Only these wrapped endpoints expose the OTP plugin; password/change-email APIs stay closed. */
export async function emailLogin(
  request: Request,
  env: Env,
  auth: SessionReader,
  now: number,
): Promise<Response> {
  if (!mailConfigured(env)) throw new HttpError(503, "email_unavailable");
  const input = record(await body(request, 8192));
  const email = address(input.email);
  const send = new URL(request.url).pathname.endsWith("/send-verification-otp");
  const owner = await emailUser(env, email);
  if (send) {
    if (input.type !== "sign-in") throw new HttpError(400, "invalid_request");
    await reserveMail(request, env, email, now);
    // Neutral response: an existing Google owner first opts in from their portal.
    if (owner?.google && !owner.enabled) return json({ success: true });
    await env.DB.prepare("DELETE FROM verification WHERE identifier = ?")
      .bind(`sign-in-otp-${email}`)
      .run();
    const response = await auth.handler(
      pluginRequest(request, env, "/email-otp/send-verification-otp", {
        email,
        type: "sign-in",
      }),
    );
    if (!response.ok) {
      await env.DB.prepare("DELETE FROM verification WHERE identifier = ?")
        .bind(`sign-in-otp-${email}`)
        .run();
      throw new HttpError(503, "email_unavailable");
    }
    return json({ success: true });
  }
  await enforceRateLimit(
    env.DB,
    `otp:verify:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    30,
    600,
    now,
  );
  if (owner?.google && !owner.enabled) throw new HttpError(400, "invalid_otp");
  const otp = string(input.otp, 8);
  if (!/^\d{8}$/.test(otp)) throw new HttpError(400, "invalid_otp");
  const response = await auth.handler(
    pluginRequest(request, env, "/sign-in/email-otp", {
      email,
      otp,
      name: email.split("@")[0]!.slice(0, 80),
    }),
  );
  if (!response.ok) throw new HttpError(400, "invalid_otp");
  const result = record(await response.json());
  const user = record(result.user);
  const id = string(user.id, 160);
  // A sign-in already in flight must not re-enable a method the owner just
  // disabled. Enroll only a new or legacy email-only account.
  if (!owner || (!owner.enabled && !owner.google))
    await env.DB.prepare(
      `INSERT INTO cloud_email_login (user_id, enabled_at)
      SELECT ?, ? WHERE NOT EXISTS (
        SELECT 1 FROM account WHERE userId = ? AND providerId = 'google'
      ) ON CONFLICT(user_id) DO NOTHING`,
    )
      .bind(id, now, id)
      .run();
  const current = await emailUser(env, email);
  if (!current?.enabled) throw new HttpError(400, "invalid_otp");
  // Better Auth returns a raw token too. Only its HttpOnly cookie leaves this wrapper.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({ success: true }), { headers });
}

export async function manageEmailLogin(
  request: Request,
  env: Env,
  auth: SessionReader,
  now: number,
): Promise<Response> {
  const owner = await auth.getSession(request);
  if (!owner) throw new HttpError(401, "unauthorized");
  const path = new URL(request.url).pathname;
  const state = await emailUser(env, owner.email.toLowerCase());
  if (request.method === "GET")
    return json({
      available: mailConfigured(env),
      enabled: !!state?.enabled,
      googleLinked: !!state?.google,
    });
  if (!owner.authenticatedAt || now - owner.authenticatedAt > 300_000)
    throw new HttpError(403, "reauth_required");
  if (!mailConfigured(env)) throw new HttpError(503, "email_unavailable");
  if (path.endsWith("/code")) {
    await reserveMail(request, env, owner.email.toLowerCase(), now);
    await env.DB.prepare("DELETE FROM verification WHERE identifier = ?")
      .bind(`email-verification-otp-${owner.email.toLowerCase()}`)
      .run();
    const response = await auth.handler(
      pluginRequest(request, env, "/email-otp/send-verification-otp", {
        email: owner.email.toLowerCase(),
        type: "email-verification",
      }),
    );
    if (!response.ok) {
      await env.DB.prepare("DELETE FROM verification WHERE identifier = ?")
        .bind(`email-verification-otp-${owner.email.toLowerCase()}`)
        .run();
      throw new HttpError(503, "email_unavailable");
    }
    return json({ success: true });
  }
  const input = record(await body(request, 8192));
  const otp = string(input.otp, 8);
  if (!/^\d{8}$/.test(otp)) throw new HttpError(400, "invalid_otp");
  const response = await auth.handler(
    pluginRequest(request, env, "/email-otp/verify-email", {
      email: owner.email.toLowerCase(),
      otp,
    }),
  );
  if (!response.ok) throw new HttpError(400, "invalid_otp");
  await env.DB.prepare(
    "INSERT INTO cloud_email_login (user_id, enabled_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING",
  )
    .bind(owner.id, now)
    .run();
  return json({ success: true });
}
