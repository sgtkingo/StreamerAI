import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  Account,
  AccountSession,
  StreamerDatabase,
} from "@streamer-ai/database";
import {
  AccountSyncOperationSchema,
  PlaybackPreferencesSchema,
  type AccountSyncOperation,
  type ViewerProfile,
} from "@streamer-ai/contracts";
import { toDataURL } from "qrcode";
import type { SecretStore } from "../stores/secret-store.js";
import type { PlaybackTicketStore } from "./playback-ticket-store.js";

const derive = promisify(scrypt);
const COOKIE = "streamer_session";
const PAIR_COOKIE = "streamer_pair";
const SESSION_MS = 30 * 24 * 60 * 60_000;
const UNLOCK_MS = 30 * 60_000;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const publicAccount = (account: Account) => ({
  id: account.id,
  name: account.name,
  email: account.email,
  cloudLinked: account.cloudUserId !== null,
});
const safeIdentityDetails = (identity: Record<string, unknown>) => ({
  ...(typeof identity.name === "string" &&
  identity.name.trim().length > 0 &&
  identity.name.length <= 120
    ? { name: identity.name.trim() }
    : {}),
  ...(typeof identity.email === "string" &&
  identity.email.trim().length > 0 &&
  identity.email.length <= 320
    ? { email: identity.email.trim() }
    : {}),
});

interface Context {
  account: Account;
  session: AccountSession | null;
  hash: string;
  internal: boolean;
}
interface Pairing {
  binding: string;
  expiresAt: number;
  nextPollAt: number;
  interval: number;
  name: string;
  purpose: "login" | "pin-reset";
  profileId?: string;
  sessionHash?: string;
  accountId?: string;
  adoptAccountId?: string;
  disableSync?: boolean;
}
interface SyncStatus {
  configured: boolean;
  status: string;
  lastSyncedAt: string | null;
  error: string | null;
}
export interface AccountAuthOptions {
  database: StreamerDatabase;
  secretStore: SecretStore;
  serviceUrl: string | null;
  webOrigin?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  internalToken?: string;
  tickets?: PlaybackTicketStore;
  sync?: {
    sync(accountId: string): Promise<SyncStatus>;
    status(accountId: string): SyncStatus;
    setEnabled?(accountId: string, enabled: boolean): Promise<SyncStatus>;
    convertDeletedAccount?(
      accountId: string,
      expectedCloudUserId: string,
    ): boolean;
    migrateMergedAccount?(
      accountId: string,
      oldCloudUserId: string,
      newCloudUserId: string,
      identity: { name?: string; email?: string },
    ): "updated" | "conflict" | "changed";
    markMergeConflict?(accountId: string): void;
    applyMergeTombstones?(
      accountId: string,
      expectedCloudUserId: string,
      operations: AccountSyncOperation[],
    ): boolean;
    profileStatus?(accountId: string, profileId: string): { paused: boolean };
    setProfilePaused?(
      accountId: string,
      profileId: string,
      paused: boolean,
    ): Promise<{ paused: boolean }>;
  };
}

function cookies(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    (request.headers.cookie ?? "")
      .split(";")
      .slice(0, 30)
      .flatMap((part) => {
        const index = part.indexOf("=");
        if (index < 1) return [];
        return [[part.slice(0, index).trim(), part.slice(index + 1).trim()]];
      }),
  );
}
function setCookie(
  reply: FastifyReply,
  request: FastifyRequest,
  name: string,
  value: string,
  maxAge: number,
  webOrigin?: string,
) {
  const secure =
    request.protocol === "https" || webOrigin?.startsWith("https://")
      ? "; Secure"
      : "";
  reply.header(
    "set-cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`,
  );
}
function error(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  return reply.code(status).send({ error: { code, message } });
}
function tokenEqual(left: string, right: string) {
  return timingSafeEqual(
    Buffer.from(sha(left), "hex"),
    Buffer.from(sha(right), "hex"),
  );
}

