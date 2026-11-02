import { createHash, randomUUID } from "node:crypto";
import {
  ACCOUNT_SYNC_VERSION,
  AccountSyncOperationSchema,
  AccountSyncProfileSchema,
  AccountSyncPullSchema,
  AccountSyncPushResultSchema,
  AccountSyncTitleSchema,
  AppearancePreferencesSchema,
  PlaybackPreferencesSchema,
  type AccountSyncOperation,
  type AccountSyncTitle,
} from "@streamer-ai/contracts";
import type { Profile, StreamerDatabase } from "@streamer-ai/database";
import type { ProviderFetch } from "../integrations/tmdb-api-client.js";
import {
  D1AccountSyncTransport,
  SyncAuthenticationError,
  SyncCursorExpiredError,
  type AccountSyncTransport,
  type AccountSyncCredential,
  type SyncExchange,
} from "./account-sync-transport.js";
export type { AccountSyncCredential } from "./account-sync-transport.js";

export interface AccountSyncStatus {
  configured: boolean;
  status: "idle" | "pending" | "syncing" | "error";
  lastSyncedAt: string | null;
  error: string | null;
}
export interface AccountSyncOptions {
  getCredential(accountId: string): Promise<AccountSyncCredential | null>;
  prepareSync?(
    accountId: string,
    credential: AccountSyncCredential,
    expectedCloudUserId: string,
  ): Promise<"ok" | "auth" | "conflict" | "unavailable">;
  onAuthenticationFailure?(
    accountId: string,
    credential: AccountSyncCredential,
    expectedCloudUserId: string,
  ): Promise<boolean>;
  random?: () => number;
  transport?: AccountSyncTransport;
  /** Future storage bindings must choose a distinct provider/owner/dataset namespace. */
  namespace?: string;
}
interface Entry {
  operation: AccountSyncOperation;
  hash: string;
  localEntityId?: string;
}
interface Ledger {
  entries: Record<string, Entry>;
  initialized: boolean;
  cursor: string | null;
  lastSyncedAt: string | null;
  pausedProfiles?: string[];
  deferred?: AccountSyncOperation[];
}
interface CursorRecovery {
  remaining: number;
}

class SyncPausedError extends Error {}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const entryKey = (
  operation: Pick<AccountSyncOperation, "kind" | "profileId" | "entityId">,
): string =>
  JSON.stringify([operation.kind, operation.profileId, operation.entityId]);
const contentHash = (
  operation: Pick<AccountSyncOperation, "action" | "payload">,
): string => {
  // Metadata refreshes differ by installation and language. They do not change
  // a user's membership, history or progress and must not cause sync echoes.
  const payload =
    operation.payload !== null && "title" in operation.payload
      ? { ...operation.payload, title: operation.payload.title.id }
      : operation.payload;
  return hash([operation.action, payload]);
};
const accountKey = (id: string, namespace?: string): string =>
  `accountSync.${hash(namespace === undefined ? id : [namespace, id]).slice(0, 32)}`;
const outboxScope = (id: string, namespace?: string): string =>
  `account-sync:${hash(namespace === undefined ? id : [namespace, id])}`;
const progressId = (
  titleId: string,
  season: number | null,
  episode: number | null,
): string => hash([titleId, season, episode]);

/** Deterministic clock conflict resolution, including replay and a newly started viewing session. */
export function compareAccountSyncOperations(
  left: AccountSyncOperation,
  right: AccountSyncOperation,
): number {
  if (
    left.kind === "progress" &&
    right.kind === "progress" &&
    left.payload !== null &&
    right.payload !== null
  ) {
    const sessions =
      Date.parse(left.payload.sessionStartedAt) -
      Date.parse(right.payload.sessionStartedAt);
    if (sessions !== 0) return sessions;
  }
  return (
    Date.parse(left.updatedAt) - Date.parse(right.updatedAt) ||
    (left.id > right.id ? 1 : left.id < right.id ? -1 : 0)
  );
}

/** Local user-state replication. Provider secrets, PIN hashes and AI prompts never enter its outbox. */
export class AccountSyncService {
  readonly #running = new Map<string, Promise<AccountSyncStatus>>();
  readonly #states = new Map<string, AccountSyncStatus>();
  readonly #generations = new Map<string, number>();
  readonly #transport: AccountSyncTransport;

