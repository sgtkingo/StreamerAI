import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { networkInterfaces } from "node:os";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StreamerDatabase } from "@streamer-ai/database";
import { toDataURL } from "qrcode";
import { householdHasData, householdReadyKey } from "./household-state.js";

/** A first-run browser can only create or restore a household until its PIN is verified. */
const householdSetupRoutes = new Set([
  "POST /api/v1/auth/local",
  "GET /api/v1/account",
  "GET /api/v1/profiles",
  "POST /api/v1/account/master-pin",
  "GET /api/v1/account/cloud/households",
  "POST /api/v1/account/cloud/households/select",
  "GET /api/v1/account/encrypted-household",
  "POST /api/v1/account/encrypted-household/preview",
  "POST /api/v1/account/encrypted-household/restore",
  "GET /api/v1/account/encrypted-household/cloud",
]);

const COOKIE = "streamer_installation";
const PAIR_COOKIE = "streamer_local_pair";
const STATE = "server.localAccess";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const readCookie = (request: FastifyRequest, name: string) =>
  (request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
export interface InstallationDevice {
  id: string;
  serverId: string;
  name: string;
  role: "owner" | "viewer";
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  tokenHash: string;
  revoked: boolean;
  setupPending?: boolean;
}
interface AccessState {
  claimed: boolean;
  devices: InstallationDevice[];
}
interface Pairing {
  id: string;
  code: string;
  binding: string;
  name: string;
  expiresAt: number;
  failedCodeAttempts: number;
  nextPollAt: number;
  state: "pending" | "approved" | "denied";
  accountId?: string;
}
export interface LocalAccessOptions {
  enabled: boolean;
  dataDirectory: string;
  origin: string;
  now?: () => Date;
  onRevoke?: () => void;
  verifyMasterPin?(pin: string): Promise<boolean>;
  householdStatus?(): Promise<{
    householdReady: boolean;
    householdName: string;
    masterPinEnabled: boolean;
    cloudConfigured: boolean;
  }>;
  advertiseUrl?: string;
}

/** Installation authorization is independent of optional cloud identity. */
export class LocalAccessService {
  readonly enabled: boolean;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pairing>();
  private readonly budgets = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(
    private readonly database: StreamerDatabase,
    private readonly options: LocalAccessOptions,
  ) {
    this.enabled = options.enabled;
    this.now = () => (options.now?.() ?? new Date()).getTime();
    if (!database.settings.get<string>("server.instanceId"))
      database.settings.set("server.instanceId", randomUUID());
    const retiredKey = resolve(
      options.dataDirectory,
      "installation-bootstrap.key",
    );
    if (existsSync(retiredKey)) unlinkSync(retiredKey);
  }

  private state(): AccessState {
    return (
      this.database.settings.get<AccessState>(STATE) ?? {
        claimed: false,
        devices: [],
      }
    );
  }
  private save(state: AccessState) {
    this.database.settings.set(STATE, state);
  }
  householdAccountId(): string {
    const selected = this.database.settings.get<string>("household.accountId");
    return this.database.accounts.getRequired(
      selected ?? this.database.accounts.getLocal().id,
    ).id;
  }
  /** Cloud management changes do not replace the household or its paired clients. */
  bindHousehold(accountId: string): void {
    this.database.accounts.getRequired(accountId);
    this.database.settings.set("household.accountId", accountId);
    const state = this.state();
    for (const device of state.devices) device.accountId = accountId;
    this.save(state);
  }
  actor(request: FastifyRequest): InstallationDevice | null {
    if (!this.enabled) return null;
    const token = readCookie(request, COOKIE);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const state = this.state();
    const device = state.devices.find(
      (entry) => entry.tokenHash === hash(token),
    );
    const serverId = this.database.settings.get<string>("server.instanceId");
    if (
      !device ||
      !serverId ||
      (device.serverId !== undefined && device.serverId !== serverId) ||
      device.revoked ||
      device.expiresAt <= this.now() ||
      device.lastSeenAt + 30 * 86_400_000 <= this.now()
    )
      return null;
    const accountId = this.householdAccountId();
    if (
      !device.serverId ||
      device.accountId !== accountId ||
      device.lastSeenAt + 5 * 60_000 < this.now()
    ) {
      device.serverId = serverId;
      device.accountId = accountId;
      device.lastSeenAt = this.now();
      this.save(state);
    }
    return device;
  }
  isOwner(request: FastifyRequest): boolean {
    const actor = this.actor(request);
    return actor?.role === "owner" && !actor.setupPending;
  }
  isSetupSession(request: FastifyRequest): boolean {
    return (
      this.actor(request)?.setupPending === true &&
      this.database.settings.get(
        householdReadyKey(this.householdAccountId()),
      ) !== true
    );
  }
  private async setupAvailable(): Promise<boolean> {
    const status = await this.options.householdStatus?.();
    return (
      !!status &&
      !status.masterPinEnabled &&
      !status.householdReady &&
      !householdHasData(this.database, this.householdAccountId())
    );
  }
  async finishSetup(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const actor = this.actor(request);
    if (!actor?.setupPending) return;
    const status = await this.options.householdStatus?.();
    if (!status?.masterPinEnabled || !status.householdReady)
      throw new Error(
        "The household Master PIN must be verified before authorizing administration.",
      );
    const state = this.state();
    const current = state.devices.find((device) => device.id === actor.id)!;
    delete current.setupPending;
    current.expiresAt = this.now() + 90 * 86_400_000;
    state.claimed = true;
    state.devices = state.devices.filter((device) => !device.setupPending);
    this.save(state);
    this.cookie(reply, COOKIE, readCookie(request, COOKIE), 90 * 86_400);
  }
  authorizeClient(
    request: FastifyRequest,
    reply: FastifyReply,
    role: "owner" | "viewer",
    name: string,
  ) {
    const result = this.issue(
      request,
      reply,
      role,
      name,
      this.householdAccountId(),
    );
    return {
      ...result,
      ok: true,
      role,
      serverId: this.database.settings.get<string>("server.instanceId"),
      householdId: this.database.settings.get<string>(
        `household.id.${this.householdAccountId()}`,
      ),
      clientId: result.id,
    };
  }
  private budget(key: string, maximum: number): boolean {
    for (const [id, entry] of this.budgets)
      if (entry.until <= this.now()) this.budgets.delete(id);
    if (!this.budgets.has(key) && this.budgets.size >= 1000) return false;
    const entry = this.budgets.get(key) ?? {
      count: 0,
      until: this.now() + 300_000,
    };
    this.budgets.set(key, entry);
    return ++entry.count <= maximum;
  }
  private cookie(
    reply: FastifyReply,
    name: string,
    value: string,
    age: number,
  ) {
    reply.header(
      "set-cookie",
      `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${this.options.origin.startsWith("https:") ? "; Secure" : ""}`,
    );
  }
  private issue(
    request: FastifyRequest,
    reply: FastifyReply,
    role: "owner" | "viewer",
    name: string,
    accountId: string,
    setupPending = false,
  ) {
    const token = randomBytes(32).toString("hex");
    const now = this.now();
    const device: InstallationDevice = {
      id: randomUUID(),
      serverId: this.database.settings.get<string>("server.instanceId")!,
      tokenHash: hash(token),
      role,
      name,
      accountId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + (setupPending ? 30 * 60_000 : 90 * 86_400_000),
      ...(setupPending ? { setupPending: true } : {}),
      revoked: false,
    };
    const state = this.state();
    state.devices = state.devices.filter(
      (entry) => !entry.revoked && entry.expiresAt > now,
    );
    if (state.devices.length >= 100)
      throw new Error("Installation device limit reached.");
    if (!setupPending) state.claimed = true;
    state.devices.push(device);
    this.save(state);
    this.cookie(reply, COOKIE, token, setupPending ? 30 * 60 : 90 * 86_400);
    void request;
    return { id: device.id, role };
  }
  register(app: FastifyInstance) {
    app.get("/api/v1/installation/discovery", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const status = await this.options.householdStatus?.();
      const origin = new URL(this.options.origin);
      const host = request.headers.host;
      return {
        protocol: "streamerai-discovery",
        version: 1,
        serverId: this.database.settings.get<string>("server.instanceId"),
        householdId:
          this.database.settings.get<string>(
            `household.id.${this.householdAccountId()}`,
          ) ?? null,
        name: status?.householdName ?? "StreamerAI home server",
        url: `${origin.protocol}//${host ?? origin.host}`,
      };
    });
    app.post("/api/v1/installation/authorize", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (
        !this.budget(`authorize:${request.ip}`, 5) ||
        !this.budget("authorize:global", 30)
      )
        return reply.code(429).send({
          error: {
            code: "PIN_RATE_LIMITED",
            message: "Too many attempts. Try again later.",
          },
        });
      const body = record(request.body);
      if (
        typeof body.masterPin !== "string" ||
        !/^\d{8}$/.test(body.masterPin) ||
        !(await this.options.verifyMasterPin?.(body.masterPin))
      )
        return reply.code(403).send({
          error: {
            code: "PIN_INCORRECT",
            message: "The Master PIN is incorrect.",
          },
        });
      const name =
        typeof body.deviceName === "string"
          ? body.deviceName.trim().slice(0, 80)
          : "StreamerAI client";
      return this.authorizeClient(
        request,
        reply,
        body.admin === true ? "owner" : "viewer",
        name || "StreamerAI client",
      );
    });
    if (!this.enabled) {
      app.get("/api/v1/installation/status", async () => ({
        enabled: false,
        claimed: false,
        paired: false,
        role: null,
        clientId: null,
        householdId: null,
        ...(await this.options.householdStatus?.()),
        cloudRecoveryAuthorized: false,
      }));
      return;
    }
    const origin = new URL(this.options.origin);
    if (
      origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
    )
      throw new Error("Paired LAN access requires an HTTPS web origin.");
    const fail = (reply: FastifyReply, status: number, code: string) =>
      reply.code(status).send({
        error: {
          code,
          message:
            code === "INSTALLATION_OWNER_REQUIRED"
              ? "Only the server owner can perform this action."
              : "Open the server connection screen and request access.",
        },
      });
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?", 1)[0]!;
      if (!path.startsWith("/api/")) return;
      let requestedHost: string;
      try {
        requestedHost = new URL(
          `${origin.protocol}//${request.headers.host ?? ""}`,
        ).host;
      } catch {
        return fail(reply, 403, "HOST_REJECTED");
      }
      const loopbackHealthHost =
        request.headers.host === "127.0.0.1:4400" &&
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.ip);
      const allowedHosts = new Set([origin.host]);
      for (const addresses of Object.values(networkInterfaces()))
        for (const address of addresses ?? []) {
          if (address.family === "IPv4" && !address.internal)
            allowedHosts.add(
              `${address.address}${origin.port ? `:${origin.port}` : ""}`,
            );
        }
      if (this.options.advertiseUrl)
        allowedHosts.add(new URL(this.options.advertiseUrl).host);
      if (!allowedHosts.has(requestedHost) && !loopbackHealthHost)
        return fail(reply, 403, "HOST_REJECTED");
      if (
        request.headers.origin &&
        request.headers.origin !== `${origin.protocol}//${requestedHost}`
      )
        return fail(reply, 403, "ORIGIN_REJECTED");
      if (
        !request.headers.origin &&
        request.headers["sec-fetch-site"] === "cross-site"
      )
        return fail(reply, 403, "ORIGIN_REJECTED");
      const publicPaths = new Set([
        "/api/v1/auth/status",
        "/api/v1/installation/status",
        "/api/v1/installation/discovery",
        "/api/v1/installation/authorize",
        "/api/v1/account/cloud/device",
        "/api/v1/account/cloud/device/poll",
        "/api/v1/installation/setup",
        "/api/v1/installation/pair",
        "/api/v1/installation/poll",
        "/api/v1/health/live",
        "/api/v1/health/ready",
      ]);
      const actor = this.actor(request);
      const setupRoute =
        this.isSetupSession(request) &&
        householdSetupRoutes.has(`${request.method} ${path}`);
      if (
        !publicPaths.has(path) &&
        !setupRoute &&
        (!actor || actor.setupPending)
      )
        return fail(reply, 401, "INSTALLATION_ACCESS_REQUIRED");
      if (
        (path.startsWith("/api/v1/installation/") && !publicPaths.has(path)) ||
        path.startsWith("/api/v1/server/")
      ) {
        if (!this.isOwner(request))
          return fail(reply, 403, "INSTALLATION_OWNER_REQUIRED");
      }
    });
    app.get("/api/v1/installation/status", async (request, reply) => {
      reply.header("cache-control", "no-store");
      const actor = this.actor(request);
      return {
        enabled: true,
        claimed: this.state().claimed,
        paired: actor !== null && !actor.setupPending,
        role: actor && !actor.setupPending ? actor.role : null,
        setupAuthorized: this.isSetupSession(request),
        setupAvailable: await this.setupAvailable(),
        clientId: actor?.id ?? null,
        householdId: actor
          ? this.database.settings.get<string>(
              `household.id.${actor.accountId}`,
            )
          : null,
        ...(await this.options.householdStatus?.()),
        cloudRecoveryAuthorized:
          !!actor &&
          (this.database.settings.get<number>(
            `household.cloudRecovery.${actor.id}`,
          ) ?? 0) > this.now(),
        serverId: this.database.settings.get<string>("server.instanceId"),
      };
    });
    app.post("/api/v1/installation/setup", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (this.isSetupSession(request)) return { setupAuthorized: true };
      if (!this.budget(`setup:${request.ip}`, 10))
        return fail(reply, 429, "RATE_LIMITED");
      if (!(await this.setupAvailable()))
        return fail(reply, 409, "HOUSEHOLD_ALREADY_CONFIGURED");
      if (
        this.state().devices.some(
          (device) =>
            device.setupPending &&
            !device.revoked &&
            device.expiresAt > this.now(),
        )
      )
        return fail(reply, 409, "HOUSEHOLD_SETUP_IN_PROGRESS");
      this.issue(
        request,
        reply,
        "owner",
        "Household setup",
        this.householdAccountId(),
        true,
      );
      return { setupAuthorized: true };
    });
    app.post("/api/v1/installation/pair", async (request, reply) => {
      for (const [id, item] of this.pending)
        if (item.expiresAt <= this.now()) this.pending.delete(id);
      if (!this.state().claimed)
        return fail(reply, 409, "OWNER_SETUP_REQUIRED");
      if (
        this.pending.size >= 50 ||
        !this.budget(`pair:${request.ip}`, 5) ||
        !this.budget("pair:global", 50)
      )
        return fail(reply, 429, "RATE_LIMITED");
      const name = record(request.body).name;
      if (
        typeof name !== "string" ||
        name.trim().length < 1 ||
        name.length > 80
      )
        return fail(reply, 400, "INVALID_DEVICE_NAME");
      const binding = randomBytes(32).toString("hex");
      const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
      const item: Pairing = {
        id: randomUUID(),
        code,
        binding: hash(binding),
        name: name.trim(),
        expiresAt: this.now() + 300_000,
        state: "pending",
        failedCodeAttempts: 0,
        nextPollAt: 0,
      };
      this.pending.set(item.id, item);
      this.cookie(reply, PAIR_COOKIE, binding, 300);
      const base = new URL(this.options.origin);
      if (request.headers.host) base.host = request.headers.host;
      const verificationUriComplete = new URL(`/admin/pair?code=${code}`, base)
        .href;
      return {
        requestId: item.id,
        code,
        expiresAt: new Date(item.expiresAt).toISOString(),
        interval: 3,
        verificationUriComplete,
        qrCodeDataUrl: await toDataURL(verificationUriComplete, {
          width: 240,
          margin: 2,
        }),
      };
    });
    app.post("/api/v1/installation/poll", async (request, reply) => {
      const id = record(request.body).requestId;
      const item = typeof id === "string" ? this.pending.get(id) : null;
      if (!item || item.binding !== hash(readCookie(request, PAIR_COOKIE)))
        return fail(reply, 403, "PAIRING_REJECTED");
      if (item.expiresAt <= this.now()) {
        this.pending.delete(item.id);
        return { status: "expired" };
      }
      if (this.now() < item.nextPollAt) {
        reply.header(
          "retry-after",
          Math.max(1, Math.ceil((item.nextPollAt - this.now()) / 1000)),
        );
        return fail(reply, 429, "POLL_TOO_FAST");
      }
      if (!this.budget(`poll:${item.id}`, 110))
        return fail(reply, 429, "RATE_LIMITED");
      item.nextPollAt = this.now() + 3000;
      if (item.state !== "approved") return { status: item.state };
      this.pending.delete(item.id);
      this.issue(
        request,
        reply,
        "viewer",
        item.name,
        this.householdAccountId(),
      );
      return { status: "approved" };
    });
    app.get("/api/v1/installation/devices", async (request, reply) => {
      reply.header("cache-control", "no-store");
      return {
        devices: this.state()
          .devices.filter(
            (entry) => !entry.revoked && entry.expiresAt > this.now(),
          )
          .map(({ id, name, role, lastSeenAt }) => ({
            id,
            name,
            role,
            lastSeenAt,
            current: id === this.actor(request)?.id,
          })),
        pending: [...this.pending.values()]
          .filter(
            (item) => item.state === "pending" && item.expiresAt > this.now(),
          )
          .map(({ id, name, code, expiresAt }) => ({
            id,
            name,
            code,
            expiresAt,
          })),
      };
    });
    app.post("/api/v1/installation/decision", async (request, reply) => {
      const body = record(request.body);
      const item =
        typeof body.requestId === "string"
          ? this.pending.get(body.requestId)
          : null;
      if (!this.budget("decision:global", 30))
        return fail(reply, 429, "RATE_LIMITED");
      if (!item || item.expiresAt <= this.now() || item.state !== "pending")
        return fail(reply, 404, "PAIRING_NOT_FOUND");
      if (typeof body.approve !== "boolean")
        return fail(reply, 400, "INVALID_PAIRING_DECISION");
      if (body.approve && body.code !== item.code) {
        item.failedCodeAttempts++;
        if (item.failedCodeAttempts >= 5) item.state = "denied";
        return fail(reply, 403, "CODE_MISMATCH");
      }
      item.state = body.approve === false ? "denied" : "approved";
      item.accountId = this.householdAccountId();
      return { status: item.state };
    });
    app.post("/api/v1/installation/revoke", async (request, reply) => {
      const id = record(request.body).deviceId;
      const state = this.state();
      const device = state.devices.find(
        (item) => item.id === id && !item.revoked,
      );
      if (!device) return fail(reply, 404, "DEVICE_NOT_FOUND");
      if (
        device.role === "owner" &&
        state.devices.filter(
          (item) =>
            item.role === "owner" &&
            !item.revoked &&
            item.expiresAt > this.now(),
        ).length <= 1
      )
        return fail(reply, 409, "LAST_OWNER_REQUIRED");
      device.revoked = true;
      this.save(state);
      this.options.onRevoke?.();
      return { revoked: true };
    });
  }
}
