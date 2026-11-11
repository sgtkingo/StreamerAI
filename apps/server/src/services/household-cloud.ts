import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StreamerDatabase } from "@streamer-ai/database";
import { toDataURL } from "qrcode";
import type { SecretStore } from "../stores/secret-store.js";
import { MasterPinService, createMasterPinVerifier } from "./master-pin.js";
import type { AccountAuthService } from "./account-auth.js";
import type { LocalAccessService } from "./local-access.js";
import {
  householdAccountKey,
  householdCloudCredentialKey,
  householdHasData,
  householdId,
  householdIdKey,
  householdPendingKey,
  householdReadyKey,
} from "./household-state.js";

type Household = {
  id: string;
  name: string;
  hasBackup?: boolean;
  hasProfiles?: boolean;
  revision?: number;
  accountId?: string;
};
type Credential = { token: string; deviceId: string; cloudUserId: string };
type Grant = {
  binding: string;
  code: string;
  expiresAt: number;
  nextPollAt: number;
  interval: number;
  accountId: string;
  adminLogin: boolean;
  failure?: { status: number; code: string };
};
const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const cookieName = "streamer_household_cloud";
const cookie = (request: FastifyRequest) =>
  (request.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1) ?? "";
const failure = (reply: FastifyReply, status: number, code: string) =>
  reply.code(status).send({ error: { code, message: code } });

