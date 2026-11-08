import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AccountSyncTitleSchema,
  EncryptedHouseholdSnapshotSchema,
  PortableCredentialKeySchema,
  type AccountSyncTitle,
  type EncryptedHouseholdEnvelope,
  type EncryptedHouseholdSnapshot,
} from "@streamer-ai/contracts";
import type { StreamerDatabase } from "@streamer-ai/database";
import {
  accountSecretKey,
  ACCOUNT_PROVIDER_SECRET_KEYS,
  migrateAccountIntegrations,
} from "../stores/account-integrations.js";
import type { SecretStore } from "../stores/secret-store.js";
import { MediaSourcePreferenceStore } from "./media-source-preferences.js";
import { manualAgentSettingKey } from "../integrations/manual-agent-config.js";
import { MasterPinService } from "./master-pin.js";
import { protectHouseholdWithMasterPin } from "./master-pin-household-backup.js";
import { householdId, householdIdKey } from "./household-state.js";
import { PreferredSourceStore } from "./preferred-source-store.js";
import { TitlePriorityStore } from "./title-priority-store.js";
import {
  EncryptedHouseholdError,
  openHouseholdSnapshot,
  recoveryKey,
  sealHouseholdSnapshot,
  wrapHouseholdKey,
} from "./encrypted-household-crypto.js";

export { EncryptedHouseholdError } from "./encrypted-household-crypto.js";
const hash = (id: string): string =>
  createHash("sha256").update(id).digest("hex");
export const encryptedHouseholdSettingKey = (accountId: string): string =>
  `encryptedHousehold.${hash(accountId)}`;
const localKey = (accountId: string): string =>
  accountSecretKey(accountId, "encrypted.household.key");
const journalKey = (accountId: string): string =>
  `encryptedHouseholdImport.${hash(accountId)}`;
const installedKey = (accountId: string): string =>
  `encryptedHouseholdInstalled.${hash(accountId)}`;

interface State {
  version: 1;
  datasetId: string;
  keyVersion: number;
  recoveryVersion: number;
  recovery: EncryptedHouseholdEnvelope["recovery"];
  sequence: number;
  lastExportAt: string | null;
}
export interface EncryptedHouseholdStatus {
  enabled: boolean;
  datasetId: string | null;
  keyVersion: number | null;
  recoveryVersion: number | null;
  lastExportAt: string | null;
  mode: "encrypted-checkpoints";
  approvalAvailable: false;
  automaticMergeAvailable: false;
}
export interface HouseholdImportResult {
  profileIds: string[];
  credentials: string[];
  limitations: string[];
}
interface ImportJournal {
  snapshotId: string;
  keys: string[];
}
interface Installed extends HouseholdImportResult {
  snapshotId: string;
}
export interface EncryptedHouseholdOptions {
  /** Pause legacy synchronization and wait for its outstanding request before enabling. */
  beforeEnable?(accountId: string): Promise<void>;
}

const limitations = [
  "Catalog caches and installation-specific source availability are refreshed on the destination server.",
  "Local paths, audio output devices, inference endpoints/models, caches, media files and AI models require setup on the destination.",
  "Cloud sessions, device pairings, server identity and local vault/master keys are excluded; pair clients again.",
  "Imported provider credentials require validation when next used; expired or device-bound tokens may require sign-in.",
];

/**
 * Portable encrypted recovery, deliberately separate from legacy plaintext sync.
 * Only encrypted envelopes may leave this service. No account approval protocol
 * is claimed here; that requires the independently reviewed exchange in the plan.
 */
export class EncryptedHouseholdService {
  readonly #pending = new Map<string, Promise<unknown>>();

  constructor(
    private readonly database: StreamerDatabase,
    private readonly secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
    private readonly options: EncryptedHouseholdOptions = {},
  ) {}

  private async exclusive<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#pending.get(accountId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    this.#pending.set(accountId, pending);
    try {
      return await pending;
    } finally {
      if (this.#pending.get(accountId) === pending)
        this.#pending.delete(accountId);
    }
  }

