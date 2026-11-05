import {
  ENCRYPTED_CHECKPOINT_MAX_BYTES,
  EncryptedCheckpointSchema,
  type EncryptedCheckpoint,
  type EncryptedHouseholdEnvelope,
} from "@streamer-ai/contracts";
import type { AccountSyncCredential } from "./account-sync-transport.js";
import {
  EncryptedHouseholdError,
  parseHouseholdEnvelope,
} from "./encrypted-household-crypto.js";

/** A recovery checkpoint is not a merge engine; callers resolve revision conflicts explicitly. */
export class EncryptedCheckpointTransport {
  private readonly base: string;
  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    ) {
      throw new EncryptedHouseholdError("ENCRYPTED_SYNC_REQUIRES_HTTPS");
    }
    if (url.username || url.password)
      throw new EncryptedHouseholdError("INVALID_ENCRYPTED_SYNC_ORIGIN");
    this.base = url.origin;
  }

  private async request(
    credential: AccountSyncCredential,
    method: "GET" | "PUT" | "DELETE",
    data?: unknown,
  ): Promise<unknown> {
    const serialized = data === undefined ? undefined : JSON.stringify(data);
    if (
      serialized &&
      Buffer.byteLength(serialized) > ENCRYPTED_CHECKPOINT_MAX_BYTES + 1024
    )
      throw new EncryptedHouseholdError("ENCRYPTED_CHECKPOINT_TOO_LARGE");
    const response = await this.fetcher(`${this.base}/v1/sync/v2/checkpoint`, {
      method,
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(serialized ? { "content-type": "application/json" } : {}),
      },
      ...(serialized ? { body: serialized } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409)
        throw new EncryptedHouseholdError("ENCRYPTED_CHECKPOINT_CONFLICT");
      if (response.status === 401 || response.status === 403)
        throw new EncryptedHouseholdError(
          "ENCRYPTED_SYNC_AUTHENTICATION_REQUIRED",
        );
      throw new EncryptedHouseholdError("ENCRYPTED_SYNC_UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new EncryptedHouseholdError("INVALID_ENCRYPTED_SYNC_RESPONSE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > ENCRYPTED_CHECKPOINT_MAX_BYTES + 1024) {
        await reader.cancel();
        throw new EncryptedHouseholdError("ENCRYPTED_CHECKPOINT_TOO_LARGE");
      }
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new EncryptedHouseholdError("INVALID_ENCRYPTED_SYNC_RESPONSE");
    }
  }

  async read(credential: AccountSyncCredential): Promise<EncryptedCheckpoint> {
    const result = EncryptedCheckpointSchema.safeParse(
      await this.request(credential, "GET"),
    );
    if (!result.success)
      throw new EncryptedHouseholdError("INVALID_ENCRYPTED_SYNC_RESPONSE");
    return result.data;
  }

  async write(
    credential: AccountSyncCredential,
    expectedRevision: number,
    input: EncryptedHouseholdEnvelope,
  ): Promise<{ revision: number }> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new EncryptedHouseholdError(
        "INVALID_ENCRYPTED_CHECKPOINT_REVISION",
      );
    const envelope = parseHouseholdEnvelope(input);
    if (
      Buffer.byteLength(JSON.stringify(envelope)) >
      ENCRYPTED_CHECKPOINT_MAX_BYTES
    )
      throw new EncryptedHouseholdError("ENCRYPTED_CHECKPOINT_TOO_LARGE");
    const response = await this.request(credential, "PUT", {
      expectedRevision,
      envelope,
    });
    return this.revision(response, expectedRevision);
  }

  async remove(
    credential: AccountSyncCredential,
    expectedRevision: number,
  ): Promise<{ revision: number }> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      throw new EncryptedHouseholdError(
        "INVALID_ENCRYPTED_CHECKPOINT_REVISION",
      );
    const response = await this.request(credential, "DELETE", {
      expectedRevision,
      confirm: "delete-encrypted-checkpoint",
    });
    return this.revision(response, expectedRevision);
  }

  private revision(response: unknown, expected: number): { revision: number } {
    if (
      !response ||
      typeof response !== "object" ||
      !("revision" in response) ||
      response.revision !== expected + 1
    ) {
      throw new EncryptedHouseholdError("INVALID_ENCRYPTED_SYNC_RESPONSE");
    }
    return { revision: response.revision as number };
  }
}
