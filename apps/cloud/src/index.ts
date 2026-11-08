import { createAuth } from "./auth.js";
import { encryptedCheckpoint } from "./encrypted-sync.js";
import { detachHousehold, household, requireHousehold } from "./households.js";
import { householdCheckpoint } from "./household-checkpoint.js";
import {
  householdPush,
  householdPull,
  householdSnapshot,
  householdRetentionStatements,
} from "./household-sync.js";
import {
  completeHouseholdMerge,
  decideHouseholdRequest,
  householdRequests,
  importHouseholdMerge,
  listHouseholdProfiles,
} from "./household-management.js";
import { householdResets } from "./household-resets.js";
import {
  approveGrant,
  authenticate,
  claimGrant,
  createGrant,
  decidePendingGrant,
  listDevices,
  listPendingGrants,
  redeemGrant,
  revokeDevice,
  verifyGrant,
} from "./devices.js";
import { body, HttpError, json, sameOrigin } from "./http.js";
import { browserScript, page, stylesheet } from "./pages.js";
import { pull, push, retentionStatements, snapshot } from "./sync.js";
import {
  acceptTransfer,
  createTransfer,
  declineTransfer,
  listProfiles,
  listTransfers,
} from "./transfers.js";
import type { Clock, Env, SessionReader } from "./types.js";
import { emailLogin, manageEmailLogin } from "./email-login.js";
import { mailConfigured } from "./mail.js";
import { listConnections, removeLoginMethod } from "./connections.js";
import { deleteAccount, deletionStatus } from "./account-deletion.js";
import { emailApproval, emailApprovalError } from "./email-approval.js";
import {
  acknowledgeMerge,
  createMerge,
  decideMerge,
  listMerges,
  mergedFrom,
  mergeTombstones,
} from "./merges.js";

const authRoutes: Record<string, string[]> = {
  "/api/auth/sign-in/social": ["POST"],
  "/api/auth/callback/google": ["GET"],
  "/api/auth/get-session": ["GET"],
  "/api/auth/sign-out": ["POST"],
  "/api/auth/error": ["GET"],
  "/api/auth/link-social": ["POST"],
};

function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set(
    "content-security-policy",
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function createWorker(
  authFactory = createAuth,
  clock: Clock = { now: () => Date.now() },
) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      try {
        return secured(await route(request, env, authFactory, clock.now()));
      } catch (error) {
        if (!(error instanceof HttpError))
          console.error("CLOUD_REQUEST_FAILED", {
            method: request.method,
            path: new URL(request.url).pathname,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        const response =
          error instanceof HttpError
            ? json({ error: error.code }, error.status)
            : json({ error: "internal_error" }, 500);
        if (error instanceof HttpError && error.retryAfter)
          response.headers.set("retry-after", String(error.retryAfter));
        return secured(response);
      }
    },
    async scheduled(_event: ScheduledController, env: Env): Promise<void> {
      const now = clock.now();
      // Keep ownership and sync tombstones: pruning these can resurrect transferred profiles.
      await env.DB.batch([
        ...retentionStatements(env, now),
        ...householdRetentionStatements(env, now),
        env.DB.prepare(
          "DELETE FROM cloud_rate_limit WHERE expires_at < ?",
        ).bind(now),
        env.DB.prepare(
          "DELETE FROM cloud_email_cooldown WHERE next_send_at < ?",
        ).bind(now - 86_400_000),
        env.DB.prepare('DELETE FROM verification WHERE "expiresAt" < ?').bind(
          now - 86_400_000,
        ),
        env.DB.prepare(
          "DELETE FROM cloud_device_grant WHERE expires_at < ?",
        ).bind(now - 86_400_000),
        env.DB.prepare("DELETE FROM cloud_pin_reset WHERE expires_at < ?").bind(
          now,
        ),
        env.DB.prepare(
          "DELETE FROM cloud_device WHERE revoked_at IS NOT NULL AND expires_at < ?",
        ).bind(now - 7 * 86_400_000),
        env.DB.prepare(
          "DELETE FROM cloud_transfer WHERE expires_at < ? AND accepted_at IS NULL",
        ).bind(now - 7 * 86_400_000),
        env.DB.prepare(
          "DELETE FROM cloud_account_merge WHERE expires_at < ? AND accepted_at IS NULL",
        ).bind(now - 7 * 86_400_000),
      ]);
    },
  };
}

