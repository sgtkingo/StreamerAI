import {
  createHash,
  createHmac,
  pbkdf2,
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
import type { LocalAccessService } from "./local-access.js";
import {
  createMasterPinVerifier,
  isMasterPinVerifier,
  MasterPinService,
} from "./master-pin.js";
import {
  householdAccountKey,
  householdCloudCredentialKey,
  householdId,
  householdIdKey,
  householdPendingKey,
  householdReadyKey,
  type PendingHousehold,
} from "./household-state.js";

const derive = promisify(scrypt);
const derivePin = promisify(pbkdf2);
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
  sessionHash?: string;
  adoptAccountId?: string;
  disableSync?: boolean;
  householdAccountId?: string;
  unified?: boolean;
}
interface SyncStatus {
  configured: boolean;
  status: string;
  lastSyncedAt: string | null;
  error: string | null;
}
export interface AccountAuthOptions {
  localAccess?: LocalAccessService;
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
  private readonly resets = new Map<
    string,
    { accountId: string; expiresAt: number }
  >();
  private readonly pinJobs = new Set<string>();
  private readonly masterPins: MasterPinService;
  private readonly ownerRequests = new Map<
    string,
    {
      session: string;
      accountId: string;
      profileId: string;
      version: number;
      deviceId: string;
      expiresAt: number;
      local?: boolean;
      purpose?: "unlock" | "change" | "reset";
      status?: "pending" | "approved" | "denied";
    }
  >();
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
    this.masterPins = new MasterPinService(options.secretStore);
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
    if (
      this.options.localAccess?.enabled &&
      !this.options.localAccess.actor(request)
    )
      return null;
    const known = this.contexts.get(request);
    if (known) return known;
    const actor = this.options.localAccess?.actor(request);
    const household = this.options.database.accounts.getHousehold();
    if (this.options.localAccess?.isSetupSession(request))
      return {
        account: household,
        session: null,
        hash: `setup:${actor!.id}`,
        internal: false,
      };
    if (
      actor &&
      (actor.role === "owner" ||
        this.options.database.settings.get(householdReadyKey(household.id)) ===
          true)
    )
      return {
        account: household,
        session: null,
        hash: `installation:${actor.id}`,
        internal: false,
      };
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
      account: household,
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
    const serverCredential = await this.options.secretStore.get(
      householdCloudCredentialKey(accountId),
    );
    if (serverCredential && expectedCloudUserId) {
      const parsed = JSON.parse(serverCredential) as {
        token: string;
        deviceId: string;
        cloudUserId: string;
      };
      if (parsed.cloudUserId === expectedCloudUserId)
        return { token: parsed.token, deviceId: parsed.deviceId };
    }
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
    if (
      this.options.database.settings.get(householdAccountKey) ===
        context.account.id &&
      (this.options.database.settings.get(
        householdReadyKey(context.account.id),
      ) === true ||
        !this.options.localAccess?.enabled)
    ) {
      const current = this.options.database.accounts.get(context.account.id);
      if (!current) return false;
      context.account = current;
      return true;
    }
    if (
      context.session?.label === "Offline restored household" &&
      this.options.database.settings.get("server.offlineRestore")
    )
      return true;
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
  private async refreshMasterPin(account: Account) {
    // A household owns its local PIN. Cloud identity authentication never replaces it.
    if (this.options.database.settings.get(householdAccountKey) === account.id)
      return;
    if (!account.cloudUserId || !this.enabled) return;
    const credential = await this.getCredential(account.id);
    if (!credential) return;
    try {
      const response = await this.cloud(
        "/v1/account/master-pin",
        {},
        credential.token,
      );
      if (!response.ok) return;
      const result = object(await response.json());
      if (
        result.accountId === account.cloudUserId &&
        isMasterPinVerifier(result.verifier)
      )
        await this.masterPins.cacheVerifier(account.id, result.verifier);
    } catch {
      /* Cached verifier preserves offline access. */
    }
  }

  private bindHousehold(accountId: string) {
    this.options.database.settings.set(householdAccountKey, accountId);
    this.options.localAccess?.bindHousehold(accountId);
  }

  async authorizeHouseholdPin(pin: string): Promise<boolean> {
    return (
      (await this.checkMasterPin(
        this.options.database.accounts.getHousehold(),
        pin,
      )) === "ok"
    );
  }

