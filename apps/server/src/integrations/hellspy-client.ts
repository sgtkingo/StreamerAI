import type { SecretStore } from "../stores/secret-store.js";
import { profileSecretKey } from "../stores/secret-store.js";
import type {
  ProviderFetch,
  ProviderFetchResponse,
} from "./tmdb-api-client.js";
import {
  isAbortFailure,
  ProviderRequestError,
  providerFailureForStatus,
} from "./provider-http.js";

export const HELLSPY_SESSION_SECRET_KEY = "integration.hellspy.session";
const API = "https://api.hellspy.to";
const MAX_BYTES = 2 * 1024 * 1024;

export interface HellspySession {
  accessToken: string;
  expires: string | null;
}
export interface HellspyVideo {
  id: number;
  title: string;
  fileHash: string;
  size: number | null;
}
export interface HellspyVideoDetail extends HellspyVideo {
  filename: string;
  conversions: Record<string, string>;
}
export interface HellspyClientOptions {
  secretStore: SecretStore;
  fetch?: ProviderFetch;
  timeoutMs?: number;
  now?: () => Date;
}
interface RequestBudget {
  start: number;
  count: number;
  failures: number;
  blockedUntil: number;
}
function failure(
  kind: "invalid-response" | "unauthorized" = "invalid-response",
) {
  return new ProviderRequestError("hellspy", kind, false);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw failure();
  return value as Record<string, unknown>;
}
function session(value: unknown): HellspySession {
  const data = object(value);
  if (
    typeof data.accessToken !== "string" ||
    !/^[\x21-\x7e]{1,8192}$/.test(data.accessToken) ||
    !(
      data.expires === null ||
      (typeof data.expires === "string" &&
        Number.isFinite(Date.parse(data.expires)))
    )
  )
    throw failure();
  return { accessToken: data.accessToken, expires: data.expires };
}
function video(value: unknown): HellspyVideo {
  const data = object(value);
  if (
    !Number.isSafeInteger(data.id) ||
    Number(data.id) <= 0 ||
    typeof data.title !== "string" ||
    !data.title.trim() ||
    data.title.length > 500 ||
    typeof data.fileHash !== "string" ||
    !/^[a-f0-9]{16,64}$/i.test(data.fileHash) ||
    !(
      data.size === null ||
      (Number.isSafeInteger(data.size) && Number(data.size) >= 0)
    )
  )
    throw failure();
  return {
    id: Number(data.id),
    title: data.title,
    fileHash: data.fileHash,
    size: data.size as number | null,
  };
}
export function hellspyCandidateId(item: HellspyVideo): string {
  return `${item.id}:${item.fileHash}`;
}
export function parseHellspyCandidateId(value: string): {
  id: number;
  hash: string;
} {
  const match = /^([1-9][0-9]{0,15}):([a-f0-9]{16,64})$/i.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw failure();
  return { id: Number(match[1]), hash: match[2]! };
}
/** Only provider-controlled HTTPS media hosts; never send the login token here. */
export function safeHellspyMediaUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw failure();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !["hellspy.to", "onecdn1.net"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw failure();
  return url.toString();
}
async function boundedText(response: ProviderFetchResponse): Promise<string> {
  const body = response.body as ReadableStream<Uint8Array> | undefined | null;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw failure();
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw failure();
  return text;
}