async function route(
  request: Request,
  env: Env,
  authFactory: (env: Env) => SessionReader,
  now: number,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/email-approval" && (method === "GET" || method === "POST")) {
    try {
      return await emailApproval(request, env, now);
    } catch (error) {
      if (error instanceof HttpError) return emailApprovalError(error);
      throw error;
    }
  }
  if (method === "GET") {
    if (path === "/health")
      return json({ ok: true, service: "streamer-ai-identity", version: 1 });
    if (path === "/" || path === "/login")
      return new Response(page("login", mailConfigured(env)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (path === "/device")
      return new Response(page("device"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (path === "/account")
      return new Response(page("account"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    if (path === "/assets/auth.js")
      return new Response(browserScript, {
        headers: { "content-type": "application/javascript; charset=utf-8" },
      });
    if (path === "/assets/auth.css")
      return new Response(stylesheet, {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== env.AUTH_ORIGIN)
    throw new HttpError(403, "origin_forbidden");
  if (
    method === "POST" &&
    [
      "/api/auth/email-otp/send-verification-otp",
      "/api/auth/sign-in/email-otp",
    ].includes(path)
  ) {
    sameOrigin(request, env.AUTH_ORIGIN);
    return emailLogin(request, env, authFactory(env), now);
  }
  if (
    (method === "GET" && path === "/v1/account/email-login") ||
    (method === "POST" &&
      [
        "/v1/account/email-login/code",
        "/v1/account/email-login/confirm",
      ].includes(path))
  ) {
    if (method === "POST") sameOrigin(request, env.AUTH_ORIGIN);
    return manageEmailLogin(request, env, authFactory(env), now);
  }
  if (
    method === "DELETE" &&
    ["/v1/account/google-login", "/v1/account/email-login"].includes(path)
  ) {
    sameOrigin(request, env.AUTH_ORIGIN);
    return removeLoginMethod(request, env, authFactory(env), now);
  }
  if (path.startsWith("/api/auth/")) {
    if (!authRoutes[path]?.includes(method))
      throw new HttpError(404, "not_found");
    if (method === "POST") sameOrigin(request, env.AUTH_ORIGIN);
    if (
      path === "/api/auth/sign-in/social" ||
      path === "/api/auth/link-social"
    ) {
      if (path.endsWith("link-social")) {
        const owner = await authFactory(env).getSession(request);
        if (!owner) throw new HttpError(401, "unauthorized");
        if (!owner.authenticatedAt || now - owner.authenticatedAt > 300_000)
          throw new HttpError(403, "reauth_required");
      }
      // Only our hosted pages can complete login; local/TV devices use a separate grant.
      let input: unknown;
      try {
        input = await body(request.clone(), 8192);
      } catch {
        throw new HttpError(400, "invalid_request");
      }
      const data = input as Record<string, unknown> | null;
      if (!data || data.provider !== "google" || data.idToken !== undefined)
        throw new HttpError(400, "invalid_request");
      for (const key of [
        "callbackURL",
        "errorCallbackURL",
        "newUserCallbackURL",
      ]) {
        if (data[key] !== undefined) {
          if (typeof data[key] !== "string")
            throw new HttpError(400, "invalid_callback");
          const callback = new URL(data[key] as string, env.AUTH_ORIGIN);
          if (
            callback.origin !== env.AUTH_ORIGIN ||
            !["/device", "/account", "/login"].includes(callback.pathname)
          )
            throw new HttpError(400, "invalid_callback");
        }
      }
    }
    return authFactory(env).handler(request);
  }
  if (method === "POST" && path === "/v1/device/code")
    return createGrant(request, env, now);
  if (method === "POST" && path === "/v1/device/token")
    return redeemGrant(request, env, now);
  if (method === "GET" && path === "/v1/device/deletion-status")
    return deletionStatus(request, env);
  if (!path.startsWith("/v1/")) throw new HttpError(404, "not_found");
  const principal = await authenticate(request, env, authFactory(env), now);
  if (principal.method === "browser" && method !== "GET")
    sameOrigin(request, env.AUTH_ORIGIN);
  if (method === "GET" && path === "/v1/account")
    return json(
      principal.method === "device"
        ? {
            ...principal.account,
            mergeAckRequired: !!principal.mergeAckRequired,
            householdId: principal.householdId ?? null,
          }
        : principal.account,
    );
  const mergedAccount = /^\/v1\/account\/merged-from\/([^/]+)$/.exec(path);
  if (method === "GET" && mergedAccount?.[1])
    return mergedFrom(env, principal, mergedAccount[1], now);
  if (method === "POST" && path === "/v1/account/merge-ack")
    return acknowledgeMerge(request, env, principal);
  if (method === "GET" && path === "/v1/account/merge-tombstones")
    return mergeTombstones(request, env, principal);
  if (
    path.startsWith("/v1/sync/") &&
    principal.method === "device" &&
    principal.mergeAckRequired
  )
    throw new HttpError(409, "account_merged");
  if (method === "DELETE" && path === "/v1/account")
    return deleteAccount(request, env, principal, now);
  if (
    principal.method === "device" &&
    principal.purpose === "pin-reset" &&
    !(method === "DELETE" && path === `/v1/devices/${principal.deviceId}`)
  ) {
    throw new HttpError(403, "token_scope_forbidden");
  }
  if (method === "GET" && path === "/v1/device/verify")
    return verifyGrant(request, env, principal, now);
  if (/^\/v1\/account\/master-pin(?:\/enroll)?$/.test(path))
    throw new HttpError(410, "local_pin_management");
  if (path === "/v1/households" && ["GET", "POST"].includes(method))
    return household(request, env, principal, now);
  if (
    ["/v1/household-requests", "/v1/households/requests"].includes(path) &&
    method === "GET"
  )
    return householdRequests(request, env, principal, now);
  const householdDecision =
    /^\/v1\/household-requests\/([a-f0-9-]{36})\/decision$/.exec(path);
  if (householdDecision?.[1] && method === "POST")
    return decideHouseholdRequest(
      request,
      env,
      principal,
      now,
      householdDecision[1],
    );
  const householdImport =
    /^\/v1\/household-requests\/([a-f0-9-]{36})\/(import|complete)$/.exec(path);
  if (
    householdImport?.[1] &&
    householdImport[2] === "import" &&
    method === "GET"
  )
    return importHouseholdMerge(env, principal, now, householdImport[1]);
  if (
    householdImport?.[1] &&
    householdImport[2] === "complete" &&
    method === "POST"
  )
    return completeHouseholdMerge(
      request,
      env,
      principal,
      now,
      householdImport[1],
    );
  const householdOperation =
    /^\/v1\/households\/([a-f0-9-]{36})\/(ownership-transfer|profile-transfers|merge|profiles)$/.exec(
      path,
    );
  if (householdOperation?.[1]) {
    const id = householdOperation[1],
      operation = householdOperation[2];
    if (operation === "profiles" && method === "GET")
      return listHouseholdProfiles(env, principal, id);
    if (method === "POST" && operation !== "profiles")
      return householdRequests(
        request,
        env,
        principal,
        now,
        id,
        operation === "profile-transfers"
          ? "profile-transfer"
          : (operation as "ownership-transfer" | "merge"),
      );
  }
  const householdReset =
    /^\/v1\/households\/([a-f0-9-]{36})\/pin-resets(?:\/([a-f0-9-]{36})\/(decision|consume))?$/.exec(
      path,
    );
  if (householdReset?.[1])
    return householdResets(
      request,
      env,
      principal,
      now,
      householdReset[1],
      householdReset[2],
      householdReset[3],
    );
  if (path === "/v1/account/pin-resets" && principal.householdId)
    return householdResets(request, env, principal, now, principal.householdId);
  const accountReset =
    /^\/v1\/account\/pin-resets\/([a-f0-9-]{36})\/(decision|consume)$/.exec(
      path,
    );
  if (accountReset?.[1] && principal.householdId)
    return householdResets(
      request,
      env,
      principal,
      now,
      principal.householdId,
      accountReset[1],
      accountReset[2],
    );
  const householdPath =
    /^\/v1\/households\/([a-f0-9-]{36})(?:\/(connection|checkpoint))?$/.exec(
      path,
    );
  if (householdPath?.[1]) {
    const id = householdPath[1];
    if (householdPath[2] === "connection" && method === "DELETE")
      return detachHousehold(request, env, principal, now, id);
    if (householdPath[2] === "checkpoint") {
      await requireHousehold(env, principal, id);
      return householdCheckpoint(
        request,
        env,
        { ...principal, householdId: id },
        now,
      );
    }
    if (!householdPath[2] && ["GET", "PUT"].includes(method))
      return household(request, env, principal, now, id);
  }
  if (
    path.startsWith("/v1/sync/") &&
    principal.method === "device" &&
    !principal.householdId
  )
    throw new HttpError(403, "household_scope_required");
  const selectedHousehold = new URL(request.url).searchParams.get(
    "household_id",
  );
  if (path.startsWith("/v1/sync/") && selectedHousehold) {
    await requireHousehold(env, principal, selectedHousehold);
    principal.householdId = selectedHousehold;
  }
  if (method === "POST" && path === "/v1/device/claim")
    return claimGrant(request, env, principal, now);
  if (method === "GET" && path === "/v1/device/pending")
    return listPendingGrants(env, principal, now);
  const pending = /^\/v1\/device\/pending\/([^/]+)\/decision$/.exec(path);
  if (method === "POST" && pending?.[1])
    return decidePendingGrant(request, env, principal, pending[1], now);
  if (method === "GET" && path === "/v1/account/connections")
    return listConnections(env, principal);
  if (method === "POST" && path === "/v1/device/approve")
    return approveGrant(request, env, principal, now);
  if (method === "GET" && path === "/v1/devices")
    return listDevices(env, principal);
  const device = /^\/v1\/devices\/([^/]+)$/.exec(path);
  if (method === "DELETE" && device?.[1])
    return revokeDevice(request, env, principal, device[1], now);
  if (method === "GET" && path === "/v1/profiles")
    return listProfiles(env, principal);
  if (method === "POST" && path === "/v1/transfers")
    return createTransfer(request, env, principal, now);
  if (method === "GET" && path === "/v1/transfers")
    return listTransfers(env, principal, now);
  const declineTransferRequest = /^\/v1\/transfers\/([^/]+)\/decline$/.exec(
    path,
  );
  if (method === "POST" && declineTransferRequest?.[1])
    return declineTransfer(
      request,
      env,
      principal,
      declineTransferRequest[1],
      now,
    );
  const transfer = /^\/v1\/transfers\/([^/]+)\/accept$/.exec(path);
  if (method === "POST" && transfer?.[1])
    return acceptTransfer(request, env, principal, transfer[1], now);
  if (method === "POST" && path === "/v1/merges")
    return createMerge(request, env, principal, now);
  if (method === "GET" && path === "/v1/merges")
    return listMerges(env, principal, now);
  const merge = /^\/v1\/merges\/([^/]+)\/decision$/.exec(path);
  if (method === "POST" && merge?.[1])
    return decideMerge(request, env, principal, merge[1], now);
  if (path === "/v1/sync/v2/checkpoint")
    return principal.householdId
      ? householdCheckpoint(request, env, principal, now)
      : encryptedCheckpoint(request, env, principal, now);
  if (method === "POST" && path === "/v1/sync/push") {
    return principal.householdId
      ? householdPush(request, env, principal, now)
      : push(request, env, principal, now);
  }
  if (method === "GET" && path === "/v1/sync/pull")
    return principal.householdId
      ? householdPull(request, env, principal)
      : pull(request, env, principal);
  if (method === "GET" && path === "/v1/sync/snapshot")
    return principal.householdId
      ? householdSnapshot(request, env, principal)
      : snapshot(request, env, principal);
  throw new HttpError(404, "not_found");
}

export default createWorker();