  constructor(
    private readonly database: StreamerDatabase,
    cloudBaseUrl: string,
    fetcher: ProviderFetch,
    private readonly now: () => Date,
    private readonly options: AccountSyncOptions,
  ) {
    this.#transport =
      options.transport ?? new D1AccountSyncTransport(cloudBaseUrl, fetcher);
  }

  private ledger(accountId: string): Ledger {
    return (
      this.database.settings.get<Ledger>(
        accountKey(accountId, this.options.namespace),
      ) ?? {
        entries: {},
        initialized: false,
        cursor: null,
        lastSyncedAt: null,
      }
    );
  }
  private save(accountId: string, ledger: Ledger): void {
    this.database.settings.set(
      accountKey(accountId, this.options.namespace),
      ledger,
    );
  }

  private enabled(accountId: string): boolean {
    return (
      !!this.database.accounts.get(accountId)?.cloudUserId &&
      this.database.settings.get<boolean>(
        `accountSyncPaused.${hash(accountId)}`,
      ) !== true
    );
  }

  async setEnabled(
    accountId: string,
    enabled: boolean,
  ): Promise<AccountSyncStatus> {
    this.database.accounts.getRequired(accountId);
    this.database.settings.set(
      `accountSyncPaused.${hash(accountId)}`,
      !enabled,
    );
    // A response already in flight is discarded once paused. Retain all offline work.
    await this.#running.get(accountId);
    this.#states.delete(accountId);
    return this.status(accountId);
  }

  profileStatus(accountId: string, profileId: string): { paused: boolean } {
    const profile = this.database.profiles.get(profileId);
    if (!profile || profile.accountId !== accountId)
      throw new Error("Profile unavailable.");
    return {
      paused: (this.ledger(accountId).pausedProfiles ?? []).includes(
        profile.syncId,
      ),
    };
  }

  async setProfilePaused(
    accountId: string,
    profileId: string,
    paused: boolean,
  ): Promise<{ paused: boolean }> {
    const profile = this.database.profiles.get(profileId);
    if (!profile || profile.accountId !== accountId)
      throw new Error("Profile unavailable.");
    if (!this.database.accounts.getRequired(accountId).cloudUserId)
      throw new Error("Connect an online account first.");
    this.database.transaction(() => {
      const ledger = this.ledger(accountId);
      const ids = new Set(ledger.pausedProfiles ?? []);
      if (paused) ids.add(profile.syncId);
      else ids.delete(profile.syncId);
      ledger.pausedProfiles = [...ids];
      this.save(accountId, ledger);
    });
    // A batch already in flight must finish before the pause is acknowledged.
    await this.#running.get(accountId);
    if (!paused && this.enabled(accountId)) void this.sync(accountId);
    return this.profileStatus(accountId, profileId);
  }

  /** Reset only the deleted cloud namespace; local profile data stays intact. */
  convertDeletedAccount(
    accountId: string,
    expectedCloudUserId: string,
  ): boolean {
    const converted = this.database.transaction(() => {
      if (
        !this.database.accounts.detachDeletedCloudUser(
          accountId,
          expectedCloudUserId,
        )
      )
        return false;
      this.database.syncOutbox.discardPendingForDevice(
        outboxScope(accountId, this.options.namespace),
      );
      this.database.settings.delete(
        accountKey(accountId, this.options.namespace),
      );
      this.database.settings.delete(`accountSyncPaused.${hash(accountId)}`);
      this.database.settings.set("account.localEntryUsed", true);
      const recovered =
        this.database.settings.get<string[]>("account.recoveredLocal") ?? [];
      this.database.settings.set("account.recoveredLocal", [
        ...new Set([...recovered, accountId]),
      ]);
      return true;
    });
    if (converted) {
      this.#generations.set(
        accountId,
        (this.#generations.get(accountId) ?? 0) + 1,
      );
      this.#states.delete(accountId);
    }
    return converted;
  }

