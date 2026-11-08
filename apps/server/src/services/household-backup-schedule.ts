import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { EncryptedHouseholdService } from "./encrypted-household.js";
import { householdPendingKey, householdReadyKey } from "./household-state.js";

export interface HouseholdBackupSchedule {
  enabled: boolean;
  intervalMinutes: number;
  cloudEnabled: boolean;
}
export const backupScheduleKey = (accountId: string) =>
  `household.backupSchedule.${accountId}`;
export const defaultBackupSchedule: HouseholdBackupSchedule = {
  enabled: true,
  intervalMinutes: 60,
  cloudEnabled: true,
};

/** Periodic portable files contain only ciphertext; PINs and vault keys are never written alongside them. */
export class HouseholdBackupScheduler {
  private readonly running = new Map<string, Promise<void>>();
  constructor(
    private readonly database: StreamerDatabase,
    private readonly household: EncryptedHouseholdService,
    private readonly dataDirectory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}
  settings(accountId: string) {
    return (
      this.database.settings.get<HouseholdBackupSchedule>(
        backupScheduleKey(accountId),
      ) ?? { ...defaultBackupSchedule }
    );
  }
  status(accountId: string) {
    return {
      ...this.settings(accountId),
      ...this.database.settings.get<{
        lastLocalBackupAt?: string;
        lastError?: string | null;
      }>(`household.backupStatus.${accountId}`),
    };
  }
  async tick(accountId: string): Promise<void> {
    const previous = this.running.get(accountId);
    if (previous) return previous;
    const run = this.saveDue(accountId).finally(() =>
      this.running.delete(accountId),
    );
    this.running.set(accountId, run);
    return run;
  }
  private async saveDue(accountId: string) {
    const schedule = this.settings(accountId),
      status = this.status(accountId);
    if (
      !schedule.enabled ||
      this.database.settings.get(householdReadyKey(accountId)) !== true ||
      this.database.settings.get(householdPendingKey(accountId))
    )
      return;
    if (
      status.lastLocalBackupAt &&
      Date.parse(status.lastLocalBackupAt) + schedule.intervalMinutes * 60_000 >
        this.now().getTime()
    )
      return;
    let temporary: string | undefined;
    try {
      const backup = await this.household.exportLocalBackup(accountId);
      const directory = resolve(
        this.dataDirectory,
        "household-backups",
        backup.envelope.datasetId,
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const filename = join(
        directory,
        `${this.now().toISOString().replace(/[:.]/g, "-")}-${backup.envelope.snapshotId}.json`,
      );
      temporary = filename + ".tmp";
      await writeFile(temporary, JSON.stringify(backup), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, filename);
      temporary = undefined;
      this.database.settings.set(`household.backupStatus.${accountId}`, {
        lastLocalBackupAt: this.now().toISOString(),
        lastError: null,
      });
    } catch {
      if (temporary)
        await rm(temporary, { force: true }).catch(() => undefined);
      this.database.settings.set(`household.backupStatus.${accountId}`, {
        lastLocalBackupAt: status.lastLocalBackupAt,
        lastError: "The scheduled local backup could not be saved.",
      });
    }
  }
  register(
    app: FastifyInstance,
    accountId: (request: FastifyRequest) => string,
    owner: (request: FastifyRequest) => boolean,
  ) {
    const denied = (reply: FastifyReply) =>
      reply.code(403).send({
        error: {
          code: "INSTALLATION_OWNER_REQUIRED",
          message: "Open household administration as its owner.",
        },
      });
    app.get("/api/v1/account/backup-schedule", async (request, reply) =>
      owner(request) ? this.status(accountId(request)) : denied(reply),
    );
    app.put("/api/v1/account/backup-schedule", async (request, reply) => {
      if (!owner(request)) return denied(reply);
      const value = request.body as Partial<HouseholdBackupSchedule> | null;
      if (
        !value ||
        typeof value.enabled !== "boolean" ||
        typeof value.cloudEnabled !== "boolean" ||
        !Number.isInteger(value.intervalMinutes) ||
        value.intervalMinutes! < 15 ||
        value.intervalMinutes! > 10_080
      )
        return reply.code(400).send({
          error: {
            code: "INVALID_BACKUP_SCHEDULE",
            message: "Choose a backup interval between 15 minutes and 7 days.",
          },
        });
      const id = accountId(request);
      this.database.settings.set(backupScheduleKey(id), {
        enabled: value.enabled,
        intervalMinutes: value.intervalMinutes,
        cloudEnabled: value.cloudEnabled,
      });
      return this.status(id);
    });
  }
}