  async installationHouseholdStatus() {
    const account = this.options.database.accounts.getHousehold();
    const master = await this.masterPins.read(account.id);
    return {
      householdReady:
        this.options.database.settings.get(householdReadyKey(account.id)) ===
          true ||
        (!!master?.pin &&
          !this.options.database.settings.get(householdPendingKey(account.id))),
      householdName: account.name || "StreamerAI household",
      masterPinEnabled: !!master,
      cloudConfigured: this.enabled,
      cloudLinked: !!account.cloudUserId,
    };
  }

  /** Retry remote attachment from the locally stored PIN; clients never need to enter it twice. */
  async resumeHousehold(accountId: string): Promise<boolean> {
    const account = this.options.database.accounts.getRequired(accountId);
    const pending = this.options.database.settings.get<PendingHousehold>(
      householdPendingKey(accountId),
    );
    if (pending?.kind === "restore" || pending?.kind === "create") return false;
    const master = await this.masterPins.read(accountId);
    if (!master?.pin) return false;
    this.bindHousehold(accountId);
    this.options.database.settings.set(householdReadyKey(accountId), true);
    if (!pending) return true;
    if (!account.cloudUserId) {
      this.options.database.settings.delete(householdPendingKey(accountId));
      return true;
    }
    try {
      const credential = await this.getCredential(accountId);
      if (!credential) return false;
      const response = await this.cloud(
        "/v1/households",
        {
          method: "POST",
          body: JSON.stringify({
            householdId: householdId(this.options.database, accountId),
            name: account.name || "StreamerAI household",
            serverId: this.options.database.settings.get("server.instanceId"),
          }),
        },
        credential.token,
      );
      if (!response.ok) return false;
      this.options.database.settings.delete(householdPendingKey(accountId));
      await this.options.sync?.setEnabled?.(accountId, true);
      return true;
    } catch {
      return false;
    }
  }

  async completeHouseholdSetup(accountId: string): Promise<void> {
    const pin = await this.masterPins.read(accountId);
    if (!pin?.pin) throw new Error("The household Master PIN is unavailable.");
    const alreadyReady =
      this.options.database.settings.get(householdReadyKey(accountId)) === true;
    this.bindHousehold(accountId);
    this.options.database.settings.set(householdReadyKey(accountId), true);
    if (
      alreadyReady &&
      !this.options.database.settings.get(householdPendingKey(accountId))
    )
      return;
    if (this.options.database.accounts.getRequired(accountId).cloudUserId) {
      this.options.database.settings.set(householdPendingKey(accountId), {
        kind: "register",
      } satisfies PendingHousehold);
      await this.resumeHousehold(accountId);
    } else
      this.options.database.settings.delete(householdPendingKey(accountId));
  }

  async validateHouseholdImport(
    accountId: string,
    pin: string,
  ): Promise<boolean> {
    const account = this.options.database.accounts.getRequired(accountId);
    const pending = this.options.database.settings.get<PendingHousehold>(
      householdPendingKey(accountId),
    );
    if (!account.cloudUserId || pending?.kind !== "restore") return true;
    await this.refreshMasterPin(account);
    return this.masterPins.verify(accountId, pin);
  }