/** Local sessions and profile authorization. Cloud credentials never reach the browser. */
export class AccountAuthService {
  readonly enabled: boolean;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly contexts = new WeakMap<FastifyRequest, Context>();
  private readonly pending = new Map<string, Pairing>();
  private readonly unlocks = new Map<
    string,
    { version: number; expiresAt: number }
  >();
  private readonly attempts = new Map<
    string,
    { count: number; resetAt: number }
  >();
  private readonly resets = new Map<string, number>();
  private readonly pinJobs = new Set<string>();
  private readonly checks = new Map<
    string,
    { at: number; job?: Promise<boolean>; valid: boolean }
  >();
  private readonly deletionChecks = new Map<string, Promise<void>>();
  private recoveredLocalAccounts(): Account[] {
    const ids =
      this.options.database.settings.get<string[]>("account.recoveredLocal") ??
      [];
    return ids.flatMap((id) => {
      const account = this.options.database.accounts.get(id);
      return account && !account.cloudUserId && account.id !== "local"
        ? [account]
        : [];
    });
  }
  constructor(private readonly options: AccountAuthOptions) {
    this.enabled = options.serviceUrl !== null;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  private session(request: FastifyRequest): AccountSession | null {
    const token = cookies(request)[COOKIE];
    return token && /^[a-f0-9]{64}$/.test(token)
      ? this.options.database.auth.getSession(sha(token))
      : null;
  }
  account(request: FastifyRequest): Account {
    const context = this.contexts.get(request);
    if (context) return context.account;
    const session = this.session(request);
    return session
      ? this.options.database.accounts.getRequired(session.accountId)
      : this.options.database.accounts.getLocal();
  }
  private context(request: FastifyRequest): Context | null {
    const known = this.contexts.get(request);
    if (known) return known;
    const session = this.session(request);
    if (session)
      return {
        account: this.options.database.accounts.getRequired(session.accountId),
        session,
        hash: session.tokenHash,
        internal: false,
      };
    if (this.enabled) return null;
    return {
      account: this.options.database.accounts.getLocal(),
      session: null,
      hash: "",
      internal: false,
    };
  }
  private createSession(
    request: FastifyRequest,
    reply: FastifyReply,
    account: Account,
    deviceId: string = randomUUID(),
    label = "Local browser",
    expiresAt = new Date(this.now().getTime() + SESSION_MS).toISOString(),
  ) {
    const token = randomBytes(32).toString("hex");
    const session = this.options.database.auth.createSession({
      tokenHash: sha(token),
      accountId: account.id,
      deviceId,
      label,
      expiresAt,
    });
    setCookie(
      reply,
      request,
      COOKIE,
      token,
      Math.max(
        1,
        Math.floor((Date.parse(expiresAt) - this.now().getTime()) / 1000),
      ),
      this.options.webOrigin,
    );
    const context = {
      account,
      session,
      hash: session.tokenHash,
      internal: false,
    };
    this.contexts.set(request, context);
    return context;
  }
  private unlocked(context: Context, profileId: string, renew = false) {
    const pin = this.options.database.profiles.getPinRecord(profileId);
    if (!pin.hash || context.internal) return true;
    const unlock = this.unlocks.get(`${context.hash}:${profileId}`);
    const valid =
      !!context.hash &&
      unlock?.version === pin.version &&
      unlock.expiresAt > this.now().getTime();
    if (valid && renew && unlock)
      unlock.expiresAt = this.now().getTime() + UNLOCK_MS;
    return valid;
  }
  maskProfiles(
    request: FastifyRequest,
    profiles: ViewerProfile[],
  ): ViewerProfile[] {
    const context = this.context(request);
    return profiles.map((profile) =>
      context && this.unlocked(context, profile.id)
        ? profile
        : {
            ...profile,
            prompt: "",
            genres: [],
            playback: PlaybackPreferencesSchema.parse({}),
          },
    );
  }
  async getCredential(
    accountId: string,
  ): Promise<{ token: string; deviceId: string } | null> {
    const expectedCloudUserId =
      this.options.database.accounts.get(accountId)?.cloudUserId;
    for (const session of this.options.database.auth.listDevices(accountId)) {
      if (
        session.revokedAt ||
        Date.parse(session.expiresAt) <= this.now().getTime()
      )
        continue;
      const token = await this.options.secretStore.get(
        `account.cloud-token.${accountId}.${session.deviceId}`,
      );
      if (token) return { token, deviceId: session.deviceId };
    }
    // Expired local sessions cannot authorize the browser, but their retained
    // cloud tokens can still prove that this account was deleted while offline.
    for (const session of this.options.database.auth.listDeviceHistory(
      accountId,
    )) {
      if (session.revokedAt) continue;
      const token = await this.options.secretStore.get(
        `account.cloud-token.${accountId}.${session.deviceId}`,
      );
      if (
        token &&
        expectedCloudUserId &&
        (await this.confirmDeletedAccount(
          accountId,
          token,
          expectedCloudUserId,
        )) === "deleted"
      )
        break;
    }
    return null;
  }

  checkDeletedAccount(accountId: string): Promise<void> {
    const existing = this.deletionChecks.get(accountId);
    if (existing) return existing;
    const work = (async () => {
      const expectedCloudUserId =
        this.options.database.accounts.get(accountId)?.cloudUserId;
      if (!expectedCloudUserId) return;
      const credential = await this.getCredential(accountId);
      if (credential)
        await this.confirmDeletedAccount(
          accountId,
          credential.token,
          expectedCloudUserId,
        );
    })().finally(() => this.deletionChecks.delete(accountId));
    this.deletionChecks.set(accountId, work);
    return work;
  }
  private async cloud(path: string, init: RequestInit = {}, token?: string) {
    if (!this.options.serviceUrl)
      throw new Error("Cloud accounts are not configured.");
    return this.fetcher(new URL(path, this.options.serviceUrl), {
      ...init,
      redirect: "error",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  private async reconcileMergedIdentity(
    accountId: string,
    token: string,
    expectedCloudUserId: string,
    currentCloudUserId: string,
    identityDetails: { name?: string; email?: string },
  ): Promise<"ok" | "updated" | "conflict" | "mismatch" | "unavailable"> {
    const current = this.options.database.accounts.get(accountId);
    if (!current?.cloudUserId) return "unavailable";
    if (current.cloudUserId === currentCloudUserId) return "ok";
    if (current.cloudUserId !== expectedCloudUserId) return "unavailable";
    const proof = await this.cloud(
      `/v1/account/merged-from/${encodeURIComponent(expectedCloudUserId)}`,
      {},
      token,
    );
    if (proof.status === 404) return "mismatch";
    if (!proof.ok || object(await proof.json()).merged !== true)
      return "unavailable";
    const result = this.options.sync?.migrateMergedAccount?.(
      accountId,
      expectedCloudUserId,
      currentCloudUserId,
      identityDetails,
    );
    if (result === "conflict") {
      this.options.sync?.markMergeConflict?.(accountId);
      return "conflict";
    }
    if (result === "updated") return "updated";
    if (
      this.options.database.accounts.get(accountId)?.cloudUserId ===
      currentCloudUserId
    )
      return "ok";
    return "unavailable";
  }

  /** Verify identity and acknowledge each device before allowing any cloud sync. */
  async prepareCloudSync(
    accountId: string,
    credential: { token: string; deviceId: string },
    expectedCloudUserId: string,
  ): Promise<"ok" | "auth" | "conflict" | "unavailable"> {
    try {
      const response = await this.cloud("/v1/account", {}, credential.token);
      if (response.status === 401 || response.status === 403) return "auth";
      if (!response.ok) return "unavailable";
      const identity = object(await response.json());
      if (
        typeof identity.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(identity.id)
      )
        return "unavailable";
      const reconciled = await this.reconcileMergedIdentity(
        accountId,
        credential.token,
        expectedCloudUserId,
        identity.id,
        safeIdentityDetails(identity),
      );
      if (reconciled !== "ok" && reconciled !== "updated")
        return reconciled === "mismatch" ? "unavailable" : reconciled;
      if (
        this.options.database.accounts.get(accountId)?.cloudUserId !==
        identity.id
      )
        return "unavailable";
      if (
        identity.mergeAckRequired !== undefined &&
        typeof identity.mergeAckRequired !== "boolean"
      )
        return "unavailable";
      if (identity.mergeAckRequired === true || reconciled === "updated") {
        const operations: AccountSyncOperation[] = [];
        const cursors = new Set<string>();
        let next: string | null = null;
        do {
          const path =
            "/v1/account/merge-tombstones" +
            (next === null ? "" : `?after=${encodeURIComponent(next)}`);
          const page = await this.cloud(path, {}, credential.token);
          if (!page.ok) return "unavailable";
          const data = object(await page.json());
          if (
            data.accountId !== identity.id ||
            !Array.isArray(data.operations) ||
            data.operations.length > 100 ||
            !(
              data.next === null ||
              (typeof data.next === "string" &&
                data.next.length > 0 &&
                data.next.length <= 160)
            )
          )
            return "unavailable";
          for (const value of data.operations) {
            const parsed = AccountSyncOperationSchema.safeParse(value);
            if (
              !parsed.success ||
              parsed.data.kind !== "profile" ||
              parsed.data.action !== "delete" ||
              parsed.data.payload !== null
            )
              return "unavailable";
            operations.push(parsed.data);
          }
          next = data.next as string | null;
          if (next !== null) {
            if (cursors.has(next) || cursors.size >= 10_000)
              return "unavailable";
            cursors.add(next);
          }
        } while (next !== null);
        if (
          !this.options.sync?.applyMergeTombstones?.(
            accountId,
            identity.id,
            operations,
          )
        )
          return "unavailable";
        const ack = await this.cloud(
          "/v1/account/merge-ack",
          {
            method: "POST",
            body: JSON.stringify({ accountId: identity.id }),
          },
          credential.token,
        );
        if (!ack.ok || object(await ack.json()).ok !== true)
          return "unavailable";
      }
      return this.options.database.accounts.get(accountId)?.cloudUserId ===
        identity.id
        ? "ok"
        : "unavailable";
    } catch {
      return "unavailable";
    }
  }
  /** A 401 alone can mean device revocation; only the dedicated signal proves deletion. */
  async confirmDeletedAccount(
    accountId: string,
    token: string,
    expectedCloudUserId?: string,
  ): Promise<"deleted" | "unknown" | "unavailable"> {
    const current = this.options.database.accounts.get(accountId);
    if (!current?.cloudUserId) return "deleted";
    if (expectedCloudUserId && current.cloudUserId !== expectedCloudUserId)
      return "unavailable";
    try {
      const response = await this.cloud(
        "/v1/device/deletion-status",
        {},
        token,
      );
      if (response.status === 404) return "unknown";
      if (
        response.status !== 410 ||
        object(await response.json()).error !== "account_deleted"
      )
        return "unavailable";
      const sessions = this.options.database.auth.listDeviceHistory(accountId);
      const converted =
        this.options.sync?.convertDeletedAccount?.(
          accountId,
          current.cloudUserId,
        ) ?? false;
      if (
        !converted &&
        this.options.database.accounts.get(accountId)?.cloudUserId
      )
        return "unavailable";
      await Promise.allSettled(
        sessions.map((session) =>
          this.options.secretStore.delete(
            `account.cloud-token.${accountId}.${session.deviceId}`,
          ),
        ),
      );
      return "deleted";
    } catch {
      return "unavailable";
    }
  }
  private async validateSession(context: Context): Promise<boolean> {
    const latest = this.options.database.accounts.get(context.account.id);
    if (!latest) return false;
    if (
      latest.cloudUserId &&
      latest.cloudUserId !== context.account.cloudUserId
    )
      return false;
    if (latest && !latest.cloudUserId) {
      context.account = latest;
      return true;
    }
    if (!this.enabled || !context.session || !context.account.cloudUserId)
      return true;
    const key = `${context.account.id}:${context.session.deviceId}`;
    const previous = this.checks.get(key);
    if (previous && this.now().getTime() - previous.at < 60_000)
      return previous.job ?? previous.valid;
    const job = (async () => {
      try {
        const token = await this.options.secretStore.get(
          `account.cloud-token.${context.account.id}.${context.session!.deviceId}`,
        );
        if (!token) return false;
        const response = await this.cloud("/v1/account", {}, token);
        if (response.status === 401 || response.status === 403) {
          const deletion = await this.confirmDeletedAccount(
            context.account.id,
            token,
            context.account.cloudUserId!,
          );
          if (deletion === "deleted") {
            context.account = this.options.database.accounts.getRequired(
              context.account.id,
            );
            return true;
          }
          if (deletion === "unavailable") {
            const current = this.options.database.accounts.get(
              context.account.id,
            );
            if (!current) return false;
            if (!current.cloudUserId) {
              context.account = current;
              return true;
            }
            return current.cloudUserId === context.account.cloudUserId;
          }
          this.options.database.auth.revokeDevice(
            context.account.id,
            context.session!.deviceId,
          );
          await this.options.secretStore.delete(
            `account.cloud-token.${context.account.id}.${context.session!.deviceId}`,
          );
          return false;
        }
        if (!response.ok) return true; // Cloud outages do not revoke a previously verified, unexpired local session.
        const identity = object(await response.json());
        if (identity.id === context.account.cloudUserId) return true;
        if (
          typeof identity.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,120}$/.test(identity.id)
        )
          return false;
        const result = await this.reconcileMergedIdentity(
          context.account.id,
          token,
          context.account.cloudUserId!,
          identity.id,
          safeIdentityDetails(identity),
        );
        if (result === "ok" || result === "updated") {
          context.account = this.options.database.accounts.getRequired(
            context.account.id,
          );
          return true;
        }
        // Preserve access to local data while a conflict or transient network error is resolved.
        return result === "conflict" || result === "unavailable";
      } catch {
        return true;
      }
    })();
    this.checks.set(key, { at: this.now().getTime(), job, valid: true });
    const valid = await job;
    this.checks.set(key, { at: this.now().getTime(), valid });
    return valid;
  }
  private allowedOrigin(request: FastifyRequest) {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return (
        parsed.origin === this.options.webOrigin ||
        parsed.host === request.headers.host
      );
    } catch {
      return false;
    }
  }
  private consumeAttempt(key: string, maximum = 20) {
    const now = this.now().getTime();
    if (this.attempts.size > 1000)
      for (const [id, entry] of this.attempts)
        if (entry.resetAt <= now) this.attempts.delete(id);
    const previous = this.attempts.get(key);
    const entry =
      previous && previous.resetAt > now
        ? previous
        : { count: 0, resetAt: now + 5 * 60_000 };
    this.attempts.set(key, entry);
    return ++entry.count <= maximum;
  }
  private async checkPin(
    profileId: string,
    value: unknown,
  ): Promise<"ok" | "incorrect" | "locked" | "busy"> {
    const record = this.options.database.profiles.getPinRecord(profileId);
    if (!record.hash) return "ok";
    if (
      record.lockedUntil &&
      Date.parse(record.lockedUntil) > this.now().getTime()
    )
      return "locked";
    if (this.pinJobs.has(profileId)) return "busy";
    if (typeof value !== "string" || !/^\d{4}$/.test(value)) return "incorrect";
    this.pinJobs.add(profileId);
    try {
      const [salt, expected] = record.hash.split(":");
      const actual = (await derive(value, salt ?? "invalid-pin", 32)) as Buffer;
      if (
        !expected ||
        !/^[a-f0-9]{64}$/.test(expected) ||
        !timingSafeEqual(actual, Buffer.from(expected, "hex"))
      ) {
        this.options.database.profiles.recordPinFailure(profileId, {
          maxAttempts: 5,
          lockMs: 5 * 60_000,
        });
        return "incorrect";
      }
      // A concurrent owner change must invalidate an in-flight verification.
      if (
        this.options.database.profiles.getPinRecord(profileId).version !==
        record.version
      )
        return "incorrect";
      this.options.database.profiles.clearPinFailures(profileId);
      return "ok";
    } finally {
      this.pinJobs.delete(profileId);
    }
  }
  register(app: FastifyInstance) {
    app.addHook("preValidation", async (request, reply) => {
      const path = request.url.split("?", 1)[0]!;
      if (!path.startsWith("/api/v1/")) return;
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !this.allowedOrigin(request)
      )
        return error(
          reply,
          403,
          "ORIGIN_REJECTED",
          "Use the StreamerAI application to make this change.",
        );
      if (
        /^\/api\/v1\/(?:health\/|environment\/|auth\/(?:status|local|device(?:\/poll)?))/.test(
          path,
        )
      )
        return;
      let context = this.context(request);
      const suppliedInternal = request.headers["x-streamer-internal-token"];
      if (
        this.options.internalToken &&
        typeof suppliedInternal === "string" &&
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip) &&
        tokenEqual(suppliedInternal, this.options.internalToken)
      ) {
        const requested =
          object(request.body).profileId ??
          object(request.query).profileId ??
          object(request.params).profileId;
        const profile =
          typeof requested === "string"
            ? this.options.database.profiles.get(requested)
            : null;
        if (!profile)
          return error(
            reply,
            403,
            "PROFILE_ACCESS_DENIED",
            "A profile is required for internal tools.",
          );
        context = {
          account: this.options.database.accounts.getRequired(
            profile.accountId,
          ),
          hash: "internal",
          session: null,
          internal: true,
        };
      }
      if (!context || !(await this.validateSession(context)))
        return error(reply, 401, "AUTH_REQUIRED", "Sign in to StreamerAI.");
      this.contexts.set(request, context);
      if (context.session)
        this.options.database.auth.touchSession(context.hash);
      const params = object(request.params),
        body = object(request.body),
        query = object(request.query);
      const grantId =
        typeof params.grantId === "string" ? params.grantId : null;
      const ticketProfile = grantId
        ? this.options.tickets?.get(grantId)?.profileId
        : null;
      const explicitIds = [
        params.profileId,
        body.profileId,
        query.profileId,
        ticketProfile,
      ].filter((value): value is string => typeof value === "string");
      const profiles = this.options.database.profiles.list(context.account.id);
      const defaultProfile = profiles[0];
      const defaultScoped =
        !path.startsWith("/api/v1/account") &&
        !path.startsWith("/api/v1/auth") &&
        path !== "/api/v1/profiles" &&
        !params.profileId &&
        !grantId;
      if (defaultScoped && !defaultProfile)
        return error(
          reply,
          404,
          "PROFILE_NOT_FOUND",
          "Create a profile in this account first.",
        );
      if (defaultScoped && defaultProfile) {
        if (query.profileId === undefined) query.profileId = defaultProfile.id;
        if (
          request.body &&
          body.profileId === undefined &&
          /\/(?:discovery|setup\/complete|integrations|inference)\b/.test(path)
        )
          body.profileId = defaultProfile.id;
        if (explicitIds.length === 0) explicitIds.push(defaultProfile.id);
      }
      for (const id of explicitIds) {
        const profile = this.options.database.profiles.get(id);
        if (!profile || profile.accountId !== context.account.id)
          return error(
            reply,
            404,
            "PROFILE_NOT_FOUND",
            "This profile is not available.",
          );
        const pinManagement = /\/profiles\/[^/]+\/(?:pin|unlock|lock)$/.test(
          path,
        );
        const publicSetup = path === "/api/v1/setup/status";
        const accountIntegration =
          /\/integrations\//.test(path) || /\/inference\//.test(path);
        if (
          !pinManagement &&
          !publicSetup &&
          !accountIntegration &&
          !this.unlocked(context, id, true)
        )
          return error(
            reply,
            423,
            "PROFILE_LOCKED",
            "Enter this profile's PIN to continue.",
          );
      }
      if (
        path.startsWith("/api/v1/integrations/local-files") &&
        context.account.id !== "local"
      )
        return error(
          reply,
          403,
          "INSTALLATION_OWNER_REQUIRED",
          "Only the home server owner can manage local folders.",
        );
    });
    app.addHook("onSend", async (request, reply, payload) => {
      if (
        reply.statusCode >= 400 ||
        request.url.split("?", 1)[0] !== "/api/v1/setup/status" ||
        typeof payload !== "string"
      )
        return payload;
      const context = this.context(request);
      const id = object(request.query).profileId;
      if (context && typeof id === "string" && !this.unlocked(context, id)) {
        const response = object(JSON.parse(payload));
        delete response.profile;
        return JSON.stringify(response);
      }
      return payload;
    });
    app.get("/api/v1/auth/status", async (request, reply) => {
      let context = this.context(request);
      if (context && !this.enabled && !context.session)
        context = this.createSession(request, reply, context.account);
      if (context && !(await this.validateSession(context))) context = null;
      reply.header("cache-control", "no-store");
      return {
        enabled: this.enabled,
        cloudConfigured: this.enabled,
        localAvailable: true,
        recoveredLocalAccounts: this.recoveredLocalAccounts().map(
          (account) => ({ id: sha(account.id) }),
        ),
        authenticated: context !== null,
        account: context ? publicAccount(context.account) : null,
      };
    });
    app.post("/api/v1/auth/local", async (request, reply) => {
      if (!this.consumeAttempt(`local:${request.ip}`, 30))
        return error(
          reply,
          429,
          "RATE_LIMITED",
          "Wait before opening another local session.",
        );
      const current = this.context(request);
      if (current?.session && current.account.cloudUserId)
        return error(
          reply,
          409,
          "SIGN_OUT_FIRST",
          "Sign out of the online account before entering the local household.",
        );
      const selectedId = object(request.body).recoveredAccountId;
      const recovered = this.recoveredLocalAccounts();
      const account =
        typeof selectedId === "string"
          ? recovered.find((item) => sha(item.id) === selectedId)
          : this.options.database.accounts.getHousehold();
      if (!account)
        return error(
          reply,
          404,
          "LOCAL_ACCOUNT_UNAVAILABLE",
          "This local account is no longer available.",
        );
      this.options.database.settings.set("account.localEntryUsed", true);
      if (this.options.database.profiles.count(account.id) === 0)
        this.options.database.profiles.create({
          id: `profile-${randomUUID()}`,
          accountId: account.id,
          name: "Viewer",
          locale: "en",
          preferences: { onboardingComplete: false },
        });
      this.createSession(request, reply, account);
      reply.header("cache-control", "no-store");
      return { account: publicAccount(account) };
    });
    app.post("/api/v1/auth/device", async (request, reply) => {
      if (!this.enabled)
        return error(
          reply,
          409,
          "CLOUD_NOT_CONFIGURED",
          "Cloud accounts are not configured.",
        );
      if (!this.consumeAttempt(`pair:${request.ip}`))
        return error(
          reply,
          429,
          "RATE_LIMITED",
          "Wait before requesting another code.",
        );
      for (const [key, entry] of this.pending)
        if (entry.expiresAt <= this.now().getTime()) this.pending.delete(key);
      if (this.pending.size >= 100)
        return error(
          reply,
          429,
          "RATE_LIMITED",
          "Too many pairing requests. Try again shortly.",
        );
      const body = object(request.body);
      const localContext = this.context(request);
      const adopt = body.adoptLocalAccount === true;
      if (adopt && (!localContext?.session || localContext.account.cloudUserId))
        return error(
          reply,
          403,
          "LOCAL_ACCOUNT_REQUIRED",
          "Open the local household before choosing its online owner.",
        );
      const name =
        typeof body.deviceName === "string"
          ? body.deviceName.trim().slice(0, 80)
          : "StreamerAI browser";
      const purpose = body.purpose === "pin-reset" ? "pin-reset" : "login";
      const resetContext =
        purpose === "pin-reset" ? this.context(request) : null;
      const resetProfile =
        typeof body.profileId === "string"
          ? this.options.database.profiles.get(body.profileId)
          : null;
      if (
        purpose === "pin-reset" &&
        (!resetContext?.session ||
          !resetContext.account.cloudUserId ||
          !resetProfile ||
          resetProfile.accountId !== resetContext.account.id)
      )
        return error(
          reply,
          403,
          "PROFILE_ACCESS_DENIED",
          "Sign in to the account that owns this profile.",
        );
      try {
        const response = await this.cloud("/v1/device/code", {
          method: "POST",
          body: JSON.stringify({
            client_id: "streamer-ai-home",
            device_name: name || "StreamerAI browser",
            purpose,
            ...(resetProfile ? { profile_name: resetProfile.name } : {}),
          }),
        });
        if (!response.ok)
          return error(
            reply,
            503,
            "ACCOUNT_SERVICE_UNAVAILABLE",
            "Sign-in service is unavailable. Try again shortly.",
          );
        const grant = object(await response.json());
        if (
          typeof grant.device_code !== "string" ||
          grant.device_code.length > 512 ||
          typeof grant.user_code !== "string" ||
          typeof grant.verification_uri !== "string" ||
          typeof grant.verification_uri_complete !== "string"
        )
          throw new Error("Invalid device grant.");
        if (
          [grant.verification_uri, grant.verification_uri_complete].some(
            (uri) =>
              new URL(uri).origin !== new URL(this.options.serviceUrl!).origin,
          )
        )
          throw new Error("Invalid verification origin.");
        const lifetime = Math.min(
          600,
          Math.max(1, Number(grant.expires_in) || 300),
        );
        const interval = Math.min(30, Math.max(3, Number(grant.interval) || 5));
        const binding = randomBytes(32).toString("hex");
        const expiresAt = this.now().getTime() + lifetime * 1000;
        this.pending.set(grant.device_code, {
          binding: sha(binding),
          expiresAt,
          interval,
          nextPollAt: 0,
          name,
          purpose,
          ...(body.disableSync === true ? { disableSync: true } : {}),
          ...(adopt && localContext
            ? {
                adoptAccountId: localContext.account.id,
                sessionHash: localContext.hash,
              }
            : {}),
          ...(purpose === "pin-reset" && resetContext && resetProfile
            ? {
                accountId: resetContext.account.id,
                profileId: resetProfile.id,
                sessionHash: resetContext.hash,
              }
            : {}),
        });
        setCookie(
          reply,
          request,
          PAIR_COOKIE,
          binding,
          lifetime,
          this.options.webOrigin,
        );
        reply.header("cache-control", "no-store");
        return {
          deviceCode: grant.device_code,
          userCode: grant.user_code,
          verificationUri: grant.verification_uri,
          verificationUriComplete: grant.verification_uri_complete,
          expiresAt: new Date(expiresAt).toISOString(),
          interval,
          qrCodeDataUrl: await toDataURL(grant.verification_uri_complete, {
            width: 240,
            margin: 2,
          }),
        };
      } catch {
        return error(
          reply,
          503,
          "ACCOUNT_SERVICE_UNAVAILABLE",
          "Sign-in service is unavailable. Try again shortly.",
        );
      }
    });
    app.post("/api/v1/auth/device/poll", async (request, reply) => {
      const code = object(request.body).deviceCode;
      const pairing =
        typeof code === "string" ? this.pending.get(code) : undefined;
      const binding = cookies(request)[PAIR_COOKIE];
      if (!pairing || !binding || !tokenEqual(sha(binding), pairing.binding))
        return error(
          reply,
          403,
          "PAIRING_NOT_FOUND",
          "Start a new sign-in request on this device.",
        );
      if (pairing.expiresAt <= this.now().getTime()) {
        this.pending.delete(code as string);
        return { status: "expired" };
      }
      if (pairing.nextPollAt > this.now().getTime())
        return { status: "pending" };
      pairing.nextPollAt = this.now().getTime() + pairing.interval * 1000;
      try {
        const response = await this.cloud("/v1/device/token", {
          method: "POST",
          body: JSON.stringify({
            client_id: "streamer-ai-home",
            device_code: code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });
        const result = object(await response.json());
        if (!response.ok) {
          if (
            result.error === "authorization_pending" ||
            result.error === "slow_down"
          )
            return { status: "pending" };
          if (
            result.error === "expired_token" ||
            result.error === "access_denied"
          ) {
            this.pending.delete(code as string);
            return {
              status: result.error === "expired_token" ? "expired" : "denied",
            };
          }
          return error(
            reply,
            503,
            "ACCOUNT_SERVICE_UNAVAILABLE",
            "Sign-in service is unavailable. Try again shortly.",
          );
        }
        const identity = object(result.account),
          device = object(result.device);
        if (
          typeof result.access_token !== "string" ||
          typeof identity.id !== "string" ||
          typeof identity.email !== "string" ||
          typeof device.id !== "string"
        )
          throw new Error("Invalid device response.");
        if (pairing.purpose === "pin-reset") {
          const current = this.context(request);
          this.pending.delete(code as string);
          try {
            await this.cloud(
              `/v1/devices/${encodeURIComponent(device.id)}`,
              { method: "DELETE" },
              result.access_token,
            );
          } catch {
            /* Recovery tokens expire after five minutes and cannot synchronize. */
          }
          if (
            !current?.session ||
            current.hash !== pairing.sessionHash ||
            current.account.id !== pairing.accountId ||
            current.account.cloudUserId !== identity.id ||
            !pairing.profileId ||
            result.purpose !== "pin-reset"
          )
            return error(
              reply,
              403,
              "OWNER_VERIFICATION_FAILED",
              "Verify with the StreamerAI account that owns this profile.",
            );
          this.resets.set(
            `${current.hash}:${pairing.profileId}`,
            this.now().getTime() + 5 * 60_000,
          );
          return {
            status: "approved",
            account: publicAccount(current.account),
          };
        }
        if (result.purpose && result.purpose !== "login")
          throw new Error("Unexpected authorization purpose.");
        const existing = this.options.database.accounts.getByCloudUserId(
          identity.id,
        );
        if (pairing.adoptAccountId) {
          const current = this.context(request);
          if (
            !current?.session ||
            current.hash !== pairing.sessionHash ||
            current.account.id !== pairing.adoptAccountId ||
            current.account.cloudUserId
          ) {
            this.pending.delete(code as string);
            try {
              await this.cloud(
                `/v1/devices/${encodeURIComponent(device.id)}`,
                { method: "DELETE" },
                result.access_token,
              );
            } catch {
              /* Discarded credential. */
            }
            return error(
              reply,
              403,
              "LOCAL_ACCOUNT_REQUIRED",
              "The local session changed. Review the household again before linking it.",
            );
          }
        }
        if (
          pairing.adoptAccountId &&
          existing &&
          existing.id !== pairing.adoptAccountId
        ) {
          this.pending.delete(code as string);
          try {
            await this.cloud(
              `/v1/devices/${encodeURIComponent(device.id)}`,
              { method: "DELETE" },
              result.access_token,
            );
          } catch {
            /* Discarded token is never saved locally. */
          }
          return error(
            reply,
            409,
            "IMPORT_REVIEW_REQUIRED",
            "This online account already exists here. Sign in separately before importing local profiles.",
          );
        }
        const account = this.options.database.accounts.ensureCloudAccount(
          {
            id: identity.id,
            email: identity.email,
            name:
              (typeof identity.name === "string"
                ? identity.name.trim().slice(0, 120)
                : "") || identity.email.slice(0, 120),
          },
          pairing.adoptAccountId,
        );
        if (pairing.adoptAccountId) {
          for (const session of this.options.database.auth.listDeviceHistory(
            account.id,
          ))
            this.options.database.auth.revokeDevice(
              account.id,
              session.deviceId,
            );
        }
        if (pairing.disableSync)
          await this.options.sync?.setEnabled?.(account.id, false);
        const expiry = new Date(
          this.now().getTime() +
            Math.min(
              SESSION_MS,
              Math.max(60, Number(result.expires_in) || SESSION_MS / 1000) *
                1000,
            ),
        ).toISOString();
        await this.options.secretStore.set(
          `account.cloud-token.${account.id}.${device.id}`,
          result.access_token,
        );
        if (this.options.database.profiles.count(account.id) === 0)
          this.options.database.profiles.create({
            id: `profile-${randomUUID()}`,
            accountId: account.id,
            name: "Viewer",
            locale: "en",
            preferences: { onboardingComplete: false },
          });
        this.createSession(
          request,
          reply,
          account,
          device.id,
          pairing.name,
          expiry,
        );
        this.pending.delete(code as string);
        reply.header("cache-control", "no-store");
        return { status: "approved", account: publicAccount(account) };
      } catch {
        return error(
          reply,
          503,
          "ACCOUNT_SERVICE_UNAVAILABLE",
          "Sign-in service is unavailable. Try again shortly.",
        );
      }
    });
    app.post("/api/v1/auth/logout", async (request, reply) => {
      const context = this.context(request);
      if (context?.session) {
        this.options.database.auth.revokeSession(context.hash);
        const token = await this.options.secretStore.get(
          `account.cloud-token.${context.account.id}.${context.session.deviceId}`,
        );
        if (token) {
          try {
            await this.cloud(
              `/v1/devices/${encodeURIComponent(context.session.deviceId)}`,
              { method: "DELETE" },
              token,
            );
          } catch {
            /* Local revocation succeeds while cloud is offline. */
          }
          await this.options.secretStore.delete(
            `account.cloud-token.${context.account.id}.${context.session.deviceId}`,
          );
        }
      }
      setCookie(reply, request, COOKIE, "", 0, this.options.webOrigin);
      return reply.code(204).send();
    });
    app.get("/api/v1/account", async (request) => {
      const context = this.context(request)!;
      const seen = new Set<string>();
      const devices = this.options.database.auth
        .listDevices(context.account.id)
        .filter((session) => {
          if (
            session.revokedAt ||
            Date.parse(session.expiresAt) <= this.now().getTime() ||
            seen.has(session.deviceId)
          )
            return false;
          seen.add(session.deviceId);
          return true;
        })
        .map((session) => ({
          id: session.deviceId,
          name: session.label,
          lastSeenAt: session.lastSeenAt,
          expiresAt: session.expiresAt,
          current: session.deviceId === context.session?.deviceId,
        }));
      return {
        account: publicAccount(context.account),
        devices,
        manageUrl:
          this.options.serviceUrl && context.account.cloudUserId
            ? new URL(
                `/account?account_id=${encodeURIComponent(context.account.cloudUserId)}`,
                this.options.serviceUrl,
              ).href
            : null,
        sync: this.options.sync?.status(context.account.id) ?? {
          configured: this.enabled && !!context.account.cloudUserId,
          status: "idle",
          lastSyncedAt: null,
          error: null,
        },
      };
    });
    app.get("/api/v1/account/connections", async (request, reply) => {
      const account = this.account(request);
      if (!account.cloudUserId)
        return { accountId: account.id, connections: [] };
      const credential = await this.getCredential(account.id);
      if (credential) {
        try {
          const response = await this.cloud(
            "/v1/account/connections",
            {},
            credential.token,
          );
          if (response.ok) {
            const result = object(await response.json());
            if (
              result.accountId === account.cloudUserId &&
              Array.isArray(result.connections)
            )
              return {
                accountId: account.id,
                connections: result.connections.flatMap((value) => {
                  const item = object(value);
                  return typeof item.provider === "string" &&
                    typeof item.name === "string" &&
                    typeof item.connected === "boolean" &&
                    typeof item.available === "boolean"
                    ? [
                        {
                          provider: item.provider,
                          name: item.name,
                          connected: item.connected,
                          available: item.available,
                        },
                      ]
                    : [];
                }),
              };
          }
        } catch {
          /* Keep local account settings usable while cloud is offline. */
        }
      }
      return error(
        reply,
        503,
        "ACCOUNT_CONNECTIONS_UNAVAILABLE",
        "Connected accounts are temporarily unavailable. Your local data is still available.",
      );
    });
    app.delete<{ Params: { deviceId: string } }>(
      "/api/v1/account/devices/:deviceId",
      async (request, reply) => {
        const context = this.context(request)!;
        const id = request.params.deviceId;
        if (
          !this.options.database.auth
            .listDevices(context.account.id)
            .some((session) => session.deviceId === id)
        )
          return error(
            reply,
            404,
            "DEVICE_NOT_FOUND",
            "This device is not available.",
          );
        const credential = await this.getCredential(context.account.id);
        if (credential) {
          try {
            await this.cloud(
              `/v1/devices/${encodeURIComponent(id)}`,
              { method: "DELETE" },
              credential.token,
            );
          } catch {
            /* Local revocation still applies. */
          }
        }
        this.options.database.auth.revokeDevice(context.account.id, id);
        await this.options.secretStore.delete(
          `account.cloud-token.${context.account.id}.${id}`,
        );
        this.checks.delete(`${context.account.id}:${id}`);
        return reply.code(204).send();
      },
    );
    app.post(
      "/api/v1/account/sync",
      async (request) =>
        this.options.sync?.sync(this.account(request).id) ?? {
          configured: false,
          status: "idle",
          lastSyncedAt: null,
          error: null,
        },
    );
    app.put("/api/v1/account/sync", async (request, reply) => {
      const enabled = object(request.body).enabled;
      const account = this.account(request);
      if (typeof enabled !== "boolean")
        return error(
          reply,
          400,
          "INVALID_SYNC_SETTING",
          "Choose whether to enable synchronization.",
        );
      if (!account.cloudUserId || !this.options.sync?.setEnabled)
        return error(
          reply,
          409,
          "CLOUD_NOT_CONFIGURED",
          "Connect this account before enabling cloud synchronization.",
        );
      return this.options.sync.setEnabled(account.id, enabled);
    });
    app.get<{ Params: { profileId: string } }>(
      "/api/v1/account/sync/profile/:profileId",
      async (request, reply) => {
        const account = this.account(request);
        if (!account.cloudUserId || !this.options.sync?.profileStatus)
          return error(
            reply,
            409,
            "CLOUD_NOT_CONFIGURED",
            "Connect this account before managing profile synchronization.",
          );
        return this.options.sync.profileStatus(
          account.id,
          request.params.profileId,
        );
      },
    );
    app.put<{ Params: { profileId: string } }>(
      "/api/v1/account/sync/profile/:profileId",
      async (request, reply) => {
        const account = this.account(request);
        const paused = object(request.body).paused;
        if (typeof paused !== "boolean")
          return error(
            reply,
            400,
            "INVALID_SYNC_SETTING",
            "Choose whether to pause this profile.",
          );
        if (!account.cloudUserId || !this.options.sync?.setProfilePaused)
          return error(
            reply,
            409,
            "CLOUD_NOT_CONFIGURED",
            "Connect this account before managing profile synchronization.",
          );
        return this.options.sync.setProfilePaused(
          account.id,
          request.params.profileId,
          paused,
        );
      },
    );
    app.post<{ Params: { profileId: string } }>(
      "/api/v1/profiles/:profileId/unlock",
      async (request, reply) => {
        let context = this.context(request)!;
        const id = request.params.profileId;
        const pin = object(request.body).pin;
        if (typeof pin !== "string" || !/^\d{4}$/.test(pin))
          return error(
            reply,
            400,
            "INVALID_PIN",
            "Enter a PIN containing exactly 4 digits.",
          );
        const result = await this.checkPin(id, pin);
        if (result === "locked" || result === "busy")
          return error(
            reply,
            429,
            "PIN_RATE_LIMITED",
            "Too many attempts. Try again later.",
          );
        if (result !== "ok")
          return error(reply, 403, "PIN_INCORRECT", "The PIN is incorrect.");
        const record = this.options.database.profiles.getPinRecord(id);
        if (!context.session)
          context = this.createSession(request, reply, context.account);
        this.options.database.profiles.clearPinFailures(id);
        this.unlocks.set(`${context.hash}:${id}`, {
          version: record.version,
          expiresAt: this.now().getTime() + UNLOCK_MS,
        });
        return reply.code(204).send();
      },
    );
    app.post<{ Params: { profileId: string } }>(
      "/api/v1/profiles/:profileId/lock",
      async (request, reply) => {
        this.unlocks.delete(
          `${this.context(request)!.hash}:${request.params.profileId}`,
        );
        return reply.code(204).send();
      },
    );
    app.put<{ Params: { profileId: string } }>(
      "/api/v1/profiles/:profileId/pin",
      async (request, reply) => {
        let context = this.context(request)!;
        const id = request.params.profileId;
        const pin = object(request.body).pin;
        if (pin !== null && (typeof pin !== "string" || !/^\d{4}$/.test(pin)))
          return error(
            reply,
            400,
            "INVALID_PIN",
            "Use a PIN containing exactly 4 digits.",
          );
        if (!this.consumeAttempt(`pin:${context.account.id}`, 20))
          return error(
            reply,
            429,
            "RATE_LIMITED",
            "Wait before changing PINs again.",
          );
        const resetKey = `${context.hash}:${id}`;
        const ownerReset =
          (this.resets.get(resetKey) ?? 0) > this.now().getTime();
        if (
          this.options.database.profiles.getPinRecord(id).hash &&
          !ownerReset
        ) {
          const result = await this.checkPin(
            id,
            object(request.body).currentPin,
          );
          if (result === "locked" || result === "busy")
            return error(
              reply,
              429,
              "PIN_RATE_LIMITED",
              "Too many attempts. Try again later.",
            );
          if (result !== "ok")
            return error(
              reply,
              403,
              "PIN_INCORRECT",
              "Enter the current PIN or verify the StreamerAI account owner.",
            );
        }
        const salt = randomBytes(16).toString("hex");
        const hash =
          pin === null
            ? null
            : `${salt}:${((await derive(pin as string, salt, 32)) as Buffer).toString("hex")}`;
        this.options.database.profiles.setPinHash(id, hash);
        this.resets.delete(resetKey);
        if (!context.session)
          context = this.createSession(request, reply, context.account);
        const record = this.options.database.profiles.getPinRecord(id);
        this.unlocks.set(`${context.hash}:${id}`, {
          version: record.version,
          expiresAt: this.now().getTime() + UNLOCK_MS,
        });
        return { pinEnabled: pin !== null };
      },
    );
  }
}
