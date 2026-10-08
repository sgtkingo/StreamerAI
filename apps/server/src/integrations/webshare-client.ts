import { createHash } from "node:crypto";
import type { SecretStore } from "../stores/secret-store.js";
import {
  isAbortFailure,
  ProviderRequestError,
  providerFailureForStatus,
} from "./provider-http.js";
import type {
  ProviderFetch,
  ProviderFetchResponse,
} from "./tmdb-api-client.js";
import { md5Crypt } from "./md5-crypt.js";

export const WEBSHARE_WST_SECRET_KEY = "integration.webshare.wst";
const DEFAULT_BASE_URL = "https://webshare.cz/api";
const MAX_XML_BYTES = 2 * 1024 * 1024;

export interface WebshareSearchItem {
  ident: string;
  name: string;
  type: string | null;
  size: number | null;
  passwordProtected: boolean;
  positiveVotes: number | null;
  negativeVotes: number | null;
}

export interface WebshareFileInfo {
  ident: string;
  name: string;
  type: string | null;
  size: number | null;
  downloadable: boolean;
  passwordProtected: boolean;
  copyrighted: boolean;
}

export interface WebshareSimilarSubtitleItem {
  ident: string;
  name: string;
  type: string | null;
  size: number | null;
}

export class WebshareResponseError extends ProviderRequestError {
  constructor(
    kind: "unauthorized" | "upstream" | "invalid-response",
    retryable: boolean,
    readonly upstreamCode: string | null,
  ) {
    super("webshare", kind, retryable);
    this.name = "WebshareResponseError";
  }
}

export interface WebshareClientOptions {
  secretStore: SecretStore;
  fetch?: ProviderFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

function defaultProviderFetch(
  input: string,
  init: Parameters<ProviderFetch>[1],
): Promise<ProviderFetchResponse> {
  return fetch(input, init);
}

function safeBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error(
      "Webshare base URL must use HTTPS (except loopback tests).",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "Webshare base URL cannot contain credentials, query, or fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(
      /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi,
      (entity, hex, decimal) => {
        const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        return codePoint > 0 &&
          codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : entity;
      },
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rawTag(xml: string, name: string): string | null {
  const safeName = escapeRegExp(name);
  const match = new RegExp(`<${safeName}>([\\s\\S]*?)</${safeName}>`, "i").exec(
    xml,
  );
  return match?.[1] ?? null;
}

function tag(xml: string, name: string): string | null {
  const raw = rawTag(xml, name);
  return raw === null ? null : decodeXml(raw.trim());
}

function blocks(xml: string, name: string): string[] {
  const safeName = escapeRegExp(name);
  return [
    ...xml.matchAll(
      new RegExp(`<${safeName}>([\\s\\S]*?)</${safeName}>`, "gi"),
    ),
  ]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

function integer(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function booleanFlag(value: string | null): boolean {
  return value === "1";
}

function safeDirectLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new WebshareResponseError("invalid-response", false, null);
  }
  const allowedHost =
    url.hostname === "webshare.cz" ||
    url.hostname.endsWith(".webshare.cz") ||
    url.hostname === "dl.wsfiles.cz" ||
    url.hostname.endsWith(".dl.wsfiles.cz");
  if (
    url.protocol !== "https:" ||
    !allowedHost ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new WebshareResponseError("invalid-response", false, null);
  }
  return url.toString();
}

function assertOk(xml: string): void {
  const status = tag(xml, "status");
  if (status === "OK") return;
  if (status === null) {
    throw new WebshareResponseError("invalid-response", true, null);
  }
  const code = tag(xml, "code");
  const denied =
    code?.includes("ACCESS") === true || code?.includes("LOGIN") === true;
  throw new WebshareResponseError(
    denied ? "unauthorized" : "upstream",
    !denied,
    code,
  );
}

async function boundedXml(response: ProviderFetchResponse): Promise<string> {
  const stream = response.body as ReadableStream<Uint8Array> | null | undefined;
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_XML_BYTES) {
          await reader.cancel();
          throw new WebshareResponseError("invalid-response", true, null);
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  }
  // Small test transports may expose only text(); production fetch streams.
  const xml = await response.text();
  if (Buffer.byteLength(xml, "utf8") > MAX_XML_BYTES) {
    throw new WebshareResponseError("invalid-response", true, null);
  }
  return xml;
}

/**
 * Bounded Webshare XML transport. It validates application-level status even
 * when the provider returns HTTP 200 and never places WST in URLs or errors.
 */
export class WebshareClient {
  readonly #secretStore: SecretStore;
  readonly #fetch: ProviderFetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: WebshareClientOptions) {
    this.#secretStore = options.secretStore;
    this.#fetch = options.fetch ?? defaultProviderFetch;
    this.#baseUrl = safeBaseUrl(
      options.baseUrl ?? process.env.WEBSHARE_BASE_URL ?? DEFAULT_BASE_URL,
    );
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  hasCredential(): Promise<boolean> {
    return this.#secretStore.has(WEBSHARE_WST_SECRET_KEY);
  }

