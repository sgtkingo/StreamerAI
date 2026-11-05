import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ENCRYPTED_HOUSEHOLD_MAX_BYTES,
  EncryptedHouseholdEnvelopeSchema,
} from "@streamer-ai/contracts";
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
}

const base = "/api/v1/account/encrypted-household";
const record = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD_REQUEST");
  return input as Record<string, unknown>;
};
function recoverInput(input: unknown, restore: boolean) {
  const body = record(input);
  const envelope = EncryptedHouseholdEnvelopeSchema.safeParse(body.envelope);
  if (
    !envelope.success ||
    typeof body.recoveryKey !== "string" ||
    body.recoveryKey.length > 100 ||
    (restore && body.confirm !== "restore-into-empty-household")
  ) {
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD_REQUEST");
  }
  return { envelope: envelope.data, recoveryKey: body.recoveryKey };
}
function confirm(input: unknown, expected: string): void {
  if (record(input).confirm !== expected)
    throw new EncryptedHouseholdError(
      "ENCRYPTED_HOUSEHOLD_CONFIRMATION_REQUIRED",
    );
}
function revision(input: unknown): number {
  const value = record(input).expectedRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_CHECKPOINT_REVISION");
  return value;
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
    cloudConfigured: !!options.cloud,
  }));
  route("POST", "/activate", (accountId, request) => {
    confirm(request.body, "enable-encrypted-household");
    return options.service.activate(accountId);
  });
  route("POST", "/export", async (accountId, _request, reply) => {
    const envelope = await options.service.export(accountId);
    reply.header(
      "content-disposition",
      `attachment; filename="streamerai-household-${envelope.snapshotId}.json"`,
    );
    return envelope;
  });
  route("POST", "/preview", (_accountId, request) => {
    const input = recoverInput(request.body, false);
    return options.service.preview(input.envelope, input.recoveryKey);
  });
  route("POST", "/restore", (accountId, request) => {
    const input = recoverInput(request.body, true);
    return options.service.restore(
      accountId,
      input.envelope,
      input.recoveryKey,
    );
  });
  route("POST", "/rotate-recovery", (accountId, request) => {
    confirm(request.body, "rotate-recovery-key");
    return options.service.rotateRecoveryKey(accountId);
  });
  route("GET", "/cloud", async (accountId) => {
    const connection = await credential(accountId);
    return connection.cloud.read(connection.credential);
  });
  route("PUT", "/cloud", async (accountId, request) => {
    const expectedRevision = revision(request.body);
    confirm(request.body, "upload-encrypted-checkpoint");
    const connection = await credential(accountId);
    const envelope = await options.service.export(accountId);
    return connection.cloud.write(
      connection.credential,
      expectedRevision,
      envelope,
    );
  });
  route("DELETE", "/cloud", async (accountId, request) => {
    const expectedRevision = revision(request.body);
    confirm(request.body, "delete-encrypted-checkpoint");
    const connection = await credential(accountId);
    return connection.cloud.remove(connection.credential, expectedRevision);
  });
}
