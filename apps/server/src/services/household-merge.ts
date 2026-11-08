import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { MasterPinHouseholdBackupSchema } from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { AccountSyncCredential } from "./account-sync-transport.js";
import {
  EncryptedHouseholdError,
  type EncryptedHouseholdService,
} from "./encrypted-household.js";
import type { EncryptedCheckpointTransport } from "./encrypted-sync-transport.js";
import { resolveHouseholdBackup } from "./master-pin-household-backup.js";
import { householdId } from "./household-state.js";

interface MergeInput {
  requestId: string;
  sourceHouseholdId: string;
  targetHouseholdId: string;
  sourceName: string;
  sourceRevision: number;
  targetRevision: number;
  currentTargetRevision: number;
  envelope: unknown;
}
interface Journal {
  sourceRevision: number;
  targetRevision?: number;
  completed?: boolean;
}
interface Options {
  database: StreamerDatabase;
  household: EncryptedHouseholdService;
  cloud?: EncryptedCheckpointTransport;
  serviceUrl: string | null;
  fetch?: typeof fetch;
  owner(request: FastifyRequest): boolean;
  getCredential(accountId: string): Promise<AccountSyncCredential | null>;
  beforeImport(accountId: string): Promise<() => Promise<void>>;
  adopt(accountId: string, revision: number, datasetId: string): void;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Cloud approves the source; its PIN only crosses the local server connection. */
export function registerHouseholdMerge(
  app: FastifyInstance,
  options: Options,
): void {
  let running = false;
  const remote = async (
    path: string,
    credential: AccountSyncCredential,
    body?: unknown,
  ) => {
    if (!options.serviceUrl)
      throw new EncryptedHouseholdError("CLOUD_NOT_CONFIGURED");
    const response = await (options.fetch ?? fetch)(
      new URL(path, options.serviceUrl),
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new EncryptedHouseholdError(
        response.status === 409
          ? "HOUSEHOLD_MERGE_CONFLICT"
          : "HOUSEHOLD_MERGE_UNAVAILABLE",
      );
    }
    return record(await response.json());
  };
  const load = async (
    requestId: string,
    credential: AccountSyncCredential,
    targetId: string,
  ): Promise<MergeInput> => {
    const value = await remote(
      `/v1/household-requests/${encodeURIComponent(requestId)}/import`,
      credential,
    );
    if (
      value.requestId !== requestId ||
      value.targetHouseholdId !== targetId ||
      typeof value.sourceHouseholdId !== "string" ||
      typeof value.sourceName !== "string" ||
      ![
        value.sourceRevision,
        value.targetRevision,
        value.currentTargetRevision,
      ].every((x) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0)
    )
      throw new EncryptedHouseholdError("INVALID_MERGE_RESPONSE");
    const envelope = MasterPinHouseholdBackupSchema.parse(value.envelope);
    if (envelope.envelope.datasetId !== value.sourceHouseholdId)
      throw new EncryptedHouseholdError("INVALID_MERGE_RESPONSE");
    return value as unknown as MergeInput;
  };
  app.get("/api/v1/admin/household-merges", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!options.owner(request))
      return reply
        .code(403)
        .send({ error: { code: "INSTALLATION_OWNER_REQUIRED" } });
    const credential = await options.getCredential(
      options.database.accounts.getHousehold().id,
    );
    if (!credential) return { requests: [] };
    try {
      const data = await remote("/v1/household-requests", credential);
      return {
        requests: Array.isArray(data.requests)
          ? data.requests.filter((value) => {
              const item = record(value);
              return (
                item.kind === "merge" &&
                item.status === "approved" &&
                item.requiresLocalImport === true
              );
            })
          : [],
      };
    } catch {
      return reply
        .code(503)
        .send({ error: { code: "HOUSEHOLD_MERGE_UNAVAILABLE" } });
    }
  });
  for (const operation of ["preview", "complete"] as const) {
    app.post(
      `/api/v1/admin/household-merge/${operation}`,
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        if (!options.owner(request))
          return reply
            .code(403)
            .send({ error: { code: "INSTALLATION_OWNER_REQUIRED" } });
        const body = record(request.body),
          requestId = body.requestId;
        if (
          typeof requestId !== "string" ||
          !/^[a-zA-Z0-9-]{16,100}$/.test(requestId) ||
          typeof body.sourcePin !== "string" ||
          !/^\d{8}$/.test(body.sourcePin) ||
          (operation === "complete" && body.confirm !== "merge-households")
        )
          return reply
            .code(400)
            .send({ error: { code: "INVALID_MERGE_REQUEST" } });
        if (running)
          return reply
            .code(409)
            .send({ error: { code: "HOUSEHOLD_MERGE_BUSY" } });
        const accountId = options.database.accounts.getHousehold().id;
        const credential = await options.getCredential(accountId);
        if (!credential || !options.cloud)
          return reply
            .code(409)
            .send({ error: { code: "CLOUD_NOT_CONNECTED" } });
        running = true;
        let resume: (() => Promise<void>) | undefined;
        const journalKey = `household.mergeCloud.${createHash("sha256")
          .update(accountId + ":" + requestId)
          .digest("hex")}`;
        try {
          const targetId = householdId(options.database, accountId);
          const saved = options.database.settings.get<Journal>(journalKey);
          if (operation === "complete" && saved?.completed)
            return { ok: true, alreadyCompleted: true };
          if (operation === "complete" && saved?.targetRevision) {
            await remote(
              `/v1/household-requests/${requestId}/complete`,
              credential,
              {
                sourceRevision: saved.sourceRevision,
                targetRevision: saved.targetRevision,
              },
            );
            options.database.settings.set(journalKey, {
              ...saved,
              completed: true,
            });
            return { ok: true };
          }
          const source = await load(requestId, credential, targetId);
          const input = await resolveHouseholdBackup(
            source.envelope,
            body.sourcePin,
          );
          const preview = options.household.preview(
            input.envelope,
            input.recoveryKey,
          );
          const count = options.database.profiles.count(accountId);
          if (!saved && count + preview.profiles.length > 5)
            throw new EncryptedHouseholdError("HOUSEHOLD_PROFILE_LIMIT");
          if (operation === "preview")
            return {
              ...preview,
              sourceName: source.sourceName,
              targetProfileCount: count,
              keepsDestinationPin: true,
              keepsDestinationServices: true,
            };
          resume = await options.beforeImport(accountId);
          const current = await options.cloud.read(credential);
          if (current.revision !== source.currentTargetRevision)
            throw new EncryptedHouseholdError("HOUSEHOLD_MERGE_CONFLICT");
          options.database.settings.set(journalKey, {
            sourceRevision: source.sourceRevision,
          } satisfies Journal);
          const imported = await options.household.merge(
            accountId,
            input.envelope,
            input.recoveryKey,
            requestId,
          );
          const backup = await options.household.exportLocalBackup(accountId);
          const uploaded = await options.cloud.write(
            credential,
            current.revision,
            backup,
          );
          options.database.settings.set(journalKey, {
            sourceRevision: source.sourceRevision,
            targetRevision: uploaded.revision,
          } satisfies Journal);
          options.adopt(accountId, uploaded.revision, targetId);
          await remote(
            `/v1/household-requests/${requestId}/complete`,
            credential,
            {
              sourceRevision: source.sourceRevision,
              targetRevision: uploaded.revision,
            },
          );
          options.database.settings.set(journalKey, {
            sourceRevision: source.sourceRevision,
            targetRevision: uploaded.revision,
            completed: true,
          } satisfies Journal);
          return { ok: true, ...imported };
        } catch (error) {
          const code =
            error instanceof EncryptedHouseholdError
              ? error.code
              : "HOUSEHOLD_MERGE_UNAVAILABLE";
          return reply
            .code(
              code.includes("UNAVAILABLE")
                ? 503
                : code.includes("CONFLICT") ||
                    code === "HOUSEHOLD_PROFILE_LIMIT"
                  ? 409
                  : 400,
            )
            .send({ error: { code, message: code } });
        } finally {
          try {
            await resume?.();
          } finally {
            running = false;
          }
        }
      },
    );
  }
}