  isEnabled(accountId: string): boolean {
    return (
      this.database.settings.get(encryptedHouseholdSettingKey(accountId)) !==
      null
    );
  }

  status(accountId: string): EncryptedHouseholdStatus {
    this.database.accounts.getRequired(accountId);
    const state = this.database.settings.get<State>(
      encryptedHouseholdSettingKey(accountId),
    );
    return {
      enabled: state !== null,
      datasetId: state?.datasetId ?? null,
      keyVersion: state?.keyVersion ?? null,
      recoveryVersion: state?.recoveryVersion ?? null,
      lastExportAt: state?.lastExportAt ?? null,
      mode: "encrypted-checkpoints",
      approvalAvailable: false,
      automaticMergeAvailable: false,
    };
  }

  private state(accountId: string): State {
    this.database.accounts.getRequired(accountId);
    const state = this.database.settings.get<State>(
      encryptedHouseholdSettingKey(accountId),
    );
    if (!state)
      throw new EncryptedHouseholdError("ENCRYPTED_HOUSEHOLD_NOT_ENABLED");
    return state;
  }

  private async ready(): Promise<void> {
    if (!(await this.secrets.isReady()))
      throw new EncryptedHouseholdError("SECRET_STORE_UNAVAILABLE");
    await migrateAccountIntegrations(this.database, this.secrets);
  }

  private async enable(accountId: string): Promise<void> {
    this.database.accounts.getRequired(accountId);
  }

  async activate(
    accountId: string,
  ): Promise<{ recoveryKey: string; status: EncryptedHouseholdStatus }> {
    return this.exclusive(accountId, async () => {
      await this.ready();
      if (this.isEnabled(accountId))
        throw new EncryptedHouseholdError(
          "ENCRYPTED_HOUSEHOLD_ALREADY_ENABLED",
        );
      await this.enable(accountId);
      const dataKey = randomBytes(32);
      const key = recoveryKey();
      const context = {
        datasetId: householdId(this.database, accountId),
        keyVersion: 1,
        recoveryVersion: 1,
      };
      try {
        const recovery = wrapHouseholdKey(context, dataKey, key);
        await this.secrets.set(
          localKey(accountId),
          dataKey.toString("base64url"),
        );
        this.database.settings.set(encryptedHouseholdSettingKey(accountId), {
          version: 1,
          ...context,
          recovery,
          sequence: 0,
          lastExportAt: null,
        } satisfies State);
        return { recoveryKey: key, status: this.status(accountId) };
      } finally {
        dataKey.fill(0);
      }
    });
  }

