import type { AccountSyncOperation } from "@streamer-ai/contracts";
import type { ProviderFetch } from "../integrations/tmdb-api-client.js";

export interface AccountSyncCredential {
  token: string;
  deviceId: string;
}
export type SyncExchange =
  | { kind: "push"; operations: AccountSyncOperation[] }
  | { kind: "snapshot" | "delta"; cursor: string | null };

/** The merge engine does not need a storage provider's file or HTTP model. */
export interface AccountSyncTransport {
  exchange(
    credential: AccountSyncCredential,
    operation: SyncExchange,
  ): Promise<unknown>;
}

export class SyncCursorExpiredError extends Error {}

export class D1AccountSyncTransport implements AccountSyncTransport {
  private readonly base: string;
  constructor(
    base: string,
    private readonly fetcher: ProviderFetch,
  ) {
    const url = new URL(base);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("Cloud synchronization requires HTTPS.");
    this.base = url.origin;
  }
  async exchange(
    credential: AccountSyncCredential,
    operation: SyncExchange,
  ): Promise<unknown> {
    const push = operation.kind === "push";
    const path = push
      ? "/v1/sync/push"
      : operation.kind === "snapshot"
        ? "/v1/sync/snapshot"
        : "/v1/sync/pull";
    const suffix =
      !push && operation.cursor !== null
        ? `?after=${encodeURIComponent(operation.cursor)}`
        : "";
    const response = await this.fetcher(this.base + path + suffix, {
      method: push ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(push ? { "content-type": "application/json" } : {}),
      },
      ...(push
        ? { body: JSON.stringify({ operations: operation.operations }) }
        : {}),
      signal: AbortSignal.timeout(15_000),
      redirect: "manual",
    });
    if (!response.ok && response.status !== 410)
      throw new Error(`Cloud sync failed (${response.status}).`);
    const serialized = await response.text();
    if (serialized.length > 2 * 1024 * 1024)
      throw new Error("Cloud sync response is too large.");
    if (!response.ok) {
      let data: unknown;
      try {
        data = JSON.parse(serialized);
      } catch {
        /* Proxy HTML is not cursor recovery. */
      }
      if (
        response.status === 410 &&
        data &&
        typeof data === "object" &&
        "error" in data &&
        data.error === "cursor_expired"
      )
        throw new SyncCursorExpiredError("Cloud sync cursor expired.");
      throw new Error(`Cloud sync failed (${response.status}).`);
    }
    return JSON.parse(serialized) as unknown;
  }
}