  /** Keep the local baseline, outbox and pause state, but fetch the new owner's snapshot. */
  migrateMergedAccount(
    accountId: string,
    oldCloudUserId: string,
    newCloudUserId: string,
    identity: { name?: string; email?: string } = {},
  ): "updated" | "conflict" | "changed" {
    const result = this.database.transaction(() => {
      const reassigned = this.database.accounts.reassignMergedCloudUser(
        accountId,
        oldCloudUserId,
        newCloudUserId,
        identity,
      );
      if (reassigned !== "updated") return reassigned;
      const ledger = this.ledger(accountId);
      ledger.initialized = false;
      ledger.cursor = null;
      this.save(accountId, ledger);
      return reassigned;
    });
    if (result === "updated") {
      this.#generations.set(
        accountId,
        (this.#generations.get(accountId) ?? 0) + 1,
      );
      this.#states.delete(accountId);
    }
    return result;
  }

  markMergeConflict(accountId: string): void {
    this.#states.set(accountId, {
      configured: true,
      status: "error",
      lastSyncedAt: this.ledger(accountId).lastSyncedAt,
      error: "CLOUD_ACCOUNT_MERGE_CONFLICT",
    });
  }

  /** Apply the old account's missed transfer tombstones before acknowledging a merge. */
  applyMergeTombstones(
    accountId: string,
    expectedCloudUserId: string,
    operations: AccountSyncOperation[],
  ): boolean {
    return this.database.transaction(() => {
      if (
        this.database.accounts.get(accountId)?.cloudUserId !==
        expectedCloudUserId
      )
        return false;
      this.capture(accountId);
      const ledger = this.ledger(accountId);
      const paused = new Set(ledger.pausedProfiles ?? []);
      const deferredIds = new Set(
        (ledger.deferred ?? []).map((operation) => operation.id),
      );
      for (const operation of operations) {
        if (paused.has(operation.profileId)) {
          if (!deferredIds.has(operation.id)) {
            (ledger.deferred ??= []).push(operation);
            deferredIds.add(operation.id);
          }
        } else {
          this.apply(accountId, ledger, operation);
        }
      }
      this.save(accountId, ledger);
      return true;
    });
  }

  status(accountId: string): AccountSyncStatus {
    if (!this.enabled(accountId))
      return {
        configured: false,
        status: "idle",
        lastSyncedAt: this.ledger(accountId).lastSyncedAt,
        error: null,
      };
    const state = this.#states.get(accountId);
    if (state?.status === "syncing" || state?.status === "error")
      return { ...state };
    return {
      configured:
        state?.configured ??
        (this.database.accounts.get(accountId)?.cloudUserId !== null &&
          this.database.accounts.get(accountId) !== null),
      status:
        this.database.syncOutbox.countPendingForDevice(
          outboxScope(accountId, this.options.namespace),
        ) > 0
          ? "pending"
          : "idle",
      lastSyncedAt: this.ledger(accountId).lastSyncedAt,
      error: null,
    };
  }

  /** Persisted capture runs synchronously, so an offline change and its baseline cannot be separated. */
  capture(accountId: string): void {
    this.database.accounts.getRequired(accountId);
    this.database.transaction(() => {
      const ledger = this.ledger(accountId);
      const current = new Map<string, AccountSyncOperation>();
      const profiles = this.database.profiles.list(accountId);
      const syncIds = new Set(profiles.map((profile) => profile.syncId));
      const collect = (
        kind: AccountSyncOperation["kind"],
        profileId: string,
        entityId: string,
        payload: unknown,
        changedAt: string,
      ): void => {
        const operation = AccountSyncOperationSchema.parse({
          id: randomUUID(),
          kind,
          action: "upsert",
          profileId,
          entityId,
          payload,
          updatedAt: changedAt,
        });
        current.set(entryKey(operation), operation);
      };
      for (const profile of profiles) {
        collect(
          "profile",
          profile.syncId,
          profile.syncId,
          this.profilePayload(profile),
          profile.updatedAt,
        );
        for (const item of this.database.library.list(profile.id)) {
          collect(
            "library",
            profile.syncId,
            item.titleId,
            {
              title: this.title(item.titleId),
              membershipReason: item.membershipReason,
              state: item.state,
              progressPercent: item.progressPercent,
              lastPlayedAt: item.lastPlayedAt,
            },
            item.updatedAt,
          );
        }
        const historyMappings = new Map(
          Object.values(ledger.entries)
            .filter(
              (entry) =>
                entry.operation.kind === "history" &&
                entry.operation.profileId === profile.syncId &&
                entry.localEntityId !== undefined,
            )
            .map((entry) => [entry.localEntityId!, entry.operation.entityId]),
        );
        for (const item of this.database.history.listAll(profile.id)) {
          collect(
            "history",
            profile.syncId,
            historyMappings.get(item.id) ?? item.id,
            {
              title: this.title(item.titleId),
              eventType: item.eventType,
              episodeLabel: item.episodeLabel,
              progressPercent: item.progressPercent,
              occurredAt: item.occurredAt,
            },
            item.occurredAt,
          );
        }
        for (const item of this.database.playbackPositions.list(profile.id)) {
          const entityId = progressId(
            item.titleId,
            item.seasonNumber,
            item.episodeNumber,
          );
          const previous =
            ledger.entries[
              entryKey({
                kind: "progress",
                profileId: profile.syncId,
                entityId,
              })
            ]?.operation;
          const prior = previous?.kind === "progress" ? previous.payload : null;
          const unchanged =
            prior !== null &&
            prior !== undefined &&
            prior.positionSeconds === item.positionSeconds &&
            prior.durationSeconds === item.durationSeconds &&
            prior.progressPercent === item.progressPercent;
          const newSession =
            !prior ||
            (!unchanged &&
              (item.positionSeconds < prior.positionSeconds - 30 ||
                Date.parse(item.updatedAt) - Date.parse(previous!.updatedAt) >
                  1_800_000));
          collect(
            "progress",
            profile.syncId,
            entityId,
            {
              title: this.title(item.titleId),
              seasonNumber: item.seasonNumber,
              episodeNumber: item.episodeNumber,
              positionSeconds: item.positionSeconds,
              durationSeconds: item.durationSeconds,
              progressPercent: item.progressPercent,
              sessionId: newSession ? randomUUID() : prior!.sessionId,
              sessionStartedAt: newSession
                ? item.updatedAt
                : prior!.sessionStartedAt,
            },
            item.updatedAt,
          );
        }
      }
      for (const [key, operation] of current) {
        const previous = ledger.entries[key];
        if (previous?.hash === contentHash(operation)) continue;
        operation.updatedAt = new Date(
          Math.max(
            this.now().getTime(),
            Date.parse(operation.updatedAt),
            previous === undefined
              ? 0
              : Date.parse(previous.operation.updatedAt) + 1,
          ),
        ).toISOString();
        this.enqueue(accountId, operation);
        ledger.entries[key] = {
          operation,
          hash: contentHash(operation),
          ...(previous?.localEntityId === undefined
            ? {}
            : { localEntityId: previous.localEntityId }),
        };
      }
      for (const [key, previous] of Object.entries(ledger.entries)) {
        if (current.has(key) || previous.operation.action === "delete")
          continue;
        const operation = AccountSyncOperationSchema.parse({
          ...previous.operation,
          id: randomUUID(),
          action: "delete",
          payload: null,
          updatedAt: new Date(
            Math.max(
              this.now().getTime(),
              Date.parse(previous.operation.updatedAt) + 1,
            ),
          ).toISOString(),
        });
        // Deleting a profile already deletes its child state in the cloud.
        if (operation.kind === "profile" || syncIds.has(operation.profileId))
          this.enqueue(accountId, operation);
        ledger.entries[key] = {
          ...previous,
          operation,
          hash: contentHash(operation),
        };
      }
      this.save(accountId, ledger);
      this.database.accounts.markSyncCaptured(accountId);
    });
  }

  sync(accountId: string): Promise<AccountSyncStatus> {
    const running = this.#running.get(accountId);
    if (running !== undefined) return running;
    const work = this.run(accountId).finally(() => {
      this.#running.delete(accountId);
    });
    this.#running.set(accountId, work);
    return work;
  }

  private async run(accountId: string): Promise<AccountSyncStatus> {
    if (!this.enabled(accountId)) return this.status(accountId);
    let expectedCloudUserId =
      this.database.accounts.get(accountId)?.cloudUserId;
    let generation = this.#generations.get(accountId) ?? 0;
    let credential: AccountSyncCredential | null;
    try {
      credential = await this.options.getCredential(accountId);
    } catch {
      credential = null;
    }
    if ((this.#generations.get(accountId) ?? 0) !== generation)
      return this.status(accountId);
    if (credential === null || !this.enabled(accountId)) {
      const state: AccountSyncStatus = {
        configured: false,
        status: "idle",
        lastSyncedAt: this.ledger(accountId).lastSyncedAt,
        error: null,
      };
      this.#states.set(accountId, state);
      return state;
    }
    this.#states.set(accountId, {
      ...this.status(accountId),
      configured: true,
      status: "syncing",
      error: null,
    });
    try {
      if (this.options.prepareSync && expectedCloudUserId) {
        const ready = await this.options.prepareSync(
          accountId,
          credential,
          expectedCloudUserId,
        );
        // A verified merge resets the generation before acknowledgement. If
        // acknowledgement fails, report the failure against the new local state.
        if (ready !== "ok" && this.enabled(accountId))
          generation = this.#generations.get(accountId) ?? 0;
        if (ready === "auth")
          throw new SyncAuthenticationError("Cloud credential is unavailable.");
        if (ready === "conflict") {
          this.markMergeConflict(accountId);
          return this.status(accountId);
        }
        if (ready !== "ok") throw new Error("Cloud identity is unavailable.");
        expectedCloudUserId =
          this.database.accounts.get(accountId)?.cloudUserId;
        generation = this.#generations.get(accountId) ?? 0;
        if (!expectedCloudUserId || !this.enabled(accountId))
          throw new SyncPausedError();
      }
      // Share the budget across both pulls so a broken endpoint cannot restart
      // snapshots indefinitely, including after the outgoing batch succeeds.
      const recovery: CursorRecovery = { remaining: 2 };
      this.capture(accountId);
      this.database.transaction(() => {
        const ledger = this.ledger(accountId);
        const paused = new Set(ledger.pausedProfiles ?? []);
        const remaining: AccountSyncOperation[] = [];
        for (const operation of ledger.deferred ?? []) {
          if (paused.has(operation.profileId)) remaining.push(operation);
          else this.apply(accountId, ledger, operation);
        }
        ledger.deferred = remaining;
        this.save(accountId, ledger);
      });
      await this.pull(accountId, credential, recovery, generation);
      // Account/profile membership may have changed while this installation was offline.
      this.capture(accountId);
      for (let batch = 0; batch < 100; batch++) {
        const pending =
          this.database.syncOutbox.listPendingForDevice<AccountSyncOperation>(
            outboxScope(accountId, this.options.namespace),
            10,
            this.ledger(accountId).pausedProfiles ?? [],
          );
        if (pending.length === 0) break;
        const operations = pending.map((item) =>
          AccountSyncOperationSchema.parse(item.payload),
        );
        let response: unknown;
        try {
          response = await this.request(
            accountId,
            credential,
            {
              kind: "push",
              operations,
            },
            generation,
          );
        } catch (error) {
          if (error instanceof SyncPausedError) throw error;
          for (const item of pending) {
            const baseDelay = Math.min(
              900_000,
              30_000 * 2 ** Math.min(item.attempts, 5),
            );
            const jitter = Math.max(
              0,
              Math.min(1, (this.options.random ?? Math.random)()),
            );
            const delay = Math.min(
              900_000,
              Math.floor(baseDelay * (1 + jitter * 0.25)),
            );
            this.database.syncOutbox.markFailed(
              item.opId,
              "CLOUD_SYNC_UNAVAILABLE",
              new Date(this.now().getTime() + delay).toISOString(),
            );
          }
          throw error;
        }
        const accepted =
          AccountSyncPushResultSchema.parse(response).acceptedIds;
        const sent = new Set(operations.map((operation) => operation.id));
        if (accepted.some((id) => !sent.has(id)))
          throw new Error("Invalid synchronization acknowledgement.");
        this.database.syncOutbox.markDelivered(accepted);
        if (accepted.length !== operations.length) break;
      }
      await this.pull(accountId, credential, recovery, generation);
      const ledger = this.ledger(accountId);
      ledger.lastSyncedAt = this.now().toISOString();
      this.save(accountId, ledger);
      const state: AccountSyncStatus = {
        configured: true,
        status:
          this.database.syncOutbox.countPendingForDevice(
            outboxScope(accountId, this.options.namespace),
          ) > 0
            ? "pending"
            : "idle",
        lastSyncedAt: ledger.lastSyncedAt,
        error: null,
      };
      this.#states.set(accountId, state);
      return state;
    } catch (error) {
      if ((this.#generations.get(accountId) ?? 0) !== generation) {
        this.#states.delete(accountId);
        return this.status(accountId);
      }
      if (error instanceof SyncPausedError) {
        this.#states.delete(accountId);
        return this.status(accountId);
      }
      if (
        error instanceof SyncAuthenticationError &&
        (this.#generations.get(accountId) ?? 0) === generation &&
        expectedCloudUserId &&
        (await this.options.onAuthenticationFailure?.(
          accountId,
          credential,
          expectedCloudUserId,
        ))
      ) {
        this.#states.delete(accountId);
        return this.status(accountId);
      }
      const state: AccountSyncStatus = {
        configured: true,
        status: "error",
        lastSyncedAt: this.ledger(accountId).lastSyncedAt,
        error: "CLOUD_SYNC_UNAVAILABLE",
      };
      this.#states.set(accountId, state);
      return state;
    }
  }

  private async request(
    accountId: string,
    credential: AccountSyncCredential,
    operation: SyncExchange,
    generation: number,
  ): Promise<unknown> {
    if (
      !this.enabled(accountId) ||
      (this.#generations.get(accountId) ?? 0) !== generation
    )
      throw new SyncPausedError();
    const result = await this.#transport.exchange(credential, operation);
    if (
      !this.enabled(accountId) ||
      (this.#generations.get(accountId) ?? 0) !== generation
    )
      throw new SyncPausedError();
    return result;
  }

  private async pull(
    accountId: string,
    credential: AccountSyncCredential,
    recovery: CursorRecovery,
    generation: number,
  ): Promise<void> {
    for (let page = 0; page < 1_000; page++) {
      const ledger = this.ledger(accountId);
      let response: unknown;
      try {
        response = await this.request(
          accountId,
          credential,
          {
            kind: ledger.initialized ? "delta" : "snapshot",
            cursor: ledger.cursor,
          },
          generation,
        );
      } catch (error) {
        if (
          !(error instanceof SyncCursorExpiredError) ||
          recovery.remaining === 0
        )
          throw error;
        recovery.remaining--;
        this.database.transaction(() => {
          // Keep the local baseline and deferred outbox. Capturing again also
          // preserves edits committed while the expired request was in flight.
          this.capture(accountId);
          const latest = this.ledger(accountId);
          latest.initialized = false;
          latest.cursor = null;
          this.save(accountId, latest);
        });
        continue;
      }
      const result = AccountSyncPullSchema.parse(response);
      if (result.hasMore && result.cursor === ledger.cursor)
        throw new Error("Cloud sync cursor did not advance.");
      this.database.transaction(() => {
        // A local route may commit while HTTP is pending and before its response
        // hook runs. Journal it before applying remote state in this transaction.
        this.capture(accountId);
        const latest = this.ledger(accountId);
        const paused = new Set(latest.pausedProfiles ?? []);
        for (const operation of result.operations) {
          if (paused.has(operation.profileId)) {
            (latest.deferred ??= []).push(operation);
          } else {
            this.apply(accountId, latest, operation);
          }
        }
        latest.cursor = result.cursor;
        if (!result.hasMore) latest.initialized = true;
        this.save(accountId, latest);
      });
      if (!result.hasMore) return;
    }
    throw new Error("Cloud sync exceeded pagination limit.");
  }

  private enqueue(accountId: string, operation: AccountSyncOperation): void {
    this.database.syncOutbox.enqueue({
      opId: operation.id,
      deviceId: outboxScope(accountId, this.options.namespace),
      profileId: operation.profileId,
      entityType: operation.kind,
      entityId: operation.entityId,
      schemaVersion: ACCOUNT_SYNC_VERSION,
      hlc: operation.updatedAt,
      payload: operation,
      tombstone: operation.action === "delete",
    });
  }

  private profilePayload(profile: Profile): unknown {
    const playback = PlaybackPreferencesSchema.safeParse(
      profile.preferences.playback,
    );
    const { audioOutputDeviceId: _device, ...safePlayback } = playback.success
      ? playback.data
      : PlaybackPreferencesSchema.parse({});
    const appearance = AppearancePreferencesSchema.safeParse(
      profile.preferences.appearance,
    );
    return AccountSyncProfileSchema.parse({
      name: profile.name,
      locale: profile.locale,
      genres: Array.isArray(profile.preferences.genres)
        ? profile.preferences.genres
        : [],
      playback: safePlayback,
      appearance: appearance.success
        ? appearance.data
        : AppearancePreferencesSchema.parse({}),
      onboardingComplete:
        profile.preferences.onboardingComplete === true ||
        (profile.id === "default" &&
          profile.preferences.onboardingComplete !== false &&
          this.database.settings.get("setup.completed") === true),
    });
  }

  private title(id: string): AccountSyncTitle {
    const title = this.database.titles.get(id);
    if (title === null) throw new Error("Cannot synchronize a missing title.");
    return AccountSyncTitleSchema.parse({
      id: title.id,
      kind: title.kind,
      title: title.title,
      originalTitle: title.originalTitle,
      year: title.year,
      synopsis: title.synopsis.slice(0, 1500),
      genres: title.genres,
      metadataProvider: title.metadataProvider,
      metadataValidatedAt: title.metadataValidatedAt,
    });
  }

  private materialize(title: AccountSyncTitle): void {
    const existing = this.database.titles.get(title.id);
    if (existing !== null) return;
    const provenance = {
      retrievedAt: title.metadataValidatedAt,
      connectorVersion: "account-sync-v1",
      confidence: 0.5,
      validationState: "unverified" as const,
      expiresAt: null,
    };
    this.database.titles.upsert({
      ...title,
      posterUrl: null,
      backdropUrl: null,
      accentColor: "#334455",
      ratings: [],
      availability: "unknown",
      availabilityProvider: "cloudflare-sync",
      availabilityCheckedAt: title.metadataValidatedAt,
      formats: [],
      sources: [],
      seriesCoverage: null,
      metadataProvenance: { ...provenance, providerId: title.metadataProvider },
      availabilityProvenance: { ...provenance, providerId: "cloudflare-sync" },
    });
  }

  private discardBootstrap(
    accountId: string,
    incomingProfileId: string,
    ledger: Ledger,
  ): void {
    const local = this.database.profiles
      .list(accountId)
      .find(
        (item) =>
          item.syncId !== incomingProfileId &&
          item.name === "Viewer" &&
          Object.entries(item.preferences).every(
            ([key, value]) => key === "onboardingComplete" && value === false,
          ),
      );
    if (
      local === undefined ||
      (local.id === "default" &&
        this.database.settings.get("setup.completed") === true) ||
      this.database.library.list(local.id).length > 0 ||
      this.database.history.listAll(local.id).length > 0 ||
      this.database.playbackPositions.list(local.id).length > 0 ||
      local.pinEnabled
    )
      return;
    this.database.syncOutbox.discardPendingForProfile(
      outboxScope(accountId, this.options.namespace),
      local.syncId,
    );
    this.database.profiles.delete(local.id);
    for (const [key, entry] of Object.entries(ledger.entries))
      if (entry.operation.profileId === local.syncId)
        delete ledger.entries[key];
  }

  private apply(
    accountId: string,
    ledger: Ledger,
    operation: AccountSyncOperation,
  ): void {
    const key = entryKey(operation);
    const previous = ledger.entries[key];
    const isProfileDeletion =
      operation.kind === "profile" && operation.action === "delete";
    if (
      !isProfileDeletion &&
      previous !== undefined &&
      compareAccountSyncOperations(operation, previous.operation) <= 0
    )
      return;
    let profile = this.database.profiles.getBySyncId(operation.profileId);
    if (profile !== null && profile.accountId !== accountId) {
      if (operation.kind === "profile" && operation.payload !== null) {
        // Receiving this profile from the target account's authenticated stream
        // proves the cloud transfer completed. Target sync can beat source sync.
        this.discardBootstrap(accountId, operation.profileId, ledger);
        // The old local ID also names vault keys. Never hand those credentials
        // to a different owner; import the cloud state using a fresh local ID.
        this.database.profiles.delete(profile.id);
        profile = null;
      } else if (!isProfileDeletion) return;
    }
    if (operation.kind === "profile") {
      if (operation.payload === null) {
        if (profile !== null && profile.accountId === accountId)
          this.database.profiles.delete(profile.id);
        this.database.syncOutbox.discardPendingForProfile(
          outboxScope(accountId, this.options.namespace),
          operation.profileId,
        );
        for (const [entryId, entry] of Object.entries(ledger.entries)) {
          if (
            entry.operation.profileId !== operation.profileId ||
            entryId === key
          )
            continue;
          const deleted = AccountSyncOperationSchema.parse({
            ...entry.operation,
            action: "delete",
            payload: null,
            updatedAt: operation.updatedAt,
            id: operation.id,
          });
          ledger.entries[entryId] = {
            ...entry,
            operation: deleted,
            hash: contentHash(deleted),
          };
        }
      } else {
        if (profile === null) {
          this.discardBootstrap(accountId, operation.profileId, ledger);
          profile = this.database.profiles.create({
            id: `sync:${randomUUID()}`,
            syncId: operation.profileId,
            accountId,
            name: operation.payload.name,
            locale: operation.payload.locale,
          });
        }
        const currentPlayback = PlaybackPreferencesSchema.safeParse(
          profile.preferences.playback,
        );
        this.database.profiles.update(profile.id, {
          name: operation.payload.name,
          locale: operation.payload.locale,
          preferences: {
            ...profile.preferences,
            genres: operation.payload.genres,
            playback: {
              ...operation.payload.playback,
              audioOutputDeviceId: currentPlayback.success
                ? currentPlayback.data.audioOutputDeviceId
                : null,
            },
            appearance: operation.payload.appearance,
            onboardingComplete: operation.payload.onboardingComplete,
          },
        });
      }
    } else {
      if (profile === null) return; // A profile tombstone makes delayed child operations powerless.
      if (operation.kind === "library") {
        if (operation.payload === null)
          this.database.library.remove(profile.id, operation.entityId);
        else {
          this.materialize(operation.payload.title);
          this.database.library.upsert({
            profileId: profile.id,
            titleId: operation.payload.title.id,
            membershipReason: operation.payload.membershipReason,
            state: operation.payload.state,
            progressPercent: operation.payload.progressPercent,
            lastPlayedAt: operation.payload.lastPlayedAt,
          });
        }
      } else if (operation.kind === "history") {
        // Cloud event IDs are unique within a profile; SQLite's legacy event
        // primary key is installation-wide. Namespace imported events to prevent
        // one profile's legitimate ID from colliding with another profile.
        const ownsOriginalId =
          operation.entityId.length <= 120 &&
          this.database.history.get(profile.id, operation.entityId) !== null;
        const localId =
          previous?.localEntityId ??
          (ownsOriginalId
            ? operation.entityId
            : `sync:${hash([operation.profileId, operation.entityId])}`);
        this.database.history.remove(profile.id, localId);
        if (operation.payload !== null) {
          this.materialize(operation.payload.title);
          this.database.history.append({
            id: localId,
            profileId: profile.id,
            titleId: operation.payload.title.id,
            eventType: operation.payload.eventType,
            episodeLabel: operation.payload.episodeLabel,
            progressPercent: operation.payload.progressPercent,
            occurredAt: operation.payload.occurredAt,
          });
        }
        ledger.entries[key] = {
          operation,
          hash: contentHash(operation),
          localEntityId: localId,
        };
        return;
      } else if (operation.kind === "progress") {
        if (operation.payload === null) {
          const position = this.database.playbackPositions
            .list(profile.id)
            .find(
              (item) =>
                progressId(
                  item.titleId,
                  item.seasonNumber,
                  item.episodeNumber,
                ) === operation.entityId,
            );
          if (position !== undefined)
            this.database.playbackPositions.remove(
              profile.id,
              position.titleId,
              position.seasonNumber,
              position.episodeNumber,
            );
        } else {
          this.materialize(operation.payload.title);
          this.database.playbackPositions.upsert({
            profileId: profile.id,
            titleId: operation.payload.title.id,
            seasonNumber: operation.payload.seasonNumber,
            episodeNumber: operation.payload.episodeNumber,
            positionSeconds: operation.payload.positionSeconds,
            durationSeconds: operation.payload.durationSeconds,
            progressPercent: operation.payload.progressPercent,
            updatedAt: operation.updatedAt,
          });
        }
      }
    }
    ledger.entries[key] = { operation, hash: contentHash(operation) };
  }
}
