import {
  ENCRYPTED_CHECKPOINT_MAX_BYTES,
  EncryptedCheckpointWriteSchema,
  MasterPinHouseholdBackupSchema,
} from "@streamer-ai/contracts";
import { body, enforceRateLimit, HttpError, json, record } from "./http.js";
import { requireHousehold } from "./households.js";
import type { Env, Principal } from "./types.js";

export async function householdCheckpoint(
  request: Request,
  env: Env,
  principal: Principal,
  now: number,
): Promise<Response> {
  const id = principal.householdId;
  if (!id) throw new HttpError(403, "household_scope_required");
  await requireHousehold(env, principal, id, true);
  await enforceRateLimit(env.DB, `household-checkpoint:${id}`, 30, 60, now);
  if (request.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT revision,CASE WHEN invalidated_at IS NULL THEN envelope_json END AS envelope_json FROM cloud_household_checkpoint WHERE household_id = ?",
    )
      .bind(id)
      .first<{ revision: number; envelope_json: string | null }>();
    return json({
      revision: row?.revision ?? 0,
      envelope: row?.envelope_json
        ? MasterPinHouseholdBackupSchema.parse(JSON.parse(row.envelope_json))
        : null,
    });
  }
  if (principal.method !== "device" || principal.purpose !== "login")
    throw new HttpError(403, "home_server_required");
  if (request.method === "PUT") {
    const parsed = EncryptedCheckpointWriteSchema.safeParse(
      await body(request, ENCRYPTED_CHECKPOINT_MAX_BYTES + 1024),
    );
    if (!parsed.success)
      throw new HttpError(400, "invalid_encrypted_checkpoint");
    if (parsed.data.envelope.envelope.datasetId !== id)
      throw new HttpError(409, "household_conflict");
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
            "INSERT OR IGNORE INTO cloud_household_checkpoint (household_id,revision,dataset_id,envelope_json,updated_at) VALUES (?,1,?,?,?) RETURNING revision",
          )
            .bind(id, id, serialized, now)
            .first<{ revision: number }>()
        : await env.DB.prepare(
            "UPDATE cloud_household_checkpoint SET revision=revision+1,envelope_json=?,invalidated_at=NULL,updated_at=? WHERE household_id=? AND revision=? RETURNING revision",
          )
            .bind(serialized, now, id, expected)
            .first<{ revision: number }>();
    if (!updated) throw new HttpError(409, "encrypted_checkpoint_conflict");
    return json(updated);
  }
  if (request.method === "DELETE") {
    const input = record(await body(request, 1024));
    if (
      input.confirm !== "delete-encrypted-checkpoint" ||
      typeof input.expectedRevision !== "number" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      throw new HttpError(400, "invalid_checkpoint_deletion");
    const result = await env.DB.prepare(
      "UPDATE cloud_household_checkpoint SET revision=revision+1,envelope_json=NULL,updated_at=? WHERE household_id=? AND revision=? RETURNING revision",
    )
      .bind(now, id, input.expectedRevision)
      .first<{ revision: number }>();
    if (!result) throw new HttpError(409, "encrypted_checkpoint_conflict");
    return json({ ...result, envelope: null });
  }
  throw new HttpError(405, "method_not_allowed");
}