export interface HouseholdCloudOptions {
  database: StreamerDatabase;
  secrets: SecretStore;
  auth: AccountAuthService;
  localAccess: LocalAccessService;
  serviceUrl: string | null;
  webOrigin: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Cloud proves ownership; the home server remains the authority for clients, PINs and household data. */
export class HouseholdCloudService {
  private readonly grants = new Map<string, Grant>();
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  constructor(private readonly options: HouseholdCloudOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }
  private get db() {
    return this.options.database;
  }
  private owner(request: FastifyRequest) {
    return (
      !this.options.localAccess.enabled ||
      this.options.localAccess.isOwner(request) ||
      this.options.localAccess.isSetupSession(request)
    );
  }
  private async request(
    path: string,
    token: string,
    method = "GET",
    body?: unknown,
  ) {
    if (!this.options.serviceUrl) throw new Error("Cloud is unavailable.");
    return this.fetcher(new URL(path, this.options.serviceUrl), {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  }
  private async households(token: string): Promise<Household[]> {
    const response = await this.request("/v1/households", token);
    if (!response.ok) throw new Error("Cloud households are unavailable.");
    const data = record(await response.json());
    if (!Array.isArray(data.households))
      throw new Error("Invalid cloud response.");
    return data.households.filter(
      (x): x is Household =>
        !!x &&
        typeof x === "object" &&
        typeof (x as Household).id === "string" &&
        typeof (x as Household).name === "string",
    );
  }
  private async bindRemote(
    accountId: string,
    credential: Credential,
    id: string,
    name: string,
  ) {
    const response = await this.request(
      "/v1/households",
      credential.token,
      "POST",
      {
        householdId: id,
        name,
        serverId: this.db.settings.get("server.instanceId"),
        profileIds: this.db.profiles
          .list(accountId)
          .map((profile) => profile.syncId),
      },
    );
    if (!response.ok) throw new Error("HOUSEHOLD_CLOUD_CONFLICT");
    return record(await response.json());
  }
  private attachIdentity(
    accountId: string,
    credential: Credential,
    identity: Record<string, unknown>,
  ) {
    const current = this.db.accounts.getRequired(accountId);
    if (current.cloudUserId && current.cloudUserId !== credential.cloudUserId)
      throw new Error("HOUSEHOLD_CLOUD_CONFLICT");
    this.db.accounts.linkCloudUser(accountId, {
      cloudUserId: credential.cloudUserId,
      email: typeof identity.email === "string" ? identity.email : null,
    });
    this.db.settings.set(householdAccountKey, accountId);
    this.options.localAccess.bindHousehold(accountId);
  }
  private async select(accountId: string, chosen?: Household) {
    const raw = await this.options.secrets.get(
      householdCloudCredentialKey(accountId),
    );
    if (!raw) throw new Error("HOUSEHOLD_CLOUD_UNAVAILABLE");
    const credential = JSON.parse(raw) as Credential;
    const current = this.db.accounts.getRequired(accountId);
    if (chosen) {
      if (
        householdHasData(this.db, accountId) ||
        (await new MasterPinService(this.options.secrets).read(accountId))
      )
        throw new Error("HOUSEHOLD_CLOUD_CONFLICT");
      if (!chosen.hasBackup && chosen.hasProfiles)
        throw new Error("HOUSEHOLD_BACKUP_REQUIRED");
      await this.bindRemote(accountId, credential, chosen.id, chosen.name);
      this.db.settings.set(householdIdKey(accountId), chosen.id);
      this.db.accounts.upsert({ id: accountId, name: chosen.name });
      this.db.settings.set(householdPendingKey(accountId), {
        kind: chosen.hasBackup ? "restore" : "create",
        householdId: chosen.id,
        revision: chosen.revision ?? 0,
      });
      this.db.settings.set(householdReadyKey(accountId), false);
    } else {
      await this.bindRemote(
        accountId,
        credential,
        householdId(this.db, accountId),
        current.name || "StreamerAI household",
      );
      this.db.settings.set(householdPendingKey(accountId), { kind: "create" });
    }
    this.db.settings.delete(`household.cloudSelection.${accountId}`);
    this.db.settings.set("household.setupStarted", true);
  }

  register(app: FastifyInstance) {
    const base = "/api/v1/account/cloud";
    app.post(base + "/device", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!this.options.serviceUrl)
        return failure(reply, 503, "CLOUD_NOT_CONFIGURED");
      const body = record(request.body);
      const adminLogin = body.adminLogin === true;
      const household = this.db.accounts.getHousehold();
      if (
        adminLogin &&
        this.db.settings.get(householdReadyKey(household.id)) !== true &&
        !(await this.options.auth.installationHouseholdStatus())
          .masterPinEnabled
      )
        return failure(reply, 409, "HOUSEHOLD_SETUP_REQUIRED");
      if (adminLogin ? !household.cloudUserId : !this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      if (this.grants.size >= 40)
        for (const [id, grant] of this.grants)
          if (grant.expiresAt <= this.now().getTime()) this.grants.delete(id);
      if (this.grants.size >= 40) return failure(reply, 429, "RATE_LIMITED");
      try {
        const ready =
          this.db.settings.get(householdReadyKey(household.id)) === true;
        const response = await this.request("/v1/device/code", "", "POST", {
          client_id: "streamer-ai-home",
          device_name: "StreamerAI household server",
          purpose: "login",
          ...(ready || adminLogin
            ? { household_id: householdId(this.db, household.id) }
            : {}),
          server_id: this.db.settings.get("server.instanceId"),
          household_name: household.name,
        });
        if (!response.ok)
          return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
        const data = record(await response.json());
        if (
          typeof data.device_code !== "string" ||
          typeof data.user_code !== "string" ||
          typeof data.verification_uri !== "string" ||
          typeof data.verification_uri_complete !== "string"
        )
          throw new Error("Invalid grant");
        const cloudOrigin = new URL(this.options.serviceUrl).origin;
        if (
          new URL(data.verification_uri).origin !== cloudOrigin ||
          new URL(data.verification_uri_complete).origin !== cloudOrigin
        )
          throw new Error("Invalid grant origin");
        const binding = randomBytes(32).toString("hex"),
          interval = Math.max(3, Math.min(30, Number(data.interval) || 3));
        const expiresAt =
          this.now().getTime() +
          Math.min(600, Number(data.expires_in) || 300) * 1000;
        this.grants.set(data.device_code, {
          binding: hash(binding),
          code: data.device_code,
          interval,
          nextPollAt: 0,
          expiresAt,
          accountId: household.id,
          adminLogin,
        });
        reply.header(
          "set-cookie",
          `${cookieName}=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${this.options.webOrigin.startsWith("https:") ? "; Secure" : ""}`,
        );
        return {
          deviceCode: data.device_code,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          verificationUriComplete: data.verification_uri_complete,
          expiresAt: new Date(expiresAt).toISOString(),
          interval,
          qrCodeDataUrl: await toDataURL(data.verification_uri_complete, {
            width: 240,
            margin: 2,
          }),
        };
      } catch {
        return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
      }
    });
    app.post(base + "/device/poll", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const code = record(request.body).deviceCode;
      const grant =
        typeof code === "string" ? this.grants.get(code) : undefined;
      if (!grant || !cookie(request) || hash(cookie(request)) !== grant.binding)
        return failure(reply, 403, "PAIRING_NOT_FOUND");
      if (grant.expiresAt < this.now().getTime()) {
        this.grants.delete(grant.code);
        return { status: "expired" };
      }
      if (grant.failure)
        return failure(reply, grant.failure.status, grant.failure.code);
      const stop = (status: number, code: string) => {
        grant.failure = { status, code };
        return failure(reply, status, code);
      };
      if (!grant.adminLogin && !this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      if (grant.nextPollAt > this.now().getTime()) return { status: "pending" };
      grant.nextPollAt = this.now().getTime() + grant.interval * 1000;
      let stage = "redeem-token";
      try {
        const response = await this.request("/v1/device/token", "", "POST", {
          client_id: "streamer-ai-home",
          device_code: grant.code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        const data = record(await response.json());
        if (!response.ok) {
          if (
            data.error === "authorization_pending" ||
            data.error === "slow_down"
          )
            return { status: "pending" };
          if (
            data.error === "expired_token" ||
            data.error === "access_denied"
          ) {
            this.grants.delete(grant.code);
            return {
              status: data.error === "access_denied" ? "denied" : "expired",
            };
          }
          throw new Error("Cloud authorization failed");
        }
        const identity = record(data.account),
          device = record(data.device);
        if (
          typeof identity.id !== "string" ||
          typeof data.access_token !== "string" ||
          typeof device.id !== "string"
        )
          throw new Error("Invalid token");
        const credential: Credential = {
          token: data.access_token,
          deviceId: device.id,
          cloudUserId: identity.id,
        };
        stage = "list-households";
        const owned = await this.households(credential.token);
        const local = this.db.accounts.getRequired(grant.accountId);
        const id = householdId(this.db, local.id);
        if (grant.adminLogin) {
          if (
            local.cloudUserId !== identity.id ||
            !owned.some((x) => x.id === id)
          ) {
            return stop(403, "HOUSEHOLD_CLOUD_CONFLICT");
          }
          const authorized = this.options.localAccess.authorizeClient(
            request,
            reply,
            "owner",
            "Cloud verified household owner",
          );
          this.db.settings.set(
            `household.cloudRecovery.${authorized.clientId}`,
            this.now().getTime() + 300_000,
          );
          await this.request(
            `/v1/devices/${encodeURIComponent(credential.deviceId)}`,
            credential.token,
            "DELETE",
          ).catch(() => undefined);
          this.grants.delete(grant.code);
          return {
            status: "approved",
            account: {
              id: local.id,
              name: local.name,
              email: local.email,
              cloudLinked: true,
            },
            cloudRecoveryAuthorized: true,
          };
        }
        if (local.cloudUserId && local.cloudUserId !== identity.id)
          return stop(409, "HOUSEHOLD_CLOUD_CONFLICT");
        const master = await new MasterPinService(this.options.secrets).read(
          local.id,
        );
        if (master || householdHasData(this.db, local.id)) {
          stage = "register-household";
          await this.bindRemote(local.id, credential, id, local.name);
          this.attachIdentity(local.id, credential, identity);
          await this.options.secrets.set(
            householdCloudCredentialKey(local.id),
            JSON.stringify(credential),
          );
          if (master?.pin)
            await this.options.auth.completeHouseholdSetup(local.id);
          else {
            // Cloud proves identity, but cannot supply the PIN needed for local backup encryption.
            this.db.settings.set(householdPendingKey(local.id), {
              kind: master ? "register" : "create",
            });
            this.db.settings.set(householdReadyKey(local.id), false);
            this.db.settings.set("household.setupStarted", true);
            const actor = this.options.localAccess.actor(request);
            if (master && actor && this.options.localAccess.isOwner(request))
              this.db.settings.set(
                `household.cloudRecovery.${actor.id}`,
                this.now().getTime() + 300_000,
              );
          }
        } else {
          this.attachIdentity(local.id, credential, identity);
          await this.options.secrets.set(
            householdCloudCredentialKey(local.id),
            JSON.stringify(credential),
          );
          if (owned.length === 0) await this.select(local.id);
          else if (owned.length === 1) await this.select(local.id, owned[0]);
          else
            this.db.settings.set(`household.cloudSelection.${local.id}`, true);
        }
        this.grants.delete(grant.code);
        return {
          status: "approved",
          householdSelectionRequired:
            owned.length > 1 && !master && !householdHasData(this.db, local.id),
          account: {
            id: local.id,
            name: local.name,
            email: typeof identity.email === "string" ? identity.email : null,
            cloudLinked: true,
          },
        };
      } catch (error) {
        const code =
          error instanceof Error &&
          ["HOUSEHOLD_CLOUD_CONFLICT", "HOUSEHOLD_BACKUP_REQUIRED"].includes(
            error.message,
          )
            ? error.message
            : "HOUSEHOLD_CLOUD_UNAVAILABLE";
        request.log.warn(
          { code: "HOUSEHOLD_CLOUD_LOGIN_FAILED", stage },
          "Cloud sign-in did not finish",
        );
        return stop(code === "HOUSEHOLD_CLOUD_UNAVAILABLE" ? 503 : 409, code);
      }
    });
    app.get(base + "/households", async (request, reply) => {
      if (!this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      const account = this.db.accounts.getHousehold();
      const credential = await this.options.auth.getCredential(account.id);
      if (!credential)
        return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
      try {
        return {
          households: await this.households(credential.token),
          canCreate: !householdHasData(this.db, account.id),
        };
      } catch {
        return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
      }
    });
    app.post(base + "/households/select", async (request, reply) => {
      if (!this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      const account = this.db.accounts.getHousehold(),
        body = record(request.body);
      const credential = await this.options.auth.getCredential(account.id);
      if (
        !credential ||
        this.db.settings.get(`household.cloudSelection.${account.id}`) !== true
      )
        return failure(reply, 409, "HOUSEHOLD_CLOUD_CONFLICT");
      try {
        const chosen =
          body.create === true
            ? undefined
            : (await this.households(credential.token)).find(
                (x) => x.id === body.householdId,
              );
        if (body.create !== true && !chosen)
          return failure(reply, 404, "HOUSEHOLD_NOT_FOUND");
        await this.select(account.id, chosen);
        return { ok: true };
      } catch {
        return failure(reply, 409, "HOUSEHOLD_CLOUD_CONFLICT");
      }
    });
    app.post(base + "/disconnect", async (request, reply) => {
      if (!this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      const account = this.db.accounts.getHousehold();
      const credential = await this.options.auth.getCredential(account.id);
      if (credential)
        await this.request(
          `/v1/devices/${encodeURIComponent(credential.deviceId)}`,
          credential.token,
          "DELETE",
        ).catch(() => undefined);
      await this.options.secrets.delete(
        householdCloudCredentialKey(account.id),
      );
      for (const session of this.db.auth.listDeviceHistory(account.id))
        await this.options.secrets.delete(
          `account.cloud-token.${account.id}.${session.deviceId}`,
        );
      if (account.cloudUserId)
        this.db.accounts.detachCloudUser(account.id, account.cloudUserId);
      this.db.settings.delete(householdPendingKey(account.id));
      this.db.settings.delete(`household.cloudSelection.${account.id}`);
      return { ok: true };
    });
    app.put("/api/v1/admin/household", async (request, reply) => {
      if (!this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      const name = record(request.body).name;
      if (
        typeof name !== "string" ||
        name.trim().length < 1 ||
        name.trim().length > 120
      )
        return failure(reply, 400, "INVALID_HOUSEHOLD_NAME");
      const account = this.db.accounts.getHousehold(),
        id = householdId(this.db, account.id);
      const credential = await this.options.auth.getCredential(account.id);
      if (account.cloudUserId && !credential)
        return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
      if (credential) {
        const response = await this.request(
          `/v1/households/${encodeURIComponent(id)}`,
          credential.token,
          "PUT",
          { name: name.trim() },
        ).catch(() => null);
        if (!response?.ok)
          return failure(reply, 503, "HOUSEHOLD_CLOUD_UNAVAILABLE");
      }
      this.db.accounts.upsert({ id: account.id, name: name.trim() });
      return { householdId: id, name: name.trim() };
    });
    app.post<{ Params: { profileId: string } }>(
      "/api/v1/admin/profiles/:profileId/pin-reset",
      async (request, reply) => {
        if (!this.owner(request))
          return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
        const profile = this.db.profiles.get(request.params.profileId);
        if (
          !profile ||
          profile.accountId !== this.db.accounts.getHousehold().id
        )
          return failure(reply, 404, "PROFILE_NOT_FOUND");
        if (record(request.body).confirm !== "reset-profile-pin")
          return failure(reply, 400, "CONFIRMATION_REQUIRED");
        this.db.profiles.setPinHash(profile.id, null);
        return { ok: true };
      },
    );
    app.get("/api/v1/admin/pin-resets", async (request, reply) => {
      if (!this.owner(request))
        return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      return { requests: this.options.auth.listLocalPinResets() };
    });
    app.post<{ Params: { requestId: string } }>(
      "/api/v1/admin/pin-resets/:requestId/decision",
      async (request, reply) => {
        if (!this.owner(request))
          return failure(reply, 403, "INSTALLATION_OWNER_REQUIRED");
        const approve = record(request.body).approve;
        if (typeof approve !== "boolean")
          return failure(reply, 400, "INVALID_REQUEST");
        if (
          !this.options.auth.decideLocalPinReset(
            request.params.requestId,
            approve,
          )
        )
          return failure(reply, 404, "REQUEST_NOT_FOUND");
        return { ok: true };
      },
    );
    app.post("/api/v1/admin/master-pin/reset", async (request, reply) => {
      const actor = this.options.localAccess.actor(request);
      const expiry = actor
        ? this.db.settings.get<number>(`household.cloudRecovery.${actor.id}`)
        : null;
      if (
        !actor ||
        actor.role !== "owner" ||
        !expiry ||
        expiry < this.now().getTime()
      )
        return failure(reply, 403, "ACCOUNT_REAUTH_REQUIRED");
      const body = record(request.body);
      if (
        typeof body.newPin !== "string" ||
        !/^\d{8}$/.test(body.newPin) ||
        body.newPin !== body.confirmation
      )
        return failure(reply, 400, "INVALID_MASTER_PIN");
      const verifier = await createMasterPinVerifier(body.newPin);
      const master = new MasterPinService(this.options.secrets);
      await master.cacheVerifier(actor.accountId, {
        salt: verifier.salt,
        hash: verifier.hash,
        version: verifier.version,
      });
      await master.verify(actor.accountId, body.newPin);
      await this.options.auth.completeHouseholdSetup(actor.accountId);
      this.db.settings.delete(`household.cloudRecovery.${actor.id}`);
      return { ok: true };
    });
  }
}
