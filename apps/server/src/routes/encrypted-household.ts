import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ENCRYPTED_HOUSEHOLD_MAX_BYTES } from "@streamer-ai/contracts";
import { resolveHouseholdBackup } from "../services/master-pin-household-backup.js";
import {
  EncryptedHouseholdError,
  type EncryptedHouseholdService,
} from "../services/encrypted-household.js";
import type { AccountSyncCredential } from "../services/account-sync-transport.js";
import type { EncryptedCheckpointTransport } from "../services/encrypted-sync-transport.js";

export interface EncryptedHouseholdRouteOptions {
  service: EncryptedHouseholdService;
  accountId(request: FastifyRequest): string;
  /** Resolve true only for an authenticated household owner; false must send a response. */
  requireOwner(
    request: FastifyRequest,
    reply: FastifyReply,
  ): boolean | Promise<boolean>;
  getCredential?(accountId: string): Promise<AccountSyncCredential | null>;
  cloud?: EncryptedCheckpointTransport;
  cloudBackupStatus?(accountId: string): object;
  cloudConnected?(accountId: string): boolean;
  cloudBackupAdopt?(
    accountId: string,
    revision: number,
    datasetId: string,
  ): void;
  onRestored?(
    accountId: string,
    datasetId: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void>;
}

const base = "/api/v1/account/encrypted-household";
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD_REQUEST");
  return input as Record<string, unknown>;
};
async function recoverInput(input: unknown, restore: boolean) {
  const body = record(input);
  if (
    typeof body.recoveryKey !== "string" ||
    body.recoveryKey.length > 100 ||
    (restore && body.confirm !== "restore-into-empty-household")
  ) {
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD_REQUEST");
  }
  return resolveHouseholdBackup(body.envelope, body.recoveryKey);
}
function confirm(input: unknown, expected: string): void {
  if (record(input).confirm !== expected)
    throw new EncryptedHouseholdError(
      "ENCRYPTED_HOUSEHOLD_CONFIRMATION_REQUIRED",
    );
}

/** Authenticated owner-only recovery surfaces; never logs request bodies or decrypted snapshots. */
export function registerEncryptedHouseholdRoutes(
  app: FastifyInstance,
  options: EncryptedHouseholdRouteOptions,
): void {
  const route = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    suffix: string,
    operation: (
      accountId: string,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => unknown | Promise<unknown>,
  ) =>
    app.route({
      method,
      url: base + suffix,
      bodyLimit: ENCRYPTED_HOUSEHOLD_MAX_BYTES + 1024,
      async handler(request, reply) {
        reply.header("cache-control", "no-store");
        reply.header("pragma", "no-cache");
        if (!(await options.requireOwner(request, reply))) return;
        try {
          return await operation(options.accountId(request), request, reply);
        } catch (error) {
          const code =
            error instanceof EncryptedHouseholdError
              ? error.code
              : "ENCRYPTED_HOUSEHOLD_OPERATION_FAILED";
          const status =
            code === "ENCRYPTED_SYNC_AUTHENTICATION_REQUIRED"
              ? 401
              : code.endsWith("TOO_LARGE")
                ? 413
                : code.includes("CONFLICT") ||
                    code.includes("REQUIRES_EMPTY_ACCOUNT") ||
                    code.includes("ALREADY_ENABLED") ||
                    code.includes("NOT_ENABLED") ||
                    code.includes("CHANGED_RETRY")
                  ? 409
                  : code.includes("UNAVAILABLE") ||
                      code === "ENCRYPTED_HOUSEHOLD_OPERATION_FAILED"
                    ? 503
                    : 400;
          return reply.code(status).send({ error: { code, message: code } });
        }
      },
    });
  const credential = async (accountId: string) => {
    if (!options.cloud || !options.getCredential)
      throw new EncryptedHouseholdError("ENCRYPTED_SYNC_UNAVAILABLE");
    const value = await options.getCredential(accountId);
    if (!value)
      throw new EncryptedHouseholdError(
        "ENCRYPTED_SYNC_AUTHENTICATION_REQUIRED",
      );
    return { cloud: options.cloud, credential: value };
  };

  route("GET", "", (accountId) => ({
    ...options.service.status(accountId),
    cloudConfigured:
      !!options.cloud && (options.cloudConnected?.(accountId) ?? true),
    ...options.cloudBackupStatus?.(accountId),
  }));
  route("POST", "/activate", (accountId, request) => {
    confirm(request.body, "enable-encrypted-household");
    return options.service.activate(accountId).then(({ status }) => status);
  });
  route("POST", "/export", async (accountId, _request, reply) => {
    const backup = await options.service.exportLocalBackup(accountId);
    reply.header(
      "content-disposition",
      `attachment; filename="streamerai-household-${backup.envelope.snapshotId}.json"`,
    );
    return backup;
  });
  route("POST", "/preview", async (_accountId, request) => {
    const input = await recoverInput(request.body, false);
    return options.service.preview(input.envelope, input.recoveryKey);
  });
  route("POST", "/restore", async (accountId, request, reply) => {
    const input = await recoverInput(request.body, true);
    const cloudRevision = record(request.body).cloudRevision;
    if (cloudRevision !== undefined) {
      if (
        typeof cloudRevision !== "number" ||
        !Number.isSafeInteger(cloudRevision) ||
        cloudRevision < 1
      )
        throw new EncryptedHouseholdError(
          "INVALID_ENCRYPTED_CHECKPOINT_REVISION",
        );
      const connection = await credential(accountId);
      const current = await connection.cloud.read(connection.credential);
      if (
        current.revision !== cloudRevision ||
        JSON.stringify(current.envelope) !==
          JSON.stringify(record(request.body).envelope)
      )
        throw new EncryptedHouseholdError("ENCRYPTED_CHECKPOINT_CONFLICT");
    }
    const result = await options.service.restore(
      accountId,
      input.envelope,
      input.recoveryKey,
      input.cloudRecovery,
      input.cloudRecovery
        ? (record(request.body).recoveryKey as string)
        : undefined,
    );
    if (typeof cloudRevision === "number")
      options.cloudBackupAdopt?.(
        accountId,
        cloudRevision,
        input.envelope.datasetId,
      );
    await options.onRestored?.(
      accountId,
      input.envelope.datasetId,
      request,
      reply,
    );
    return result;
  });
  route("GET", "/cloud", async (accountId) => {
    const connection = await credential(accountId);
    return connection.cloud.read(connection.credential);
  });
}