/** Fixed-origin, bounded transport for the API used by Hellspy's own web client. */
export class HellspyClient {
  readonly #fetch: ProviderFetch;
  readonly #now: () => Date;
  readonly #budget: RequestBudget;
  readonly #authorizationJobs = new Map<
    string,
    { saved: string; job: Promise<string> }
  >();
  constructor(
    private readonly options: HellspyClientOptions,
    budget?: RequestBudget,
  ) {
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => new Date());
    this.#budget = budget ?? {
      start: 0,
      count: 0,
      failures: 0,
      blockedUntil: 0,
    };
  }
  private key(profileId: string) {
    return profileSecretKey(profileId, HELLSPY_SESSION_SECRET_KEY);
  }
  async hasCredential(profileId: string): Promise<boolean> {
    return this.options.secretStore.has(this.key(profileId));
  }
  async authenticate(
    email: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<HellspySession> {
    const value = session(
      await this.request("/login", null, { email, password }, signal),
    );
    if (
      value.expires !== null &&
      Date.parse(value.expires) <= this.#now().getTime()
    )
      throw failure("unauthorized");
    await this.identify(value.accessToken, signal);
    return value;
  }
  private async identify(token: string, signal?: AbortSignal): Promise<void> {
    const identity = object(
      await this.request("/identify", token, undefined, signal),
    );
    // /identify returns HTTP 200 with null fields for anonymous/expired sessions.
    if (identity.user === null || identity.token === null)
      throw failure("unauthorized");
    const user = object(identity.user);
    if (!(typeof user.id === "string" || Number.isSafeInteger(user.id)))
      throw failure();
    object(identity.token);
  }
  async authorize(profileId: string, signal?: AbortSignal): Promise<string> {
    const saved = await this.options.secretStore.get(this.key(profileId));
    if (!saved)
      throw new ProviderRequestError("hellspy", "not-configured", false);
    signal?.throwIfAborted();
    const active = this.#authorizationJobs.get(profileId);
    const job =
      active?.saved === saved
        ? active.job
        : this.authorizeSession(profileId, saved);
    if (job !== active?.job) {
      this.#authorizationJobs.set(profileId, { saved, job });
      const cleanup = () => {
        if (this.#authorizationJobs.get(profileId)?.job === job)
          this.#authorizationJobs.delete(profileId);
      };
      void job.then(cleanup, cleanup);
    }
    if (!signal) return job;
    // One caller can cancel without cancelling another caller's shared refresh.
    return new Promise<string>((resolve, reject) => {
      const abort = () =>
        reject(new ProviderRequestError("hellspy", "timeout", true));
      signal.addEventListener("abort", abort, { once: true });
      void job
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }
  private async authorizeSession(
    profileId: string,
    saved: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let current: HellspySession;
    try {
      current = session(JSON.parse(saved));
    } catch {
      throw failure("unauthorized");
    }
    if (
      current.expires !== null &&
      Date.parse(current.expires) <= this.#now().getTime()
    )
      throw failure("unauthorized");
    if (
      current.expires !== null &&
      Date.parse(current.expires) < this.#now().getTime() + 5 * 60_000
    ) {
      const refreshed = session(
        await this.request("/refresh_token", current.accessToken, {}, signal),
      );
      if (
        refreshed.expires !== null &&
        Date.parse(refreshed.expires) <= this.#now().getTime()
      )
        throw failure("unauthorized");
      await this.identify(refreshed.accessToken, signal);
      // A disconnect or reconnect while refresh was pending must not resurrect an old session.
      if ((await this.options.secretStore.get(this.key(profileId))) !== saved)
        throw failure("unauthorized");
      await this.options.secretStore.set(
        this.key(profileId),
        JSON.stringify(refreshed),
      );
      current = refreshed;
    } else {
      await this.identify(current.accessToken, signal);
      if ((await this.options.secretStore.get(this.key(profileId))) !== saved)
        throw failure("unauthorized");
    }
    return current.accessToken;
  }
  async search(
    profileId: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<HellspyVideo[]> {
    const token = await this.authorize(profileId, signal);
    const data = object(
      await this.request(
        `/gw/search?${new URLSearchParams({ query, offset: "0", limit: String(Math.min(64, limit)) })}`,
        token,
        undefined,
        signal,
      ),
    );
    if (!Array.isArray(data.items) || data.items.length > 1000) throw failure();
    return data.items.slice(0, limit).map(video);
  }
  async detail(
    profileId: string,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<HellspyVideoDetail> {
    const { id, hash } = parseHellspyCandidateId(candidateId);
    const token = await this.authorize(profileId, signal);
    const data = object(
      await this.request(`/gw/video/${id}/${hash}`, token, undefined, signal),
    );
    const item = video(data);
    if (
      item.id !== id ||
      item.fileHash !== hash ||
      typeof data.filename !== "string" ||
      !data.filename ||
      data.filename.length > 500
    )
      throw failure();
    const conversions: Record<string, string> = {};
    for (const [quality, url] of Object.entries(object(data.conversions))) {
      if (!/^(0|240|360|480|576|720|1080|1440|2160|4320)$/.test(quality))
        continue;
      if (typeof url !== "string" || url.length > 16_384) throw failure();
      conversions[quality] = safeHellspyMediaUrl(url);
    }
    return { ...item, filename: data.filename, conversions };
  }
  async probeUrl(url: string, signal?: AbortSignal): Promise<boolean> {
    const response = await this.transport(
      safeHellspyMediaUrl(url),
      null,
      undefined,
      signal,
      true,
    );
    const range =
      response.status === 206 &&
      /^bytes 0-0\/\d+$/.test(response.headers?.get("content-range") ?? "");
    const contentType = response.headers?.get("content-type") ?? "";
    await response.body?.cancel();
    if (!/^(video\/|application\/octet-stream)/i.test(contentType))
      throw failure();
    return range;
  }
  private async request(
    path: string,
    token: string | null,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.transport(API + path, token, body, signal);
    const text = await boundedText(response);
    try {
      const data: unknown = JSON.parse(text);
      if (object(data).structType === "error" || "error" in object(data))
        throw failure();
      return data;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw failure();
    }
  }
  private async transport(
    url: string,
    token: string | null,
    body?: unknown,
    signal?: AbortSignal,
    probe = false,
  ): Promise<ProviderFetchResponse> {
    const now = this.#now().getTime();
    if (now < this.#budget.blockedUntil)
      throw new ProviderRequestError("hellspy", "rate-limited", true);
    if (now - this.#budget.start >= 60_000) {
      this.#budget.start = now;
      this.#budget.count = 0;
    }
    if (++this.#budget.count > 120)
      throw new ProviderRequestError("hellspy", "rate-limited", true);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, this.options.timeoutMs ?? 8_000);
    try {
      const response = await this.#fetch(url, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(probe ? { Range: "bytes=0-0" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "manual",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw providerFailureForStatus("hellspy", response.status);
      }
      // Consume JSON while the timeout and caller cancellation are still active.
      if (!probe) {
        const text = await boundedText(response);
        this.#budget.failures = 0;
        return { ok: true, status: response.status, text: async () => text };
      }
      this.#budget.failures = 0;
      return response;
    } catch (error) {
      const safe =
        error instanceof ProviderRequestError
          ? error
          : new ProviderRequestError(
              "hellspy",
              controller.signal.aborted || isAbortFailure(error)
                ? "timeout"
                : "network",
              true,
            );
      if (
        (safe.retryable && ++this.#budget.failures >= 3) ||
        safe.kind === "rate-limited"
      )
        this.#budget.blockedUntil = now + 30_000;
      throw safe;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
