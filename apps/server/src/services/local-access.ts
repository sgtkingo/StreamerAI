import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StreamerDatabase } from "@streamer-ai/database";

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
  name: string;
  role: "owner" | "viewer";
  accountId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  tokenHash: string;
  revoked: boolean;
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
  bootstrapToken?: string;
  now?: () => Date;
  onRevoke?: () => void;
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
  private readonly bootstrapFile: string;
  private bootstrapHash: string | null = null;
  constructor(
    private readonly database: StreamerDatabase,
    private readonly options: LocalAccessOptions,
  ) {
    this.enabled = options.enabled;
    this.now = () => (options.now?.() ?? new Date()).getTime();
    this.bootstrapFile = resolve(
      options.dataDirectory,
      "installation-bootstrap.key",
    );
    if (!this.enabled) return;
    if (!database.settings.get<string>("server.instanceId"))
      database.settings.set("server.instanceId", randomUUID());
    if (!this.state().claimed) {
      let token = options.bootstrapToken;
      if (!token && existsSync(this.bootstrapFile))
        token = readFileSync(this.bootstrapFile, "utf8").trim();
      if (!token) {
        token = randomBytes(32).toString("hex");
        mkdirSync(dirname(this.bootstrapFile), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(this.bootstrapFile, token, { flag: "wx", mode: 0o600 });
      }
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new Error(
          "Installation bootstrap token must contain 64 hexadecimal characters.",
        );
      this.bootstrapHash = hash(token);
    }
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
  actor(request: FastifyRequest): InstallationDevice | null {
    if (!this.enabled) return null;
    const token = readCookie(request, COOKIE);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const state = this.state();
    const device = state.devices.find(
      (entry) => entry.tokenHash === hash(token),
    );
    if (
      !device ||
      device.revoked ||
      device.expiresAt <= this.now() ||
      device.lastSeenAt + 30 * 86_400_000 <= this.now()
    )
      return null;
    if (device.lastSeenAt + 5 * 60_000 < this.now()) {
      device.lastSeenAt = this.now();
      this.save(state);
    }
    return device;
  }
  isOwner(request: FastifyRequest): boolean {
    return this.actor(request)?.role === "owner";
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
  ) {
    const token = randomBytes(32).toString("hex");
    const now = this.now();
    const device: InstallationDevice = {
      id: randomUUID(),
      tokenHash: hash(token),
      role,
      name,
      accountId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 90 * 86_400_000,
      revoked: false,
    };
    const state = this.state();
    state.devices = state.devices.filter(
      (entry) => !entry.revoked && entry.expiresAt > now,
    );
    if (state.devices.length >= 100)
      throw new Error("Installation device limit reached.");
    state.claimed = true;
    state.devices.push(device);
    this.save(state);
    this.cookie(reply, COOKIE, token, 90 * 86_400);
    void request;
    return { id: device.id, role };
  }
  register(app: FastifyInstance) {
    if (!this.enabled) {
      app.get("/api/v1/installation/status", async () => ({
        enabled: false,
        claimed: false,
        paired: false,
        role: null,
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
      if (requestedHost !== origin.host && !loopbackHealthHost)
        return fail(reply, 403, "HOST_REJECTED");
      if (request.headers.origin && request.headers.origin !== origin.origin)
        return fail(reply, 403, "ORIGIN_REJECTED");
      if (
        !request.headers.origin &&
        request.headers["sec-fetch-site"] === "cross-site"
      )
        return fail(reply, 403, "ORIGIN_REJECTED");
      const publicPaths = new Set([
        "/api/v1/auth/status",
        "/api/v1/installation/status",
        "/api/v1/installation/claim",
        "/api/v1/installation/pair",
        "/api/v1/installation/poll",
        "/api/v1/health/live",
        "/api/v1/health/ready",
      ]);
      if (!publicPaths.has(path) && !this.actor(request))
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
        paired: actor !== null,
        role: actor?.role ?? null,
        serverId: this.database.settings.get<string>("server.instanceId"),
      };
    });
    app.post("/api/v1/installation/claim", async (request, reply) => {
      if (
        !this.budget(`claim:${request.ip}`, 5) ||
        !this.budget("claim:global", 30)
      )
        return fail(reply, 429, "RATE_LIMITED");
      const token = record(request.body).token;
      if (
        this.state().claimed ||
        !this.bootstrapHash ||
        typeof token !== "string" ||
        !timingSafeEqual(
          Buffer.from(hash(token), "hex"),
          Buffer.from(this.bootstrapHash, "hex"),
        )
      )
        return fail(reply, 403, "CLAIM_REJECTED");
      const result = this.issue(
        request,
        reply,
        "owner",
        "Server owner",
        this.database.accounts.getLocal().id,
      );
      this.bootstrapHash = null;
      if (existsSync(this.bootstrapFile)) unlinkSync(this.bootstrapFile);
      return result;
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
      const code = [...randomBytes(8)]
        .map((byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte & 31])
        .join("");
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
      return {
        requestId: item.id,
        code,
        expiresAt: new Date(item.expiresAt).toISOString(),
        interval: 3,
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
        item.accountId ?? this.database.accounts.getLocal().id,
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
          .map(({ id, name, expiresAt }) => ({ id, name, expiresAt })),
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
      item.accountId = this.actor(request)!.accountId;
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