  private async dataKey(accountId: string): Promise<Buffer> {
    const value = await this.secrets.get(localKey(accountId));
    if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value))
      throw new EncryptedHouseholdError("HOUSEHOLD_KEY_UNAVAILABLE");
    const key = Buffer.from(value, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== value)
      throw new EncryptedHouseholdError("HOUSEHOLD_KEY_UNAVAILABLE");
    return key;
  }

  private async credentials(
    accountId: string,
  ): Promise<EncryptedHouseholdSnapshot["credentials"]> {
    const result: EncryptedHouseholdSnapshot["credentials"] = [];
    for (const providerKey of ACCOUNT_PROVIDER_SECRET_KEYS) {
      const key = PortableCredentialKeySchema.parse(providerKey);
      const value = await this.secrets.get(accountSecretKey(accountId, key));
      if (value !== undefined) result.push({ key, value });
    }
    return result;
  }

  private capture(
    accountId: string,
    datasetId: string,
    credentials: EncryptedHouseholdSnapshot["credentials"],
  ): EncryptedHouseholdSnapshot {
    return this.database.transaction(() => {
      const titleIds = new Set<string>();
      const media = new MediaSourcePreferenceStore(this.database);
      const profiles = this.database.profiles.list(accountId).map((profile) => {
        const sourceSelections = new PreferredSourceStore(
          this.database,
        ).exportProfile(profile.id);
        const titlePriorities = new TitlePriorityStore(
          this.database,
          this.now,
        ).exportProfile(profile.id);
        for (const item of [...sourceSelections, ...titlePriorities])
          if (this.database.titles.get(item.titleId))
            titleIds.add(item.titleId);
        const library = this.database.library
          .list(profile.id)
          .map(
            ({
              titleId,
              membershipReason,
              state,
              progressPercent,
              lastPlayedAt,
            }) => ({
              titleId,
              membershipReason,
              state,
              progressPercent,
              lastPlayedAt,
            }),
          );
        const history = this.database.history
          .listAll(profile.id)
          .map(({ id, profileId: _profile, ...event }) => ({
            sourceId: id,
            ...event,
          }));
        const progress = this.database.playbackPositions
          .list(profile.id)
          .map(({ profileId: _profile, ...position }) => position);
        for (const item of [...library, ...history, ...progress])
          titleIds.add(item.titleId);
        const preferences = structuredClone(profile.preferences);
        const playback = preferences.playback;
        if (
          playback &&
          typeof playback === "object" &&
          !Array.isArray(playback)
        ) {
          delete (playback as Record<string, unknown>).audioOutputDeviceId;
        }
        return {
          sourceId: profile.id,
          syncId: profile.syncId,
          name: profile.name,
          locale: profile.locale,
          preferences,
          pinHash: this.database.profiles.getPinRecord(profile.id).hash,
          mediaSourcePreferences: media.get(profile.id),
          integrations: this.database.integrations
            .list(profile.id)
            .filter(
              (item) => !["cloudflare-sync", "google-drive"].includes(item.id),
            )
            .map(({ id, enabled }) => ({ id, enabled })),
          library,
          history,
          progress,
          sourceSelections,
          titlePriorities,
          conversations: this.database.discoverySessions
            .listAllForProfile(profile.id)
            .map((session) => ({
              sourceId: session.id,
              mode: session.mode,
              state: session.state,
              context: session.context,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              completedAt: session.completedAt,
              messages: this.database.discoverySessions
                .listMessages(session.id)
                .map(({ role, content, requestId, createdAt }) => ({
                  role,
                  content,
                  requestId,
                  createdAt,
                })),
            })),
        };
      });
      const sourceFeedback = this.database.sourceFeedback
        .list(accountId)
        .map(({ payload, updatedAt }) => ({ payload, updatedAt }));
      const titles = [...titleIds].map((id) => {
        const title = this.database.titles.get(id);
        if (!title)
          throw new EncryptedHouseholdError("HOUSEHOLD_TITLE_MISSING");
        return AccountSyncTitleSchema.parse({
          id,
          kind: title.kind,
          title: title.title,
          originalTitle: title.originalTitle,
          year: title.year,
          synopsis: title.synopsis.slice(0, 1500),
          genres: title.genres,
          metadataProvider: title.metadataProvider,
          metadataValidatedAt: title.metadataValidatedAt,
        });
      });
      const parsed = EncryptedHouseholdSnapshotSchema.safeParse({
        version: 1,
        datasetId,
        profiles,
        titles,
        credentials,
        sourceFeedback,
        limitations,
      });
      if (!parsed.success)
        throw new EncryptedHouseholdError("UNSUPPORTED_HOUSEHOLD_DATA");
      return parsed.data;
    });
  }

  async export(accountId: string): Promise<EncryptedHouseholdEnvelope> {
    return this.exclusive(accountId, async () => {
      await this.ready();
      const state = this.state(accountId);
      const credentials = await this.credentials(accountId);
      const snapshot = this.capture(accountId, state.datasetId, credentials);
      // A provider credential mutation during the database snapshot must not
      // produce a falsely consistent recovery checkpoint.
      if (
        JSON.stringify(credentials) !==
        JSON.stringify(await this.credentials(accountId))
      ) {
        throw new EncryptedHouseholdError("HOUSEHOLD_CHANGED_RETRY");
      }
      const key = await this.dataKey(accountId);
      const createdAt = this.now().toISOString();
      try {
        const envelope = sealHouseholdSnapshot(
          {
            format: "streamerai-encrypted-household",
            version: 1,
            datasetId: state.datasetId,
            keyVersion: state.keyVersion,
            recoveryVersion: state.recoveryVersion,
            snapshotId: randomUUID(),
            sequence: state.sequence + 1,
            createdAt,
            recovery: state.recovery,
          },
          snapshot,
          key,
        );
        this.database.settings.set(encryptedHouseholdSettingKey(accountId), {
          ...state,
          sequence: envelope.sequence,
          lastExportAt: createdAt,
        });
        return envelope;
      } finally {
        key.fill(0);
      }
    });
  }

  async exportLocalBackup(accountId: string) {
    const master = await new MasterPinService(this.secrets).read(accountId);
    if (!master?.pin) throw new EncryptedHouseholdError("MASTER_PIN_REQUIRED");
    if (!this.isEnabled(accountId)) await this.activate(accountId);
    const envelope = await this.export(accountId);
    return this.exclusive(accountId, async () => {
      const state = this.state(accountId);
      if (
        state.datasetId !== envelope.datasetId ||
        state.keyVersion !== envelope.keyVersion ||
        state.recoveryVersion !== envelope.recoveryVersion
      )
        throw new EncryptedHouseholdError("HOUSEHOLD_CHANGED_RETRY");
      if (
        (await new MasterPinService(this.secrets).read(accountId))?.verifier
          .version !== master.verifier.version
      )
        throw new EncryptedHouseholdError("HOUSEHOLD_CHANGED_RETRY");
      const key = await this.dataKey(accountId);
      try {
        return await protectHouseholdWithMasterPin(envelope, key, master.pin!);
      } finally {
        key.fill(0);
      }
    });
  }

  preview(envelope: unknown, key: string) {
    const opened = openHouseholdSnapshot(envelope, key);
    try {
      return {
        datasetId: opened.envelope.datasetId,
        snapshotId: opened.envelope.snapshotId,
        createdAt: opened.envelope.createdAt,
        profiles: opened.snapshot.profiles.map(({ name, locale, pinHash }) => ({
          name,
          locale,
          pinEnabled: pinHash !== null,
        })),
        credentials: opened.snapshot.credentials.map((c) => c.key),
        limitations: opened.snapshot.limitations,
      };
    } finally {
      opened.dataKey.fill(0);
    }
  }

  /** Recover a failed import's vault writes before retrying; contains no plaintext journal. */
  private async recoverImport(accountId: string): Promise<void> {
    const pending = this.database.settings.get<ImportJournal>(
      journalKey(accountId),
    );
    if (!pending) return;
    const installed = this.database.settings.get<Installed>(
      installedKey(accountId),
    );
    if (installed?.snapshotId !== pending.snapshotId) {
      for (const key of pending.keys) await this.secrets.delete(key);
    }
    this.database.settings.delete(journalKey(accountId));
  }

  private bootstrapProfile(accountId: string): string | null {
    const profiles = this.database.profiles.list(accountId);
    if (profiles.length !== 1) return null;
    const profile = profiles[0]!;
    if (
      profile.name !== "Viewer" ||
      profile.locale !== "en" ||
      profile.pinEnabled ||
      Object.entries(profile.preferences).some(
        ([key, value]) => key !== "onboardingComplete" || value !== false,
      ) ||
      (profile.id === "default" &&
        this.database.settings.get("setup.completed") === true) ||
      this.database.library.list(profile.id).length > 0 ||
      this.database.history.listAll(profile.id).length > 0 ||
      this.database.playbackPositions.list(profile.id).length > 0 ||
      this.database.discoverySessions.listForProfile(profile.id, 1).length >
        0 ||
      this.database.settings.get(
        `media.source-order.${Buffer.from(profile.id).toString("base64url")}`,
      ) !== null ||
      this.database.settings.get(manualAgentSettingKey(profile.id)) !== null ||
      this.database.integrations
        .list(profile.id)
        .some(
          (item) =>
            ["ready", "degraded", "checking", "failed"].includes(
              item.setupStatus,
            ) || item.lastCheckedAt !== null,
        )
    )
      return null;
    return profile.id;
  }

  private assertEmpty(accountId: string): string | null {
    this.database.accounts.getRequired(accountId);
    const bootstrap = this.bootstrapProfile(accountId);
    if (
      (this.database.profiles.count(accountId) !== 0 && bootstrap === null) ||
      this.database.sourceFeedback.list(accountId).length !== 0 ||
      this.isEnabled(accountId)
    ) {
      throw new EncryptedHouseholdError(
        "HOUSEHOLD_RESTORE_REQUIRES_EMPTY_ACCOUNT",
      );
    }
    return bootstrap;
  }

  async restore(
    accountId: string,
    envelope: unknown,
    key: string,
    cloudRecovery?: EncryptedHouseholdEnvelope["recovery"],
    restoredMasterPin?: string,
  ): Promise<HouseholdImportResult> {
    return this.exclusive(accountId, async () => {
      await this.ready();
      const opened = openHouseholdSnapshot(envelope, key);
      try {
        const finish = async (result: HouseholdImportResult) => {
          const master = new MasterPinService(this.secrets);
          if (restoredMasterPin && !(await master.read(accountId)))
            await master.setupLocal(accountId, restoredMasterPin);
          this.database.settings.set(
            householdIdKey(accountId),
            opened.envelope.datasetId,
          );
          return result;
        };
        await this.recoverImport(accountId);
        const installed = this.database.settings.get<Installed>(
          installedKey(accountId),
        );
        if (
          installed?.snapshotId === opened.envelope.snapshotId &&
          installed.profileIds.every(
            (id) => this.database.profiles.get(id)?.accountId === accountId,
          )
        ) {
          return finish({
            profileIds: installed.profileIds,
            credentials: installed.credentials,
            limitations: installed.limitations,
          });
        }
        this.assertEmpty(accountId);
        for (const profile of opened.snapshot.profiles) {
          if (this.database.profiles.getBySyncId(profile.syncId))
            throw new EncryptedHouseholdError("HOUSEHOLD_PROFILE_ID_CONFLICT");
        }
        const providerKeys = opened.snapshot.credentials.map((c) =>
          accountSecretKey(accountId, c.key),
        );
        for (const providerKey of ACCOUNT_PROVIDER_SECRET_KEYS) {
          if (await this.secrets.has(accountSecretKey(accountId, providerKey)))
            throw new EncryptedHouseholdError("HOUSEHOLD_CREDENTIAL_CONFLICT");
        }
        await this.enable(accountId);
        const pending: ImportJournal = {
          snapshotId: opened.envelope.snapshotId,
          keys: [...providerKeys, localKey(accountId)],
        };
        this.database.settings.set(journalKey(accountId), pending);
        try {
          for (const credential of opened.snapshot.credentials) {
            await this.secrets.set(
              accountSecretKey(accountId, credential.key),
              credential.value,
            );
          }
          await this.secrets.set(
            localKey(accountId),
            opened.dataKey.toString("base64url"),
          );
          const result = this.database.transaction(() => {
            const bootstrap = this.assertEmpty(accountId);
            if (bootstrap !== null) this.database.profiles.delete(bootstrap);
            const profileIds = this.importProfiles(accountId, opened.snapshot);
            const result: HouseholdImportResult = {
              profileIds,
              credentials: opened.snapshot.credentials.map((c) => c.key),
              limitations: opened.snapshot.limitations,
            };
            this.database.settings.set(
              encryptedHouseholdSettingKey(accountId),
              {
                version: 1,
                datasetId: opened.envelope.datasetId,
                keyVersion: opened.envelope.keyVersion,
                recoveryVersion: opened.envelope.recoveryVersion,
                recovery: cloudRecovery ?? opened.envelope.recovery,
                sequence: opened.envelope.sequence,
                lastExportAt: null,
              } satisfies State,
            );
            this.database.settings.set(installedKey(accountId), {
              snapshotId: opened.envelope.snapshotId,
              ...result,
            });
            this.database.settings.delete(journalKey(accountId));
            return result;
          });
          return await finish(result);
        } catch (error) {
          await this.recoverImport(accountId);
          throw error;
        }
      } finally {
        opened.dataKey.fill(0);
      }
    });
  }

  /** Import an approved household into this household without replacing its identity, PIN or services. */
  async merge(
    accountId: string,
    envelope: unknown,
    key: string,
    operationId: string,
  ): Promise<HouseholdImportResult> {
    return this.exclusive(accountId, async () => {
      await this.ready();
      const opened = openHouseholdSnapshot(envelope, key);
      const operationKey = `household.merge.${hash(accountId + ":" + operationId)}`;
      const pendingKey = operationKey + ".pending";
      try {
        const installed = this.database.settings.get<Installed>(operationKey);
        if (installed) {
          if (installed.snapshotId !== opened.envelope.snapshotId)
            throw new EncryptedHouseholdError("HOUSEHOLD_MERGE_CONFLICT");
          return installed;
        }
        if (opened.envelope.datasetId === householdId(this.database, accountId))
          throw new EncryptedHouseholdError("HOUSEHOLD_MERGE_CONFLICT");
        if (
          this.database.profiles.count(accountId) +
            opened.snapshot.profiles.length >
          5
        )
          throw new EncryptedHouseholdError("HOUSEHOLD_PROFILE_LIMIT");
        const previous = this.database.settings.get<string[]>(pendingKey);
        if (previous) {
          for (const secretKey of previous)
            await this.secrets.delete(secretKey);
          this.database.settings.delete(pendingKey);
        }
        const credentials: EncryptedHouseholdSnapshot["credentials"] = [];
        for (const credential of opened.snapshot.credentials) {
          if (
            !(await this.secrets.has(
              accountSecretKey(accountId, credential.key),
            ))
          )
            credentials.push(credential);
        }
        const secretKeys = credentials.map((c) =>
          accountSecretKey(accountId, c.key),
        );
        this.database.settings.set(pendingKey, secretKeys);
        try {
          for (const credential of credentials)
            await this.secrets.set(
              accountSecretKey(accountId, credential.key),
              credential.value,
            );
          const syncIds = new Map(
            opened.snapshot.profiles.map((profile) => [
              profile.syncId,
              randomUUID(),
            ]),
          );
          const snapshot: EncryptedHouseholdSnapshot = {
            ...opened.snapshot,
            profiles: opened.snapshot.profiles.map((profile) => ({
              ...profile,
              syncId: syncIds.get(profile.syncId)!,
            })),
            sourceFeedback: opened.snapshot.sourceFeedback.map((feedback) => ({
              ...feedback,
              payload: {
                ...feedback.payload,
                profileId:
                  syncIds.get(feedback.payload.profileId) ??
                  feedback.payload.profileId,
              },
            })),
          };
          return this.database.transaction(() => {
            if (
              this.database.profiles.count(accountId) +
                snapshot.profiles.length >
              5
            )
              throw new EncryptedHouseholdError("HOUSEHOLD_PROFILE_LIMIT");
            const result: HouseholdImportResult = {
              profileIds: this.importProfiles(accountId, snapshot),
              credentials: credentials.map((c) => c.key),
              limitations: [
                ...snapshot.limitations,
                "The destination household keeps its Master PIN and existing shared service credentials.",
              ],
            };
            this.database.settings.set(operationKey, {
              snapshotId: opened.envelope.snapshotId,
              ...result,
            });
            this.database.settings.delete(pendingKey);
            return result;
          });
        } catch (error) {
          for (const secretKey of secretKeys)
            await this.secrets.delete(secretKey);
          this.database.settings.delete(pendingKey);
          throw error;
        }
      } finally {
        opened.dataKey.fill(0);
      }
    });
  }

  private importProfiles(
    accountId: string,
    snapshot: EncryptedHouseholdSnapshot,
  ): string[] {
    for (const title of snapshot.titles) this.materialize(title);
    const profileIds: string[] = [];
    const media = new MediaSourcePreferenceStore(this.database);
    for (const profile of snapshot.profiles) {
      const id = randomUUID();
      this.database.profiles.create({
        id,
        accountId,
        syncId: profile.syncId,
        name: profile.name,
        locale: profile.locale,
        preferences: profile.preferences,
      });
      if (profile.pinHash !== null)
        this.database.profiles.setPinHash(id, profile.pinHash);
      const m = profile.mediaSourcePreferences;
      media.set(
        id,
        m.providerOrder,
        m.mode,
        m.requireSeeking,
        m.requireDirectPlay,
      );
      for (const item of profile.library)
        this.database.library.upsert({ profileId: id, ...item });
      for (const item of profile.history) {
        const { sourceId: _source, ...event } = item;
        this.database.history.append({
          id: randomUUID(),
          profileId: id,
          ...event,
        });
      }
      for (const item of profile.progress)
        this.database.playbackPositions.upsert({
          profileId: id,
          ...item,
        });
      for (const integration of profile.integrations) {
        this.database.integrations.upsert(
          {
            id: integration.id,
            enabled: integration.enabled,
            setupStatus: integration.enabled ? "ready" : "disabled",
            healthStatus: "unknown",
            healthCode: "RESTORED_UNVERIFIED",
            lastCheckedAt: null,
          },
          id,
        );
      }
      for (const conversation of profile.conversations) {
        const sessionId = randomUUID();
        this.database.discoverySessions.restorePortable(
          {
            id: sessionId,
            profileId: id,
            mode: conversation.mode,
            state: conversation.state,
            context: conversation.context,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            completedAt: conversation.completedAt,
          },
          conversation.messages.map((message, index) => ({
            ...message,
            id: randomUUID(),
            sessionId,
            ordinal: index + 1,
          })),
        );
      }
      const sources = new PreferredSourceStore(this.database);
      for (const selection of profile.sourceSelections) {
        const episode =
          selection.seasonNumber !== null && selection.episodeNumber !== null
            ? {
                seasonNumber: selection.seasonNumber,
                episodeNumber: selection.episodeNumber,
              }
            : undefined;
        if (selection.aiPick)
          sources.setAi(
            id,
            selection.titleId,
            selection.sourceId,
            selection.aiPick.reason,
            episode,
          );
        else sources.set(id, selection.titleId, selection.sourceId, episode);
      }
      const priorities = new TitlePriorityStore(this.database, this.now);
      for (const priority of profile.titlePriorities)
        priorities.restoreProfile(id, priority.titleId, priority);
      profileIds.push(id);
    }
    for (const feedback of snapshot.sourceFeedback)
      this.database.sourceFeedback.set(
        accountId,
        feedback.payload,
        feedback.updatedAt,
      );
    return profileIds;
  }

  private materialize(title: AccountSyncTitle): void {
    if (this.database.titles.get(title.id)) return;
    const provenance = {
      retrievedAt: title.metadataValidatedAt,
      connectorVersion: "encrypted-household-v1",
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
      availabilityProvider: "encrypted-household",
      availabilityCheckedAt: title.metadataValidatedAt,
      formats: [],
      sources: [],
      seriesCoverage: null,
      metadataProvenance: { ...provenance, providerId: title.metadataProvider },
      availabilityProvenance: {
        ...provenance,
        providerId: "encrypted-household",
      },
    });
  }
}
