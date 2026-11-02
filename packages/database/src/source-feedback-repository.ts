import { createHash } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  SourceFeedbackSchema,
  type SourceFeedback,
} from "@streamer-ai/contracts";
import type { Clock } from "./types.js";

export function sourceFeedbackId(value: Omit<SourceFeedback, "vote">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        value.profileId,
        value.titleId,
        value.providerId,
        value.candidateId,
        value.seasonNumber,
        value.episodeNumber,
      ]),
    )
    .digest("hex");
}

export class SourceFeedbackRepository {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}
  list(
    accountId: string,
    titleId?: string,
  ): Array<{ id: string; payload: SourceFeedback; updatedAt: string }> {
    const rows = this.db
      .prepare(
        `SELECT entity_id, payload_json, updated_at FROM source_feedback WHERE account_id = ? ${titleId === undefined ? "" : "AND json_extract(payload_json, '$.titleId') = ?"} ORDER BY entity_id`,
      )
      .all(
        ...(titleId === undefined ? [accountId] : [accountId, titleId]),
      ) as Array<{
      entity_id: string;
      payload_json: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.entity_id,
      payload: SourceFeedbackSchema.parse(JSON.parse(row.payload_json)),
      updatedAt: row.updated_at,
    }));
  }
  set(
    accountId: string,
    input: SourceFeedback,
    updatedAt = this.clock().toISOString(),
  ): void {
    const payload = SourceFeedbackSchema.parse(input);
    this.db
      .prepare(
        `INSERT INTO source_feedback (account_id, entity_id, payload_json, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(account_id, entity_id) DO UPDATE SET
      payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
      )
      .run(
        accountId,
        sourceFeedbackId(payload),
        JSON.stringify(payload),
        updatedAt,
      );
  }
  remove(accountId: string, entityId: string): void {
    this.db
      .prepare(
        "DELETE FROM source_feedback WHERE account_id = ? AND entity_id = ?",
      )
      .run(accountId, entityId);
  }
}
