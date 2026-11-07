import { createHash } from "node:crypto";
import type { StreamerDatabase } from "@streamer-ai/database";
import type { AccountSyncCredential } from "./account-sync-transport.js";
import { EncryptedHouseholdService } from "./encrypted-household.js";
import { EncryptedCheckpointTransport } from "./encrypted-sync-transport.js";

interface BackupState {
  revision: number;
  lastSavedAt: string;
  datasetId: string;
}

const key = (accountId: string) =>
  `encryptedHouseholdAutoBackup.${createHash("sha256").update(accountId).digest("hex")}`;

/** The cloud receives only a Master PIN encrypted snapshot, never the PIN. */
export class AutomaticHouseholdBackup {
  private readonly running = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly database: StreamerDatabase,
    private readonly household: EncryptedHouseholdService,
    private readonly cloud: EncryptedCheckpointTransport,
    private readonly getCredential: (
      accountId: string,
    ) => Promise<AccountSyncCredential | null>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  status(accountId: string) {
    const saved = this.database.settings.get<BackupState>(key(accountId));
    return {
      cloudBackup: {
        status: this.running.has(accountId)
          ? "saving"
          : this.errors.has(accountId)
            ? "error"
            : saved && !this.dirty.has(accountId)
              ? "current"
              : "pending",
        lastSavedAt: saved?.lastSavedAt ?? null,
        error: this.errors.get(accountId) ?? null,
      },
    };
  }

  markDirty(accountId: string): void {
    this.dirty.add(accountId);
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
  }

  adopt(accountId: string, revision: number, datasetId: string): void {
    this.database.settings.set(key(accountId), {
      revision,
      datasetId,
      lastSavedAt: this.now().toISOString(),
    } satisfies BackupState);
    this.errors.delete(accountId);
    this.dirty.delete(accountId);
  }

  sync(accountId: string): Promise<void> {
    const existing = this.running.get(accountId);
    if (existing) return existing;
    const run = this.perform(accountId).finally(() => {
      this.running.delete(accountId);
    });
    this.running.set(accountId, run);
    return run;
  }

  private async perform(accountId: string): Promise<void> {
    const generation = this.generations.get(accountId) ?? 0;
    try {
      const credential = await this.getCredential(accountId);
      if (!credential) throw new Error("Cloud account is not connected.");
      const remote = await this.cloud.read(credential);
      const previous = this.database.settings.get<BackupState>(key(accountId));
      if (remote.revision !== (previous?.revision ?? 0))
        throw new Error(
          "Cloud backup changed on another server. Review that copy before replacing it.",
        );
      if (previous && !this.dirty.has(accountId)) {
        this.errors.delete(accountId);
        return;
      }
      const backup = await this.household.exportLocalBackup(accountId);
      const uploaded = await this.cloud.write(
        credential,
        remote.revision,
        backup,
      );
      this.database.settings.set(key(accountId), {
        revision: uploaded.revision,
        lastSavedAt: this.now().toISOString(),
        datasetId: backup.envelope.datasetId,
      } satisfies BackupState);
      this.errors.delete(accountId);
      if (this.generations.get(accountId) === generation)
        this.dirty.delete(accountId);
    } catch (error) {
      this.errors.set(
        accountId,
        error instanceof Error ? error.message : "Cloud backup is unavailable.",
      );
      throw error;
    }
  }
}