  async completeHouseholdImport(
    accountId: string,
    datasetId: string,
  ): Promise<void> {
    this.options.database.settings.set(householdIdKey(accountId), datasetId);
    await this.completeHouseholdSetup(accountId);
  }
  private async checkMasterPin(
    account: Account,
    pin: string,
  ): Promise<"ok" | "incorrect" | "locked" | "busy"> {
    const key = `master:${account.id}`;
    const lockKey = `account.masterPinAttempts.${sha(account.id)}`;
    const previous = this.options.database.settings.get<{
      count: number;
      lockedUntil: number;
    }>(lockKey);
    if (previous && previous.lockedUntil > this.now().getTime())
      return "locked";
    if (this.pinJobs.has(key)) return "busy";
    this.pinJobs.add(key);
    try {
      await this.refreshMasterPin(account);
      if (await this.masterPins.verify(account.id, pin)) {
        this.options.database.settings.set(lockKey, {
          count: 0,
          lockedUntil: 0,
        });
        return "ok";
      }
      const count =
        previous && previous.lockedUntil === 0 ? previous.count + 1 : 1;
      this.options.database.settings.set(lockKey, {
        count,
        lockedUntil: count >= 5 ? this.now().getTime() + 300_000 : 0,
      });
      return "incorrect";
    } finally {
      this.pinJobs.delete(key);
    }
  }
  private ownerResetAvailable(account: Account) {
    if (
      this.options.database.settings.get(householdAccountKey) === account.id &&
      this.options.database.settings.get(householdReadyKey(account.id)) === true
    )
      return true;
    const sync = this.options.sync?.status(account.id);
    return (
      this.enabled &&
      !!account.cloudUserId &&
      !!sync?.configured &&
      sync.status !== "disabled"
    );
  }
  listLocalPinResets() {
    const accountId = this.options.database.accounts.getHousehold().id;
    return [...this.ownerRequests.entries()].flatMap(([id, request]) => {
      const profile = this.options.database.profiles.get(request.profileId);
      return request.local &&
        request.accountId === accountId &&
        request.status === "pending" &&
        request.expiresAt > this.now().getTime() &&
        profile
        ? [
            {
              id,
              profileId: profile.id,
              profileName: profile.name,
              deviceName: request.deviceId,
              purpose: request.purpose ?? "reset",
              expiresAt: new Date(request.expiresAt).toISOString(),
            },
          ]
        : [];
    });
  }
  decideLocalPinReset(id: string, approve: boolean): boolean {
    const request = this.ownerRequests.get(id);
    if (
      !request?.local ||
      request.accountId !== this.options.database.accounts.getHousehold().id ||
      request.expiresAt <= this.now().getTime() ||
      request.status !== "pending"
    )
      return false;
    request.status = approve ? "approved" : "denied";
    return true;
  }
  register(app: FastifyInstance) {
    app.addHook("preValidation", async (request, reply) => {
      const path = request.url.split("?", 1)[0]!;
      if (!path.startsWith("/api/v1/")) return;
      if (path.startsWith("/api/v1/installation/")) return;
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
        ) ||
        path === "/api/v1/installation/discovery" ||
        path === "/api/v1/account/cloud/device" ||
        path === "/api/v1/account/cloud/device/poll"
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
      if (
        (path.startsWith("/api/v1/admin/") ||
          path === "/api/v1/account/backup-schedule") &&
        this.options.localAccess?.enabled &&
        !this.options.localAccess.isOwner(request)
      )
        return error(
          reply,
          403,
          "INSTALLATION_OWNER_REQUIRED",
          "Open household administration as its owner.",
        );
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
        !path.startsWith("/api/v1/admin/") &&
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
        const pinManagement =
          /\/profiles\/[^/]+\/(?:pin|unlock|lock|pin-reset(?:\/poll)?)$/.test(
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
      const restoredOwnerNeedsSelection =
        this.options.localAccess?.isOwner(request) &&
        !!this.options.database.settings.get("server.offlineRestore") &&
        !context?.session;
      if (restoredOwnerNeedsSelection) context = null;
      if (context && !this.enabled && !context.session)
        context = this.createSession(request, reply, context.account);
      if (context && !(await this.validateSession(context))) context = null;
      const activeHousehold = this.options.database.accounts.getHousehold();
      const master = await this.masterPins.read(activeHousehold.id);
      const pendingHousehold =
        this.options.database.settings.get<PendingHousehold>(
          householdPendingKey(activeHousehold.id),
        );
      if (master?.pin && !pendingHousehold) {
        this.bindHousehold(activeHousehold.id);
        this.options.database.settings.set(
          householdReadyKey(activeHousehold.id),
          true,
        );
      }
      const localAccount = this.options.database.accounts.getLocal();
      const household = localAccount.cloudUserId
        ? this.options.database.accounts
            .list()
            .find(
              (account) =>
                !account.cloudUserId && account.id.startsWith("household:"),
            )
        : localAccount;
      reply.header("cache-control", "no-store");
      return {
        enabled: this.enabled || this.options.localAccess?.enabled === true,
        cloudConfigured: this.enabled,
        localAvailable:
          !this.options.localAccess?.enabled ||
          this.options.localAccess.actor(request) !== null,
        recoveredLocalAccounts: (this.options.localAccess?.enabled &&
        !this.options.localAccess.actor(request)
          ? []
          : this.options.localAccess?.isOwner(request) &&
              this.options.database.settings.get("server.offlineRestore")
            ? this.options.database.accounts
                .list()
                .filter(
                  (account) =>
                    account.id !== "local" || account.cloudUserId !== null,
                )
            : this.recoveredLocalAccounts()
        ).map((account) => ({ id: sha(account.id) })),
        authenticated: context !== null,
        householdReady:
          this.options.database.settings.get(
            householdReadyKey(activeHousehold.id),
          ) === true,
        householdSetupStarted:
          this.options.database.settings.get("household.setupStarted") ===
            true || pendingHousehold !== null,
        householdRestoreRequired: pendingHousehold?.kind === "restore",
        householdCloudSetupPending: pendingHousehold?.kind === "register",
        householdSelectionRequired:
          this.options.database.settings.get(
            `household.cloudSelection.${activeHousehold.id}`,
          ) === true,
        householdPinRequired:
          !!master && !master.pin && pendingHousehold?.kind !== "restore",
        householdId: this.options.database.settings.get<string>(
          householdIdKey(activeHousehold.id),
        ),
        account: context ? publicAccount(context.account) : null,
        ownerResetAvailable: context
          ? this.ownerResetAvailable(context.account)
          : false,
        masterPinEnabled: context
          ? !!(await this.masterPins.read(context.account.id))
          : false,
        masterPinSetupRequired:
          !!context &&
          pendingHousehold?.kind !== "restore" &&
          !(await this.masterPins.read(context.account.id)),
        localMasterPinRequired:
          !household || !(await this.masterPins.read(household.id)),
      };
    });
    app.post("/api/v1/auth/local", async (request, reply) => {
      const settingUp =
        this.options.localAccess?.isSetupSession(request) === true;
      if (!this.consumeAttempt(`local:${request.ip}`, 30))
        return error(
          reply,
          429,
          "RATE_LIMITED",
          "Wait before opening another local session.",
        );
      const current = this.context(request);
      if (
        current?.session &&
        current.account.cloudUserId &&
        this.options.database.settings.get(householdAccountKey) !==
          current.account.id
      )
        return error(
          reply,
          409,
          "SIGN_OUT_FIRST",
          "Sign out of the online account before entering the local household.",
        );
      const selectedId = object(request.body).recoveredAccountId;
      const restoring =
        this.options.localAccess?.isOwner(request) &&
        !!this.options.database.settings.get("server.offlineRestore");
      const recovered = restoring
        ? this.options.database.accounts.list()
        : this.recoveredLocalAccounts();
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
      if (
        settingUp &&
        (this.options.database.settings.get<PendingHousehold>(
          householdPendingKey(account.id),
        )?.kind === "restore" ||
          this.options.database.settings.get(
            `household.cloudSelection.${account.id}`,
          ))
      )
        return error(
          reply,
          409,
          "HOUSEHOLD_RESTORE_REQUIRED",
          "Select and restore your cloud household using its existing Master PIN.",
        );
      this.bindHousehold(account.id);
      this.options.database.settings.set("household.setupStarted", true);
      if (!(await this.masterPins.read(account.id))) {
        const pin = object(request.body).masterPin;
        const profiles = this.options.database.profiles.list(account.id);
        const deferForWelcome =
          object(request.body).deferMasterPin === true &&
          profiles.length <= 1 &&
          profiles.every(
            (profile) =>
              profile.name === "Viewer" &&
              !profile.pinEnabled &&
              profile.preferences.onboardingComplete !== true,
          );
        if (typeof pin === "string" && /^\d{8}$/.test(pin)) {
          const job = `setup-master:${account.id}`;
          if (this.pinJobs.has(job))
            return error(
              reply,
              409,
              "MASTER_PIN_SETUP_PENDING",
              "Master PIN setup is already in progress.",
            );
          this.pinJobs.add(job);
          try {
            await this.masterPins.setupLocal(account.id, pin);
          } finally {
            this.pinJobs.delete(job);
          }
        } else if (!deferForWelcome) {
          return error(
            reply,
            400,
            "MASTER_PIN_REQUIRED",
            "Choose an 8-digit Master PIN before creating a local account.",
          );
        }
      }
      if ((await this.masterPins.read(account.id))?.pin)
        await this.completeHouseholdSetup(account.id);
      this.options.database.settings.set("account.localEntryUsed", true);
      if (this.options.database.profiles.count(account.id) === 0)
        this.options.database.profiles.create({
          id: `profile-${randomUUID()}`,
          accountId: account.id,
          name: "Viewer",
          locale: "en",
          preferences: { onboardingComplete: false },
        });
      if (settingUp) {
        if ((await this.masterPins.read(account.id))?.pin)
          await this.options.localAccess?.finishSetup(request, reply);
      } else
        this.createSession(
          request,
          reply,
          account,
          undefined,
          restoring ? "Offline restored household" : "Local browser",
        );
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
      if (body.purpose === "pin-reset")
        return error(
          reply,
          409,
          "USE_ACCOUNT_PIN_RESET",
          "Request PIN recovery from the signed-in account.",
        );
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
      try {
        const response = await this.cloud("/v1/device/code", {
          method: "POST",
          body: JSON.stringify({
            client_id: "streamer-ai-home",
            device_name: name || "StreamerAI browser",
            purpose: "login",
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
          ...(body.disableSync === true ? { disableSync: true } : {}),
          ...(adopt && localContext
            ? {
                adoptAccountId: localContext.account.id,
                sessionHash: localContext.hash,
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
        await this.refreshMasterPin(account);
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
        account: {
          ...publicAccount(context.account),
          cloudAccountId: context.account.cloudUserId,
        },
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
        cloudConfigured: this.enabled,
        householdId: householdId(this.options.database, context.account.id),
        serverId: this.options.database.settings.get("server.instanceId"),
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
      if (!enabled) {
        for (const [id, pending] of this.ownerRequests)
          if (pending.accountId === account.id) this.ownerRequests.delete(id);
        for (const [id, approval] of this.resets)
          if (approval.accountId === account.id) this.resets.delete(id);
      }
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
      "/api/v1/profiles/:profileId/pin-reset",
      async (request, reply) => {
        const context = this.context(request)!;
        const purpose = object(request.body).purpose ?? "reset";
        if (!["unlock", "change", "reset"].includes(String(purpose)))
          return error(
            reply,
            400,
            "INVALID_REQUEST",
            "Invalid approval purpose.",
          );
        if (
          this.options.database.settings.get(householdAccountKey) ===
            context.account.id &&
          this.ownerResetAvailable(context.account)
        ) {
          if (!this.consumeAttempt(`local-owner-reset:${context.hash}`, 5))
            return error(
              reply,
              429,
              "RATE_LIMITED",
              "Wait before requesting another PIN reset.",
            );
          const profile = this.options.database.profiles.getRequired(
            request.params.profileId,
          );
          const id = randomUUID(),
            expiresAt = this.now().getTime() + 300_000;
          this.ownerRequests.set(id, {
            local: true,
            purpose: purpose as "unlock" | "change" | "reset",
            status: "pending",
            session: context.hash,
            accountId: context.account.id,
            profileId: profile.id,
            version: this.options.database.profiles.getPinRecord(profile.id)
              .version,
            deviceId:
              this.options.localAccess?.actor(request)?.name ??
              "Household client",
            expiresAt,
          });
          const origin = new URL(
            this.options.webOrigin ?? "http://localhost:5173",
          );
          if (request.headers.host) origin.host = request.headers.host;
          return {
            id,
            expiresAt: new Date(expiresAt).toISOString(),
            manageUrl: new URL(`/admin?tab=profiles&request=${id}`, origin)
              .href,
          };
        }
        if (
          purpose !== "reset" ||
          !context.session ||
          !this.ownerResetAvailable(context.account)
        )
          return error(
            reply,
            403,
            "PIN_RESET_UNAVAILABLE",
            "A PIN cannot be reset without an online account with synchronization enabled.",
          );
        if (!this.consumeAttempt(`owner-reset:${context.account.id}`, 5))
          return error(
            reply,
            429,
            "RATE_LIMITED",
            "Wait before requesting another PIN reset.",
          );
        const credential = await this.getCredential(context.account.id);
        if (!credential)
          return error(
            reply,
            401,
            "ACCOUNT_SIGN_IN_REQUIRED",
            "Sign in to your account again.",
          );
        const profile = this.options.database.profiles.getRequired(
          request.params.profileId,
        );
        const pinVersion = this.options.database.profiles.getPinRecord(
          profile.id,
        ).version;
        try {
          const response = await this.cloud(
            "/v1/account/pin-resets",
            {
              method: "POST",
              body: JSON.stringify({ profileName: profile.name }),
            },
            credential.token,
          );
          if (!response.ok) throw new Error("Request failed");
          const result = object(await response.json());
          if (
            typeof result.id !== "string" ||
            !/^[a-f0-9-]{36}$/.test(result.id) ||
            typeof result.expiresAt !== "number" ||
            result.expiresAt <= this.now().getTime()
          )
            throw new Error("Invalid reset request");
          for (const [id, pending] of this.ownerRequests)
            if (
              pending.expiresAt <= this.now().getTime() ||
              (pending.session === context.hash &&
                pending.profileId === profile.id)
            )
              this.ownerRequests.delete(id);
          this.ownerRequests.set(result.id, {
            session: context.hash,
            accountId: context.account.id,
            profileId: profile.id,
            version: pinVersion,
            deviceId: credential.deviceId,
            expiresAt: Math.min(
              result.expiresAt,
              this.now().getTime() + 300_000,
            ),
          });
          return {
            id: result.id,
            expiresAt: new Date(result.expiresAt).toISOString(),
            manageUrl: new URL(
              `/account?account_id=${encodeURIComponent(context.account.cloudUserId!)}`,
              this.options.serviceUrl!,
            ).href,
          };
        } catch {
          return error(
            reply,
            503,
            "ACCOUNT_SERVICE_UNAVAILABLE",
            "Account verification is temporarily unavailable.",
          );
        }
      },
    );
    app.post<{ Params: { profileId: string } }>(
      "/api/v1/profiles/:profileId/pin-reset/poll",
      async (request, reply) => {
        const context = this.context(request)!;
        const id = object(request.body).requestId;
        const pending =
          typeof id === "string" ? this.ownerRequests.get(id) : undefined;
        if (
          !pending ||
          pending.session !== context.hash ||
          pending.accountId !== context.account.id ||
          pending.profileId !== request.params.profileId ||
          !this.ownerResetAvailable(context.account)
        )
          return error(
            reply,
            403,
            "PIN_RESET_UNAVAILABLE",
            "This PIN reset request is not available.",
          );
        if (
          pending.expiresAt <= this.now().getTime() ||
          pending.version !==
            this.options.database.profiles.getPinRecord(pending.profileId)
              .version
        ) {
          this.ownerRequests.delete(id as string);
          return { status: "expired" };
        }
        if (!this.consumeAttempt(`owner-poll:${context.hash}`, 100))
          return error(
            reply,
            429,
            "RATE_LIMITED",
            "Wait before checking again.",
          );
        if (pending.local) {
          const status = pending.status ?? "pending";
          if (status !== "pending") this.ownerRequests.delete(id as string);
          if (status === "approved" && pending.purpose === "unlock") {
            this.unlocks.set(`${context.hash}:${pending.profileId}`, {
              version: pending.version,
              expiresAt: this.now().getTime() + UNLOCK_MS,
            });
          } else if (status === "approved")
            this.resets.set(
              `${context.hash}:${pending.profileId}:${pending.version}`,
              {
                accountId: context.account.id,
                expiresAt: this.now().getTime() + 300_000,
              },
            );
          return { status };
        }
        const credential = await this.getCredential(context.account.id);
        if (!credential || credential.deviceId !== pending.deviceId)
          return error(
            reply,
            401,
            "ACCOUNT_SIGN_IN_REQUIRED",
            "Sign in to your account again.",
          );
        try {
          const response = await this.cloud(
            `/v1/account/pin-resets/${id as string}/consume`,
            { method: "POST", body: "{}" },
            credential.token,
          );
          if (!response.ok) throw new Error("Request failed");
          const result = object(await response.json());
          if (
            !["pending", "approved", "expired", "denied"].includes(
              String(result.status),
            )
          )
            throw new Error("Invalid reset status");
          if (result.status !== "pending")
            this.ownerRequests.delete(id as string);
          if (result.status === "approved") {
            const liveSession = this.options.database.auth.getSession(
              pending.session,
            );
            if (
              !liveSession ||
              liveSession.revokedAt ||
              Date.parse(liveSession.expiresAt) <= this.now().getTime() ||
              this.context(request)?.hash !== pending.session ||
              !this.ownerResetAvailable(context.account) ||
              pending.version !==
                this.options.database.profiles.getPinRecord(pending.profileId)
                  .version
            )
              return error(
                reply,
                403,
                "PIN_RESET_UNAVAILABLE",
                "This PIN reset request is no longer valid.",
              );
            this.resets.set(
              `${context.hash}:${pending.profileId}:${pending.version}`,
              {
                accountId: context.account.id,
                expiresAt: this.now().getTime() + 300_000,
              },
            );
          }
          return { status: result.status };
        } catch {
          return error(
            reply,
            503,
            "ACCOUNT_SERVICE_UNAVAILABLE",
            "Account verification is temporarily unavailable.",
          );
        }
      },
    );
    app.post("/api/v1/account/master-pin", async (request, reply) => {
      const context = this.context(request)!;
      if (
        this.options.database.settings.get<PendingHousehold>(
          householdPendingKey(context.account.id),
        )?.kind === "restore" ||
        this.options.database.settings.get(
          `household.cloudSelection.${context.account.id}`,
        )
      )
        return error(
          reply,
          409,
          "HOUSEHOLD_RESTORE_REQUIRED",
          "Restore the selected household with its existing Master PIN.",
        );
      if (await this.masterPins.read(context.account.id))
        return error(
          reply,
          403,
          "MASTER_PIN_IMMUTABLE",
          "A Master PIN is already set. Use the change form to update it.",
        );
      const body = object(request.body);
      if (
        typeof body.pin !== "string" ||
        !/^\d{8}$/.test(body.pin) ||
        body.pin !== body.confirmation
      )
        return error(
          reply,
          400,
          "INVALID_MASTER_PIN",
          "Choose and confirm an 8-digit Master PIN.",
        );
      const job = `setup-master:${context.account.id}`;
      if (this.pinJobs.has(job))
        return error(
          reply,
          409,
          "MASTER_PIN_SETUP_PENDING",
          "Master PIN setup is already in progress.",
        );
      this.pinJobs.add(job);
      try {
        await this.masterPins.setupLocal(context.account.id, body.pin);
      } finally {
        this.pinJobs.delete(job);
      }
      this.options.database.settings.set("account.localEntryUsed", true);
      await this.completeHouseholdSetup(context.account.id);
      await this.options.localAccess?.finishSetup(request, reply);
      return { ok: true };
    });
    app.post("/api/v1/account/master-pin/verify", async (request, reply) => {
      const context = this.context(request)!;
      const pin = object(request.body).pin;
      if (typeof pin !== "string" || !/^\d{8}$/.test(pin))
        return error(
          reply,
          400,
          "INVALID_MASTER_PIN",
          "Enter your 8-digit Master PIN.",
        );
      const result = await this.checkMasterPin(context.account, pin);
      if (result === "busy" || result === "locked")
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
          "The Master PIN is incorrect.",
        );
      if (
        this.options.database.settings.get(householdAccountKey) ===
        context.account.id
      )
        await this.completeHouseholdSetup(context.account.id);
      return reply.code(204).send();
    });
    app.put("/api/v1/account/master-pin", async (request, reply) => {
      const context = this.context(request)!;
      const body = object(request.body);
      if (
        typeof body.currentPin !== "string" ||
        !/^\d{8}$/.test(body.currentPin) ||
        typeof body.newPin !== "string" ||
        !/^\d{8}$/.test(body.newPin) ||
        body.newPin !== body.confirmation
      )
        return error(
          reply,
          400,
          "INVALID_MASTER_PIN",
          "Enter your current PIN and confirm a new 8-digit Master PIN.",
        );
      const job = `change-master:${context.account.id}`;
      if (this.pinJobs.has(job))
        return error(
          reply,
          429,
          "PIN_RATE_LIMITED",
          "Another PIN change is in progress.",
        );
      this.pinJobs.add(job);
      try {
        const checked = await this.checkMasterPin(
          context.account,
          body.currentPin,
        );
        if (checked === "locked" || checked === "busy")
          return error(
            reply,
            429,
            "PIN_RATE_LIMITED",
            "Too many attempts. Try again later.",
          );
        if (checked !== "ok")
          return error(
            reply,
            403,
            "PIN_INCORRECT",
            "The current Master PIN is incorrect.",
          );
        if (
          !context.account.cloudUserId ||
          this.options.database.settings.get(householdAccountKey) ===
            context.account.id
        ) {
          if (
            !(await this.masterPins.changeLocal(
              context.account.id,
              body.currentPin,
              body.newPin,
            ))
          )
            return error(
              reply,
              409,
              "MASTER_PIN_CHANGED",
              "The Master PIN changed. Try again.",
            );
          return { ok: true };
        }
        const current = await this.masterPins.read(context.account.id);
        if (!current?.verifier.changeSalt)
          return error(
            reply,
            409,
            "MASTER_PIN_UPGRADE_REQUIRED",
            "Confirm your current Master PIN once in the account portal to enable changes from this server.",
          );
        const credential = await this.getCredential(context.account.id);
        if (!credential)
          return error(
            reply,
            503,
            "MASTER_PIN_CLOUD_UNAVAILABLE",
            "Connect to your online account to change the Master PIN.",
          );
        const next = await createMasterPinVerifier(body.newPin);
        const secret = await derivePin(
          body.currentPin,
          current.verifier.changeSalt,
          600_000,
          32,
          "sha256",
        );
        const message = JSON.stringify([
          context.account.cloudUserId,
          current.verifier.version,
          next.version,
          next.salt,
          next.hash,
          next.changeSalt,
          next.changeHash,
        ]);
        const proof = createHmac("sha256", secret)
          .update(message)
          .digest("hex");
        secret.fill(0);
        let response: Response;
        try {
          response = await this.cloud(
            "/v1/account/master-pin",
            {
              method: "PUT",
              body: JSON.stringify({
                verifier: next,
                expectedVersion: current.verifier.version,
                proof,
              }),
            },
            credential.token,
          );
        } catch {
          return error(
            reply,
            503,
            "MASTER_PIN_CLOUD_UNAVAILABLE",
            "Connect to your online account to change the Master PIN.",
          );
        }
        if (!response.ok) {
          const result = object(await response.json().catch(() => null));
          const cloudCode =
            typeof result.error === "string" ? result.error : "";
          if (cloudCode === "master_pin_upgrade_required")
            return error(
              reply,
              409,
              "MASTER_PIN_UPGRADE_REQUIRED",
              "Confirm your current Master PIN once in the account portal to enable changes from this server.",
            );
          if (response.status === 429)
            return error(
              reply,
              429,
              "PIN_RATE_LIMITED",
              "Too many attempts. Try again later.",
            );
          if (response.status === 409 || response.status === 403)
            return error(
              reply,
              409,
              "MASTER_PIN_CHANGED",
              "The online Master PIN changed. Try again.",
            );
          return error(
            reply,
            503,
            "MASTER_PIN_CLOUD_UNAVAILABLE",
            "Connect to your online account to change the Master PIN.",
          );
        }
        const publicNext = {
          salt: next.salt,
          hash: next.hash,
          version: next.version,
          changeSalt: next.changeSalt,
        };
        await this.masterPins.cacheVerifier(context.account.id, publicNext);
        await this.masterPins.verify(context.account.id, body.newPin);
        return { ok: true };
      } finally {
        this.pinJobs.delete(job);
      }
    });
    app.post<{ Params: { profileId: string } }>(
      "/api/v1/profiles/:profileId/unlock",
      async (request, reply) => {
        let context = this.context(request)!;
        const id = request.params.profileId;
        const pin = object(request.body).pin;
        if (typeof pin !== "string" || !/^(?:\d{4}|\d{8})$/.test(pin))
          return error(
            reply,
            400,
            "INVALID_PIN",
            "Enter your 8-digit Master PIN or 4-digit profile PIN.",
          );
        const result =
          pin.length === 8
            ? await this.checkMasterPin(context.account, pin)
            : await this.checkPin(id, pin);
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
        if (!context.session && !this.options.localAccess?.actor(request))
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
        const resetKey = `${context.hash}:${id}:${this.options.database.profiles.getPinRecord(id).version}`;
        const ownerReset =
          this.ownerResetAvailable(context.account) &&
          (this.resets.get(resetKey)?.expiresAt ?? 0) > this.now().getTime();
        if (ownerReset) this.resets.delete(resetKey);
        if (
          this.options.database.profiles.getPinRecord(id).hash &&
          !ownerReset
        ) {
          const currentPin = object(request.body).currentPin;
          const result =
            typeof currentPin === "string" && /^\d{8}$/.test(currentPin)
              ? await this.checkMasterPin(context.account, currentPin)
              : await this.checkPin(id, currentPin);
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
        if (!context.session && !this.options.localAccess?.actor(request))
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