  /** Exchange an explicit password for WST without retaining the password. */
  async authenticate(
    usernameOrEmail: string,
    password: string,
  ): Promise<string> {
    const username = usernameOrEmail.trim();
    if (username.length < 1 || username.length > 254) {
      throw new TypeError("Webshare username or email is invalid.");
    }
    if (password.length < 1 || password.length > 1_024) {
      throw new TypeError("Webshare password is invalid.");
    }
    const saltXml = await this.post(
      "salt",
      { username_or_email: username },
      false,
      false,
    );
    const salt = tag(saltXml, "salt");
    if (salt === null) {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    let passwordDigest: string;
    try {
      passwordDigest = createHash("sha1")
        .update(md5Crypt(password, salt), "utf8")
        .digest("hex");
    } catch {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    const loginXml = await this.post(
      "login",
      {
        username_or_email: username,
        password: passwordDigest,
        keep_logged_in: "1",
      },
      false,
      false,
    );
    const token = tag(loginXml, "token")?.trim();
    if (token === undefined || token.length < 10 || token.length > 4_096) {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    return token;
  }

  async search(
    input: {
      query: string;
      limit?: number;
      offset?: number;
      sort?: "recent" | "rating" | "largest" | "smallest";
    },
    signal?: AbortSignal,
  ): Promise<{ total: number | null; items: WebshareSearchItem[] }> {
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("Webshare search limit must be between 1 and 100.");
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new TypeError("Webshare search offset must be non-negative.");
    }
    const xml = await this.post(
      "search",
      {
        what: input.query.trim(),
        sort: input.sort ?? "rating",
        limit: String(limit),
        offset: String(offset),
        category: "video",
      },
      false,
      true,
      signal,
    );
    return {
      total: integer(tag(xml, "total")),
      items: blocks(xml, "file").flatMap((file) => {
        const ident = tag(file, "ident");
        const name = tag(file, "name");
        if (ident === null || name === null) return [];
        return [
          {
            ident,
            name,
            type: tag(file, "type"),
            size: integer(tag(file, "size")),
            passwordProtected: booleanFlag(tag(file, "password")),
            positiveVotes: integer(tag(file, "positive_votes")),
            negativeVotes: integer(tag(file, "negative_votes")),
          },
        ];
      }),
    };
  }

  async fileInfo(
    ident: string,
    signal?: AbortSignal,
  ): Promise<WebshareFileInfo> {
    const xml = await this.post(
      "file_info",
      { ident, maybe_removed: "0" },
      true,
      true,
      signal,
    );
    const name = tag(xml, "name");
    const available = tag(xml, "available");
    const password = tag(xml, "password");
    const copyrighted = tag(xml, "copyrighted");
    if (
      name === null ||
      !["0", "1"].includes(available ?? "") ||
      !["0", "1"].includes(password ?? "") ||
      !["0", "1"].includes(copyrighted ?? "")
    ) {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    return {
      ident,
      name,
      type: tag(xml, "type"),
      size: integer(tag(xml, "size")),
      downloadable: booleanFlag(available),
      passwordProtected: booleanFlag(password),
      copyrighted: booleanFlag(copyrighted),
    };
  }

  /** Webshare returns a dedicated subtitles group for a similar-files query. */
  async similarSubtitles(
    mediaFilename: string,
    signal?: AbortSignal,
  ): Promise<WebshareSimilarSubtitleItem[]> {
    if (
      mediaFilename.length < 1 ||
      mediaFilename.length > 255 ||
      [...mediaFilename].some((character) => character.charCodeAt(0) < 32)
    ) {
      throw new TypeError("Webshare media filename is invalid.");
    }
    const xml = await this.post(
      "similar_files",
      { what: mediaFilename, limit: "100", offset: "0" },
      false,
      true,
      signal,
    );
    // Keep nested XML escaped until individual file fields are read.
    const subtitleGroup = rawTag(xml, "subtitles");
    if (subtitleGroup === null) return [];
    return blocks(subtitleGroup, "file")
      .slice(0, 100)
      .flatMap((file) => {
        const ident = tag(file, "ident");
        const name = tag(file, "name");
        if (ident === null || name === null) return [];
        return [
          {
            ident,
            name,
            type: tag(file, "type"),
            size: integer(tag(file, "size")),
          },
        ];
      });
  }

  async createDownloadLink(
    ident: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const xml = await this.post(
      "file_link",
      { ident, download_type: "file_download", force_https: "1" },
      true,
      true,
      signal,
    );
    const link = tag(xml, "link");
    if (link === null) {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    return safeDirectLink(link);
  }

  /** Downloads a direct file link with a hard streaming limit and no redirects. */
  async downloadFile(
    ident: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > 8 * 1024 * 1024
    ) {
      throw new TypeError("Webshare download limit is invalid.");
    }
    const url = await this.createDownloadLink(ident, signal);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const requestSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      requestSignal.throwIfAborted();
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "text/plain, application/octet-stream" },
        signal: requestSignal,
        redirect: "manual",
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw providerFailureForStatus("webshare", response.status);
      }
      const contentLength = Number(
        (
          response as typeof response & {
            headers?: { get(name: string): string | null };
          }
        ).headers?.get("content-length"),
      );
      if (contentLength > maxBytes) {
        await response.body?.cancel();
        throw new WebshareResponseError("invalid-response", false, null);
      }
      const stream = response.body as
        ReadableStream<Uint8Array> | null | undefined;
      if (!stream || typeof stream.getReader !== "function") {
        await response.body?.cancel();
        throw new WebshareResponseError("invalid-response", true, null);
      }
      const reader = stream.getReader();
      const chunks: Buffer[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) {
            await reader.cancel();
            throw new WebshareResponseError("invalid-response", false, null);
          }
          chunks.push(Buffer.from(part.value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, bytes);
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof ProviderRequestError) throw error;
      if (controller.signal.aborted || isAbortFailure(error)) {
        throw new ProviderRequestError("webshare", "timeout", true);
      }
      throw new ProviderRequestError("webshare", "network", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  async createVideoLink(ident: string): Promise<string> {
    const xml = await this.post(
      "file_link",
      { ident, download_type: "video_stream", force_https: "1" },
      true,
    );
    const link = tag(xml, "link");
    if (link === null) {
      throw new WebshareResponseError("invalid-response", true, null);
    }
    const url = safeDirectLink(link);
    await this.probeVideoLink(url);
    return url;
  }

  private async probeVideoLink(url: string): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: "GET",
        headers: { range: "bytes=0-0" },
        signal: controller.signal,
        redirect: "manual",
      });
      await response.body?.cancel();
      const contentRange = response.headers?.get("content-range");
      const range = /^bytes 0-0\/(\d+)$/.exec(contentRange ?? "");
      if (
        response.status !== 206 ||
        range === null ||
        !Number.isSafeInteger(Number(range[1])) ||
        Number(range[1]) < 1 ||
        (response.headers?.get("content-length") != null &&
          response.headers.get("content-length") !== "1")
      ) {
        throw new ProviderRequestError("webshare", "invalid-response", true);
      }
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (controller.signal.aborted || isAbortFailure(error)) {
        throw new ProviderRequestError("webshare", "timeout", true);
      }
      throw new ProviderRequestError("webshare", "network", true);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async post(
    endpoint: string,
    values: Readonly<Record<string, string>>,
    requireAuthentication: boolean,
    sendStoredCredential = true,
    signal?: AbortSignal,
  ): Promise<string> {
    const token = sendStoredCredential
      ? await this.#secretStore.get(WEBSHARE_WST_SECRET_KEY)
      : undefined;
    if (requireAuthentication && token === undefined) {
      throw new ProviderRequestError("webshare", "not-configured", false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;
    try {
      requestSignal.throwIfAborted();
      const response = await this.#fetch(`${this.#baseUrl}/${endpoint}/`, {
        method: "POST",
        headers: {
          accept: "text/xml; charset=UTF-8",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: new URLSearchParams({
          ...values,
          ...(token === undefined ? {} : { wst: token }),
        }).toString(),
        signal: requestSignal,
      });
      if (!response.ok) {
        throw providerFailureForStatus("webshare", response.status);
      }
      const xml = await boundedXml(response);
      assertOk(xml);
      return xml;
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (controller.signal.aborted || isAbortFailure(error)) {
        throw new ProviderRequestError("webshare", "timeout", true);
      }
      throw new ProviderRequestError("webshare", "network", true);
    } finally {
      clearTimeout(timeout);
    }
  }
}
