import {
  ENCRYPTED_CHECKPOINT_MAX_BYTES,
  EncryptedCheckpointWriteSchema,
  MasterPinHouseholdBackupSchema,
} from "@streamer-ai/contracts";
import { body, enforceRateLimit, HttpError, json, record } from "./http.js";
import type { Env, Principal } from "./types.js";

interface Row {
  revision: number;
  envelope_json: string | null;
}

export async function assertEncryptedMergeSupported(
  env: Env,
  first: string,
  second: string,
): Promise<void> {
  const existing = await env.DB.prepare(
    "SELECT 1 FROM cloud_encrypted_checkpoint WHERE account_id IN (?, ?) LIMIT 1",
  )
    .bind(first, second)
    .first();
  if (existing)
    throw new HttpError(409, "encrypted_household_merge_requires_export");
}

/** Presence includes deletion tombstones: old clients must never resume plaintext upload. */
export async function assertLegacySyncAllowed(
  env: Env,
  accountId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM cloud_encrypted_checkpoint WHERE account_id = ?",
  )
    .bind(accountId)
    .first();
  if (row) throw new HttpError(409, "encrypted_sync_required");
}

export async function encryptedCheckpoint(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  const accountId = principal.account.id;
  await enforceRateLimit(
    env.DB,
    `encrypted-checkpoint:${accountId}`,
    30,
    60,
    now,
  );
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT revision, envelope_json FROM cloud_encrypted_checkpoint WHERE account_id = ?",
    )
      .bind(accountId)
      .first<Row>();
    return json({
      revision: row?.revision ?? 0,
      envelope: row?.envelope_json
        ? MasterPinHouseholdBackupSchema.parse(JSON.parse(row.envelope_json))
        : null,
    });
  }
  if (principal.method !== "device")
    throw new HttpError(403, "home_server_required");
  if (principal.mergeAckRequired) throw new HttpError(409, "account_merged");
  if (request.method === "PUT") {
    const parsed = EncryptedCheckpointWriteSchema.safeParse(
      await body(request, ENCRYPTED_CHECKPOINT_MAX_BYTES + 1024),
    );
    if (!parsed.success)
      throw new HttpError(400, "invalid_encrypted_checkpoint");
    const serialized = JSON.stringify(parsed.data.envelope);
    if (
      new TextEncoder().encode(serialized).length >
      ENCRYPTED_CHECKPOINT_MAX_BYTES
    )
      throw new HttpError(413, "encrypted_checkpoint_too_large");
    const expected = parsed.data.expectedRevision;
    const updated =
      expected === 0
        ? await env.DB.prepare(
            `INSERT OR IGNORE INTO cloud_encrypted_checkpoint (account_id, revision, dataset_id, envelope_json, updated_at)
       VALUES (?, 1, ?, ?, ?) RETURNING revision`,
          )
            .bind(
              accountId,
              parsed.data.envelope.envelope.datasetId,
              serialized,
              now,
            )
            .first<{ revision: number }>()
        : await env.DB.prepare(
            `UPDATE cloud_encrypted_checkpoint SET revision = revision + 1, dataset_id = ?, envelope_json = ?, updated_at = ?
       WHERE account_id = ? AND revision = ? RETURNING revision`,
          )
            .bind(
              parsed.data.envelope.envelope.datasetId,
              serialized,
              now,
              accountId,
              expected,
            )
            .first<{ revision: number }>();
    if (!updated) throw new HttpError(409, "encrypted_checkpoint_conflict");
    return json({ revision: updated.revision });
  }
  if (request.method === "DELETE") {
    const input = record(await body(request, 1024));
    const expected = input.expectedRevision;
    if (
      !Number.isSafeInteger(expected) ||
      typeof expected !== "number" ||
      expected < 1 ||
      input.confirm !== "delete-encrypted-checkpoint"
    )
      throw new HttpError(400, "invalid_checkpoint_deletion");
    const row = await env.DB.prepare(
      `UPDATE cloud_encrypted_checkpoint SET revision = revision + 1, envelope_json = NULL, updated_at = ?
       WHERE account_id = ? AND revision = ? RETURNING revision`,
    )
      .bind(now, accountId, expected)
      .first<{ revision: number }>();
    if (!row) throw new HttpError(409, "encrypted_checkpoint_conflict");
    return json({ revision: row.revision, envelope: null });
  }
  throw new HttpError(405, "method_not_allowed");
}
