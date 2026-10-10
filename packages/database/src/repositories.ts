import {
  INTEGRATION_DESCRIPTORS,
  CatalogTitleSchema,
  ContentModeSchema,
  IntegrationHealthStateSchema,
  IntegrationIdSchema,
  IntegrationPublicStatusSchema,
  IntegrationSetupStateSchema,
  SupportedLocaleSchema,
  type CredentialState,
  type IntegrationId,
  type IntegrationPublicStatus,
} from "@streamer-ai/contracts";
import type BetterSqlite3 from "better-sqlite3";

import { DatabaseValidationError, ProfileLimitError } from "./errors.js";
import type {
  AppendWatchHistoryInput,
  AppendDiscoveryMessageInput,
  CanonicalTitleData,
  CanonicalTitleRecord,
  ClaimIdempotencyInput,
  ClaimJobInput,
  Clock,
  CompleteIdempotencyInput,
  CreateDiscoverySessionInput,
  CreateProfileInput,
  DiscoveryMessageRecord,
  DiscoverySessionRecord,
  EnqueueJobInput,
  EnqueueSyncOperationInput,
  FailIdempotencyInput,
  IdempotencyClaim,
  IdempotencyRecord,
  Job,
  LibraryEntryRecord,
  PlaybackPositionRecord,
  Profile,
  SyncOutboxOperation,
  UpdateProfileInput,
  UpsertCanonicalTitleInput,
  UpsertIntegrationConnectionInput,
  UpsertLibraryEntryInput,
  UpsertPlaybackPositionInput,
  WatchHistoryRecord,
} from "./types.js";

interface ProfileRow {
  id: string;
  name: string;
  locale: string;
  preferences_json: string;
  created_at: string;
  updated_at: string;
}

interface IntegrationConnectionRow {
  integration_id: string;
  enabled: number;
  setup_status: string;
  health_status: string;
  secret_ref: string | null;
  health_code: string | null;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  kind: string;
  payload_json: string;
  state: string;
  priority: number;
  attempts: number;
  max_attempts: number;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  unique_key: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncOutboxRow {
  op_id: string;
  device_id: string;
  profile_id: string | null;
  entity_type: string;
  entity_id: string;
  schema_version: number;
  hlc: string;
  payload_json: string;
  tombstone: number;
  attempts: number;
  available_at: string;
  last_error: string | null;
  delivered_at: string | null;
  created_at: string;
}

interface CanonicalTitleRow {
  id: string;
  kind: string;
  title: string;
  normalized_json: string;
  metadata_provider: string;
  metadata_validated_at: string;
  availability_state: string;
  availability_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LibraryEntryRow {
  profile_id: string;
  title_id: string;
  membership_reason: string;
  state: string;
  progress_percent: number | null;
  added_at: string;
  updated_at: string;
  last_played_at: string | null;
}

interface WatchHistoryRow {
  id: string;
  profile_id: string;
  title_id: string;
  event_type: string;
  episode_label: string | null;
  progress_percent: number;
  occurred_at: string;
}

interface DiscoverySessionRow {
  id: string;
  profile_id: string;
  mode: string;
  state: string;
  context_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface DiscoveryMessageRow {
  id: string;
  session_id: string;
  ordinal: number;
  role: string;
  content_json: string;
  request_id: string | null;
  created_at: string;
}

interface IdempotencyRow {
  scope: string;
  key: string;
  request_hash: string;
  state: string;
  response_json: string | null;
  status_code: number | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const isoNow = (clock: Clock): string => clock().toISOString();

function assertShortString(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new DatabaseValidationError(
      `${label} must contain between 1 and ${maxLength} characters.`,
    );
  }
  return normalized;
}

function stringifyJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("not JSON serializable");
    }
    return serialized;
  } catch {
    throw new DatabaseValidationError(`${label} must be JSON serializable.`);
  }
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function validateCanonicalTitle(
  input: UpsertCanonicalTitleInput,
): CanonicalTitleData {
  const parsed = CatalogTitleSchema.parse({
    ...input,
    inLibrary: false,
    matchPercent: null,
    progressPercent: null,
  });
  const {
    inLibrary: _inLibrary,
    matchPercent: _matchPercent,
    progressPercent: _progressPercent,
    ...data
  } = parsed;
  return data;
}

function canonicalTitleFromRow(row: CanonicalTitleRow): CanonicalTitleRecord {
  const data = validateCanonicalTitle(
    parseJson<UpsertCanonicalTitleInput>(row.normalized_json),
  );
  return { ...data, createdAt: row.created_at, updatedAt: row.updated_at };
}

function libraryEntryFromRow(row: LibraryEntryRow): LibraryEntryRecord {
  return {
    profileId: row.profile_id,
    titleId: row.title_id,
    membershipReason:
      row.membership_reason as LibraryEntryRecord["membershipReason"],
    state: row.state as LibraryEntryRecord["state"],
    progressPercent: row.progress_percent,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    lastPlayedAt: row.last_played_at,
  };
}

function watchHistoryFromRow(row: WatchHistoryRow): WatchHistoryRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    titleId: row.title_id,
    eventType: row.event_type as WatchHistoryRecord["eventType"],
    episodeLabel: row.episode_label,
    progressPercent: row.progress_percent,
    occurredAt: row.occurred_at,
  };
}

function discoverySessionFromRow<TContext>(
  row: DiscoverySessionRow,
): DiscoverySessionRecord<TContext> {
  return {
    id: row.id,
    profileId: row.profile_id,
    mode: ContentModeSchema.parse(row.mode),
    state: row.state as DiscoverySessionRecord["state"],
    context: parseJson<TContext>(row.context_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function discoveryMessageFromRow<TContent>(
  row: DiscoveryMessageRow,
): DiscoveryMessageRecord<TContent> {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    role: row.role as DiscoveryMessageRecord["role"],
    content: parseJson<TContent>(row.content_json),
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

function idempotencyFromRow<TResponse>(
  row: IdempotencyRow,
): IdempotencyRecord<TResponse> {
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    state: row.state as IdempotencyRecord["state"],
    response:
      row.response_json === null
        ? null
        : parseJson<TResponse>(row.response_json),
    statusCode: row.status_code,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function assertIsoTimestamp(value: string, label: string): string {
  const rfc3339 =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!rfc3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DatabaseValidationError(`${label} must be an ISO timestamp.`);
  }
  return value;
}

function profileFromRow(row: ProfileRow): Profile {
  return {
    id: row.id,
    name: row.name,
    locale: SupportedLocaleSchema.parse(row.locale),
    preferences: parseJson<Record<string, unknown>>(row.preferences_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function credentialState(row: IntegrationConnectionRow): CredentialState {
  const descriptor =
    INTEGRATION_DESCRIPTORS[
      row.integration_id as keyof typeof INTEGRATION_DESCRIPTORS
    ];
  if (descriptor === undefined) {
    return row.secret_ref === null ? "missing" : "stored";
  }
  if (
    descriptor.setupMode === "none" ||
    descriptor.setupMode === "local-runtime" ||
    descriptor.setupMode === "informed-consent"
  ) {
    return "not-required";
  }
  return row.secret_ref === null ? "missing" : "stored";
}

/**
 * The only conversion from the secret-bearing persistence row to its API-safe
 * representation. It constructs a fresh object and validates strict output, so
 * future columns cannot leak through object spreading.
 */
export function toPublicIntegrationConnection(
  row: IntegrationConnectionRow,
): IntegrationPublicStatus {
  return IntegrationPublicStatusSchema.parse({
    id: row.integration_id,
    enabled: row.enabled === 1,
    setupStatus: row.setup_status,
    healthStatus: row.health_status,
    credentialStatus: credentialState(row),
    healthCode: row.health_code,
    lastCheckedAt: row.last_checked_at,
    updatedAt: row.updated_at,
  });
}

function jobFromRow<TPayload>(row: JobRow): Job<TPayload> {
  return {
    id: row.id,
    kind: row.kind,
    payload: parseJson<TPayload>(row.payload_json),
    state: row.state as Job<TPayload>["state"],
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    uniqueKey: row.unique_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function syncOperationFromRow<TPayload>(
  row: SyncOutboxRow,
): SyncOutboxOperation<TPayload> {
  return {
    opId: row.op_id,
    deviceId: row.device_id,
    profileId: row.profile_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    schemaVersion: row.schema_version,
    hlc: row.hlc,
    payload: parseJson<TPayload>(row.payload_json),
    tombstone: row.tombstone === 1,
    attempts: row.attempts,
    availableAt: row.available_at,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
  };
}

export class SettingsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  get<T>(key: string): T | null {
    const row = this.database
      .prepare("SELECT value_json FROM app_settings WHERE key = ?")
      .get(assertShortString(key, "Setting key", 120)) as
      { value_json: string } | undefined;
    return row === undefined ? null : parseJson<T>(row.value_json);
  }

  set(key: string, value: unknown): void {
    this.database
      .prepare(
        `
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
      `,
      )
      .run(
        assertShortString(key, "Setting key", 120),
        stringifyJson(value, "Setting value"),
        isoNow(this.clock),
      );
  }

  delete(key: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM app_settings WHERE key = ?")
        .run(assertShortString(key, "Setting key", 120)).changes > 0
    );
  }
}

export class ProfilesRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  create(input: CreateProfileInput): Profile {
    const now = isoNow(this.clock);
    try {
      this.database
        .prepare(
          `
          INSERT INTO profiles (id, name, locale, preferences_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          assertShortString(input.id, "Profile id", 120),
          assertShortString(input.name, "Profile name", 80),
          SupportedLocaleSchema.parse(input.locale),
          stringifyJson(input.preferences ?? {}, "Profile preferences"),
          now,
          now,
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("PROFILE_LIMIT_REACHED")
      ) {
        throw new ProfileLimitError();
      }
      throw error;
    }
    return this.getRequired(input.id);
  }

  get(id: string): Profile | null {
    const row = this.database
      .prepare("SELECT * FROM profiles WHERE id = ?")
      .get(assertShortString(id, "Profile id", 120)) as ProfileRow | undefined;
    return row === undefined ? null : profileFromRow(row);
  }

  getRequired(id: string): Profile {
    const profile = this.get(id);
    if (profile === null) {
      throw new DatabaseValidationError(`Profile '${id}' does not exist.`);
    }
    return profile;
  }

  list(): Profile[] {
    return (
      this.database
        .prepare("SELECT * FROM profiles ORDER BY created_at, id")
        .all() as ProfileRow[]
    ).map(profileFromRow);
  }

  count(): number {
    return (
      this.database.prepare("SELECT count(*) AS count FROM profiles").get() as {
        count: number;
      }
    ).count;
  }

  update(id: string, patch: UpdateProfileInput): Profile {
    const current = this.getRequired(id);
    this.database
      .prepare(
        `
        UPDATE profiles
        SET name = ?, locale = ?, preferences_json = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        patch.name === undefined
          ? current.name
          : assertShortString(patch.name, "Profile name", 80),
        patch.locale === undefined
          ? current.locale
          : SupportedLocaleSchema.parse(patch.locale),
        stringifyJson(
          patch.preferences ?? current.preferences,
          "Profile preferences",
        ),
        isoNow(this.clock),
        current.id,
      );
    return this.getRequired(current.id);
  }

  delete(id: string): boolean {
    return (
      this.database
        .prepare("DELETE FROM profiles WHERE id = ?")
        .run(assertShortString(id, "Profile id", 120)).changes > 0
    );
  }
}

export class CatalogTitlesRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  upsert(input: UpsertCanonicalTitleInput): CanonicalTitleRecord {
    const incoming = validateCanonicalTitle(input);
    const existing = this.get(incoming.id);
    if (existing !== null && existing.kind !== incoming.kind) {
      throw new DatabaseValidationError(
        `Canonical title '${incoming.id}' cannot change media kind.`,
      );
    }
    const existingData =
      existing === null
        ? null
        : (({ createdAt: _createdAt, updatedAt: _updatedAt, ...data }) => data)(
            existing,
          );
    const metadataIsFresh =
      existingData === null ||
      Date.parse(incoming.metadataValidatedAt) >=
        Date.parse(existingData.metadataValidatedAt);
    const incomingAvailabilityTime =
      incoming.availabilityCheckedAt === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(incoming.availabilityCheckedAt);
    const existingAvailabilityTime =
      existingData?.availabilityCheckedAt === null ||
      existingData?.availabilityCheckedAt === undefined
        ? Number.NEGATIVE_INFINITY
        : Date.parse(existingData.availabilityCheckedAt);
    const availabilityRank = (state: string) =>
      state === "available" || state === "partial"
        ? 3
        : state === "unavailable"
          ? 2
          : 1;
    // Parallel fast/deep discovery can finish seconds apart. A later bounded
    // miss must not erase a playable source verified by the sibling branch.
    // A later, independent check may still retire stale availability.
    const recentlyVerifiedStream =
      existingData !== null &&
      availabilityRank(existingData.availability) === 3 &&
      availabilityRank(incoming.availability) < 3 &&
      incomingAvailabilityTime - existingAvailabilityTime < 120_000;
    const inconclusiveDowngrade =
      existingData !== null &&
      existingData.availability !== "unknown" &&
      incoming.availability === "unknown";
    const availabilityIsFresh =
      !recentlyVerifiedStream &&
      !inconclusiveDowngrade &&
      (existingData === null ||
        incomingAvailabilityTime > existingAvailabilityTime ||
        (incomingAvailabilityTime === existingAvailabilityTime &&
          availabilityRank(incoming.availability) >=
            availabilityRank(existingData.availability) &&
          (incoming.sources?.length ?? 0) >=
            (existingData.sources?.length ?? 0)));
    const mergedSources = [
      ...(existingData?.sources ?? []),
      ...(incoming.sources ?? []),
    ]
      .filter(
        (source, index, sources) =>
          sources.findIndex((other) => other.id === source.id) === index,
      )
      .slice(0, 24);
    const data = validateCanonicalTitle({
      ...incoming,
      ...(existingData?.sources !== undefined || incoming.sources !== undefined
        ? { sources: mergedSources }
        : {}),
      ...(metadataIsFresh || existingData === null
        ? {}
        : {
            title: existingData.title,
            originalTitle: existingData.originalTitle,
            year: existingData.year,
            synopsis: existingData.synopsis,
            posterUrl: existingData.posterUrl,
            backdropUrl: existingData.backdropUrl,
            accentColor: existingData.accentColor,
            genres: existingData.genres,
            ratings: existingData.ratings,
            metadataProvider: existingData.metadataProvider,
            metadataRef: existingData.metadataRef,
            metadataValidatedAt: existingData.metadataValidatedAt,
            metadataProvenance: existingData.metadataProvenance,
          }),
      ...(availabilityIsFresh || existingData === null
        ? {}
        : {
            availability: existingData.availability,
            availabilityProvider: existingData.availabilityProvider,
            availabilityCheckedAt: existingData.availabilityCheckedAt,
            formats: existingData.formats,
            seriesCoverage: existingData.seriesCoverage,
            availabilityProvenance: existingData.availabilityProvenance,
          }),
    });
    const now = isoNow(this.clock);
    this.database
      .prepare(
        `
        INSERT INTO canonical_titles (
          id, kind, title, normalized_json, metadata_provider, metadata_validated_at,
          availability_state, availability_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          normalized_json = excluded.normalized_json,
          metadata_provider = excluded.metadata_provider,
          metadata_validated_at = excluded.metadata_validated_at,
          availability_state = excluded.availability_state,
          availability_checked_at = excluded.availability_checked_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        data.id,
        data.kind,
        data.title,
        stringifyJson(data, "Canonical title"),
        data.metadataProvider,
        assertIsoTimestamp(data.metadataValidatedAt, "Metadata validated at"),
        data.availability,
        data.availabilityCheckedAt,
        existing?.createdAt ?? now,
        now,
      );
    return this.getRequired(data.id);
  }

  get(id: string): CanonicalTitleRecord | null {
    const row = this.database
      .prepare("SELECT * FROM canonical_titles WHERE id = ?")
      .get(assertShortString(id, "Canonical title id", 160)) as
      CanonicalTitleRow | undefined;
    return row === undefined ? null : canonicalTitleFromRow(row);
  }

  list(ids?: readonly string[]): CanonicalTitleRecord[] {
    if (ids === undefined) {
      return (
        this.database
          .prepare(
            "SELECT * FROM canonical_titles ORDER BY updated_at DESC, id",
          )
          .all() as CanonicalTitleRow[]
      ).map(canonicalTitleFromRow);
    }
    if (ids.length === 0) return [];
    const safeIds = ids.map((id) =>
      assertShortString(id, "Canonical title id", 160),
    );
    const placeholders = safeIds.map(() => "?").join(", ");
    return (
      this.database
        .prepare(`SELECT * FROM canonical_titles WHERE id IN (${placeholders})`)
        .all(...safeIds) as CanonicalTitleRow[]
    ).map(canonicalTitleFromRow);
  }

  mapExternalEntity(input: {
    titleId: string;
    providerId: string;
    externalId: string;
    entityType: "movie" | "series" | "season" | "episode";
    retrievedAt: string;
  }): void {
    this.getRequired(input.titleId);
    this.database
      .prepare(
        `
        INSERT INTO external_entity_mappings (title_id, provider_id, external_id, entity_type, retrieved_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(provider_id, external_id, entity_type) DO UPDATE SET
          title_id = excluded.title_id,
          retrieved_at = excluded.retrieved_at
      `,
      )
      .run(
        input.titleId,
        assertShortString(input.providerId, "Provider id", 80),
        assertShortString(input.externalId, "External id", 160),
        input.entityType,
        assertIsoTimestamp(input.retrievedAt, "Retrieved at"),
      );
  }

  private getRequired(id: string): CanonicalTitleRecord {
    const title = this.get(id);
    if (title === null)
      throw new DatabaseValidationError(
        `Canonical title '${id}' does not exist.`,
      );
    return title;
  }
}

export class LibraryRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  upsert(input: UpsertLibraryEntryInput): LibraryEntryRecord {
    const profileId = assertShortString(input.profileId, "Profile id", 120);
    const titleId = assertShortString(input.titleId, "Canonical title id", 160);
    const existing = this.get(profileId, titleId);
    const now = isoNow(this.clock);
    const state =
      input.state ??
      (input.membershipReason === "playback" ? "in-progress" : "saved");
    const progressPercent =
      input.progressPercent ?? existing?.progressPercent ?? null;
    if (
      progressPercent !== null &&
      (progressPercent < 0 || progressPercent > 100)
    ) {
      throw new DatabaseValidationError(
        "Library progress must be between 0 and 100.",
      );
    }
    const lastPlayedAt =
      input.lastPlayedAt === undefined
        ? (existing?.lastPlayedAt ?? null)
        : input.lastPlayedAt;
    if (lastPlayedAt !== null)
      assertIsoTimestamp(lastPlayedAt, "Last played at");

    this.database
      .prepare(
        `
        INSERT INTO library_entries (
          profile_id, title_id, membership_reason, state, progress_percent, added_at, updated_at, last_played_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, title_id) DO UPDATE SET
          membership_reason = excluded.membership_reason,
          state = excluded.state,
          progress_percent = excluded.progress_percent,
          updated_at = excluded.updated_at,
          last_played_at = excluded.last_played_at
      `,
      )
      .run(
        profileId,
        titleId,
        input.membershipReason,
        state,
        progressPercent,
        existing?.addedAt ?? now,
        now,
        lastPlayedAt,
      );
    return this.getRequired(profileId, titleId);
  }

  get(profileId: string, titleId: string): LibraryEntryRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM library_entries WHERE profile_id = ? AND title_id = ?",
      )
      .get(
        assertShortString(profileId, "Profile id", 120),
        assertShortString(titleId, "Canonical title id", 160),
      ) as LibraryEntryRow | undefined;
    return row === undefined ? null : libraryEntryFromRow(row);
  }

  list(profileId: string): LibraryEntryRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM library_entries WHERE profile_id = ? ORDER BY updated_at DESC, title_id",
        )
        .all(
          assertShortString(profileId, "Profile id", 120),
        ) as LibraryEntryRow[]
    ).map(libraryEntryFromRow);
  }

  remove(profileId: string, titleId: string): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM library_entries WHERE profile_id = ? AND title_id = ?",
        )
        .run(
          assertShortString(profileId, "Profile id", 120),
          assertShortString(titleId, "Canonical title id", 160),
        ).changes > 0
    );
  }

  private getRequired(profileId: string, titleId: string): LibraryEntryRecord {
    const entry = this.get(profileId, titleId);
    if (entry === null)
      throw new DatabaseValidationError(
        `Library entry '${profileId}/${titleId}' does not exist.`,
      );
    return entry;
  }
}

export class PlaybackPositionsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  get(
    profileId: string,
    titleId: string,
    seasonNumber: number | null = null,
    episodeNumber: number | null = null,
  ): PlaybackPositionRecord | null {
    const row = this.database
      .prepare(
        `
      SELECT * FROM playback_positions
      WHERE profile_id = ? AND title_id = ? AND position_key = ?
    `,
      )
      .get(
        assertShortString(profileId, "Profile id", 120),
        assertShortString(titleId, "Canonical title id", 160),
        this.key(seasonNumber, episodeNumber),
      ) as
      | {
          profile_id: string;
          title_id: string;
          season_number: number | null;
          episode_number: number | null;
          position_seconds: number;
          duration_seconds: number;
          progress_percent: number;
          updated_at: string;
        }
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  latest(profileId: string, titleId: string): PlaybackPositionRecord | null {
    const row = this.database
      .prepare(
        `
      SELECT * FROM playback_positions
      WHERE profile_id = ? AND title_id = ?
      ORDER BY updated_at DESC, position_key LIMIT 1
    `,
      )
      .get(
        assertShortString(profileId, "Profile id", 120),
        assertShortString(titleId, "Canonical title id", 160),
      ) as
      | {
          profile_id: string;
          title_id: string;
          season_number: number | null;
          episode_number: number | null;
          position_seconds: number;
          duration_seconds: number;
          progress_percent: number;
          updated_at: string;
        }
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  latestResumable(
    profileId: string,
    titleId: string,
  ): PlaybackPositionRecord | null {
    const row = this.database
      .prepare(
        `
      SELECT * FROM playback_positions
      WHERE profile_id = ? AND title_id = ? AND progress_percent >= 2 AND progress_percent < 95
      ORDER BY updated_at DESC, position_key LIMIT 1
    `,
      )
      .get(
        assertShortString(profileId, "Profile id", 120),
        assertShortString(titleId, "Canonical title id", 160),
      ) as
      | {
          profile_id: string;
          title_id: string;
          season_number: number | null;
          episode_number: number | null;
          position_seconds: number;
          duration_seconds: number;
          progress_percent: number;
          updated_at: string;
        }
      | undefined;
    return row ? this.fromRow(row) : null;
  }

  upsert(input: UpsertPlaybackPositionInput): PlaybackPositionRecord {
    if (
      input.positionSeconds < 0 ||
      input.durationSeconds < 0 ||
      input.progressPercent < 0 ||
      input.progressPercent > 100
    ) {
      throw new DatabaseValidationError(
        "Playback position values are invalid.",
      );
    }
    const updatedAt =
      input.updatedAt === undefined
        ? isoNow(this.clock)
        : assertIsoTimestamp(input.updatedAt, "Updated at");
    this.database
      .prepare(
        `
      INSERT INTO playback_positions (
        profile_id, title_id, position_key, season_number, episode_number,
        position_seconds, duration_seconds, progress_percent, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (profile_id, title_id, position_key) DO UPDATE SET
        position_seconds = excluded.position_seconds,
        duration_seconds = excluded.duration_seconds,
        progress_percent = excluded.progress_percent,
        updated_at = excluded.updated_at
    `,
      )
      .run(
        assertShortString(input.profileId, "Profile id", 120),
        assertShortString(input.titleId, "Canonical title id", 160),
        this.key(input.seasonNumber, input.episodeNumber),
        input.seasonNumber,
        input.episodeNumber,
        input.positionSeconds,
        input.durationSeconds,
        input.progressPercent,
        updatedAt,
      );
    return this.get(
      input.profileId,
      input.titleId,
      input.seasonNumber,
      input.episodeNumber,
    )!;
  }

  private key(
    seasonNumber: number | null,
    episodeNumber: number | null,
  ): string {
    if (
      (seasonNumber === null) !== (episodeNumber === null) ||
      (seasonNumber !== null &&
        (!Number.isInteger(seasonNumber) || seasonNumber < 1)) ||
      (episodeNumber !== null &&
        (!Number.isInteger(episodeNumber) || episodeNumber < 1))
    ) {
      throw new DatabaseValidationError("Episode coordinates are invalid.");
    }
    return seasonNumber === null
      ? "title"
      : `s${seasonNumber}e${episodeNumber}`;
  }

  private fromRow(row: {
    profile_id: string;
    title_id: string;
    season_number: number | null;
    episode_number: number | null;
    position_seconds: number;
    duration_seconds: number;
    progress_percent: number;
    updated_at: string;
  }): PlaybackPositionRecord {
    return {
      profileId: row.profile_id,
      titleId: row.title_id,
      seasonNumber: row.season_number,
      episodeNumber: row.episode_number,
      positionSeconds: row.position_seconds,
      durationSeconds: row.duration_seconds,
      progressPercent: row.progress_percent,
      updatedAt: row.updated_at,
    };
  }
}

export class HistoryRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  append(input: AppendWatchHistoryInput): WatchHistoryRecord {
    if (input.progressPercent < 0 || input.progressPercent > 100) {
      throw new DatabaseValidationError(
        "History progress must be between 0 and 100.",
      );
    }
    const occurredAt =
      input.occurredAt === undefined
        ? isoNow(this.clock)
        : assertIsoTimestamp(input.occurredAt, "Occurred at");
    this.database
      .prepare(
        `
        INSERT INTO watch_history_events (
          id, profile_id, title_id, event_type, episode_label, progress_percent, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        assertShortString(input.id, "History event id", 120),
        assertShortString(input.profileId, "Profile id", 120),
        assertShortString(input.titleId, "Canonical title id", 160),
        input.eventType,
        input.episodeLabel === null
          ? null
          : assertShortString(input.episodeLabel, "Episode label", 120),
        input.progressPercent,
        occurredAt,
      );
    return this.getRequired(input.id);
  }

  list(profileId: string, limit = 100): WatchHistoryRecord[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DatabaseValidationError(
        "History limit must be between 1 and 1000.",
      );
    }
    return (
      this.database
        .prepare(
          "SELECT * FROM watch_history_events WHERE profile_id = ? ORDER BY occurred_at DESC, id DESC LIMIT ?",
        )
        .all(
          assertShortString(profileId, "Profile id", 120),
          limit,
        ) as WatchHistoryRow[]
    ).map(watchHistoryFromRow);
  }

  remove(profileId: string, eventId: string): boolean {
    return (
      this.database
        .prepare(
          "DELETE FROM watch_history_events WHERE profile_id = ? AND id = ?",
        )
        .run(
          assertShortString(profileId, "Profile id", 120),
          assertShortString(eventId, "History event id", 120),
        ).changes > 0
    );
  }

  clear(profileId: string): number {
    return this.database
      .prepare("DELETE FROM watch_history_events WHERE profile_id = ?")
      .run(assertShortString(profileId, "Profile id", 120)).changes;
  }

  private getRequired(id: string): WatchHistoryRecord {
    const row = this.database
      .prepare("SELECT * FROM watch_history_events WHERE id = ?")
      .get(assertShortString(id, "History event id", 120)) as
      WatchHistoryRow | undefined;
    if (row === undefined)
      throw new DatabaseValidationError(
        `History event '${id}' does not exist.`,
      );
    return watchHistoryFromRow(row);
  }
}

export class DiscoverySessionsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  create<TContext = Record<string, never>>(
    input: CreateDiscoverySessionInput<TContext>,
  ): DiscoverySessionRecord<TContext> {
    const now = isoNow(this.clock);
    this.database
      .prepare(
        `
        INSERT INTO discovery_sessions (
          id, profile_id, mode, state, context_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, 'active', ?, ?, ?, NULL)
      `,
      )
      .run(
        assertShortString(input.id, "Discovery session id", 120),
        assertShortString(input.profileId, "Profile id", 120),
        ContentModeSchema.parse(input.mode),
        stringifyJson(input.context ?? {}, "Discovery session context"),
        now,
        now,
      );
    return this.getRequired<TContext>(input.id);
  }

  get<TContext = unknown>(id: string): DiscoverySessionRecord<TContext> | null {
    const row = this.database
      .prepare("SELECT * FROM discovery_sessions WHERE id = ?")
      .get(assertShortString(id, "Discovery session id", 120)) as
      DiscoverySessionRow | undefined;
    return row === undefined ? null : discoverySessionFromRow<TContext>(row);
  }

  listForProfile<TContext = unknown>(
    profileId: string,
    limit = 50,
  ): DiscoverySessionRecord<TContext>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new DatabaseValidationError(
        "Discovery session limit must be between 1 and 500.",
      );
    }
    return (
      this.database
        .prepare(
          `
          SELECT * FROM discovery_sessions
          WHERE profile_id = ?
          ORDER BY updated_at DESC, id DESC
          LIMIT ?
        `,
        )
        .all(
          assertShortString(profileId, "Profile id", 120),
          limit,
        ) as DiscoverySessionRow[]
    ).map(discoverySessionFromRow<TContext>);
  }

  appendMessage<TContent = unknown>(
    input: AppendDiscoveryMessageInput<TContent>,
  ): DiscoveryMessageRecord<TContent> {
    return this.database.transaction(() => {
      const session = this.getRequired(input.sessionId);
      if (session.state !== "active") {
        throw new DatabaseValidationError(
          `Discovery session '${session.id}' is already ${session.state}.`,
        );
      }
      const sessionId = session.id;
      const ordinal = (
        this.database
          .prepare(
            "SELECT coalesce(max(ordinal), 0) + 1 AS ordinal FROM discovery_messages WHERE session_id = ?",
          )
          .get(sessionId) as { ordinal: number }
      ).ordinal;
      const createdAt =
        input.createdAt === undefined
          ? isoNow(this.clock)
          : assertIsoTimestamp(input.createdAt, "Message creation time");
      const requestId =
        input.requestId === undefined || input.requestId === null
          ? null
          : assertShortString(input.requestId, "Request id", 120);
      this.database
        .prepare(
          `
          INSERT INTO discovery_messages (
            id, session_id, ordinal, role, content_json, request_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          assertShortString(input.id, "Discovery message id", 120),
          sessionId,
          ordinal,
          input.role,
          stringifyJson(input.content, "Discovery message content"),
          requestId,
          createdAt,
        );
      this.database
        .prepare("UPDATE discovery_sessions SET updated_at = ? WHERE id = ?")
        .run(createdAt, sessionId);
      return this.getMessageRequired<TContent>(input.id);
    })();
  }

  listMessages<TContent = unknown>(
    sessionId: string,
  ): DiscoveryMessageRecord<TContent>[] {
    this.getRequired(sessionId);
    return (
      this.database
        .prepare(
          "SELECT * FROM discovery_messages WHERE session_id = ? ORDER BY ordinal",
        )
        .all(
          assertShortString(sessionId, "Discovery session id", 120),
        ) as DiscoveryMessageRow[]
    ).map(discoveryMessageFromRow<TContent>);
  }

  updateContext<TContext>(
    id: string,
    context: TContext,
  ): DiscoverySessionRecord<TContext> {
    const session = this.getRequired(id);
    if (session.state !== "active") {
      throw new DatabaseValidationError(
        `Discovery session '${session.id}' is already ${session.state}.`,
      );
    }
    this.database
      .prepare(
        "UPDATE discovery_sessions SET context_json = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        stringifyJson(context, "Discovery session context"),
        isoNow(this.clock),
        session.id,
      );
    return this.getRequired<TContext>(session.id);
  }

  complete(
    id: string,
    state: "completed" | "needs-setup" | "failed" = "completed",
  ): DiscoverySessionRecord {
    const session = this.getRequired(id);
    if (session.state !== "active") {
      if (session.state === state) return session;
      throw new DatabaseValidationError(
        `Discovery session '${session.id}' is already ${session.state}.`,
      );
    }
    const completedAt = isoNow(this.clock);
    this.database
      .prepare(
        `
        UPDATE discovery_sessions
        SET state = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND state = 'active'
      `,
      )
      .run(state, completedAt, completedAt, session.id);
    return this.getRequired(session.id);
  }

  private getRequired<TContext = unknown>(
    id: string,
  ): DiscoverySessionRecord<TContext> {
    const session = this.get<TContext>(id);
    if (session === null) {
      throw new DatabaseValidationError(
        `Discovery session '${id}' does not exist.`,
      );
    }
    return session;
  }

  private getMessageRequired<TContent>(
    id: string,
  ): DiscoveryMessageRecord<TContent> {
    const row = this.database
      .prepare("SELECT * FROM discovery_messages WHERE id = ?")
      .get(assertShortString(id, "Discovery message id", 120)) as
      DiscoveryMessageRow | undefined;
    if (row === undefined) {
      throw new DatabaseValidationError(
        `Discovery message '${id}' does not exist.`,
      );
    }
    return discoveryMessageFromRow<TContent>(row);
  }
}

export class IdempotencyRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  claim<TResponse = unknown>(
    input: ClaimIdempotencyInput,
  ): IdempotencyClaim<TResponse> {
    const ttlSeconds = input.ttlSeconds ?? 86_400;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > 2_592_000
    ) {
      throw new DatabaseValidationError(
        "Idempotency TTL must be between 1 and 2592000 seconds.",
      );
    }
    const scope = assertShortString(input.scope, "Idempotency scope", 160);
    const key = this.validateKey(input.key);
    const requestHash = this.validateRequestHash(input.requestHash);

    return this.database.transaction((): IdempotencyClaim<TResponse> => {
      const nowDate = this.clock();
      const now = nowDate.toISOString();
      let existing = this.get<TResponse>(scope, key);
      if (
        existing !== null &&
        Date.parse(existing.expiresAt) <= nowDate.getTime()
      ) {
        this.database
          .prepare(
            "DELETE FROM idempotency_records WHERE scope = ? AND key = ?",
          )
          .run(scope, key);
        existing = null;
      }
      if (existing !== null) {
        if (existing.requestHash !== requestHash) {
          return { status: "conflict", record: existing };
        }
        return {
          status: existing.state === "in-progress" ? "in-progress" : "replay",
          record: existing,
        };
      }

      const expiresAt = new Date(
        nowDate.getTime() + ttlSeconds * 1_000,
      ).toISOString();
      this.database
        .prepare(
          `
          INSERT INTO idempotency_records (
            scope, key, request_hash, state, response_json, status_code, error_code,
            created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, 'in-progress', NULL, NULL, NULL, ?, ?, ?)
        `,
        )
        .run(scope, key, requestHash, now, now, expiresAt);
      return {
        status: "claimed",
        record: this.getRequired<TResponse>(scope, key),
      };
    })();
  }

  get<TResponse = unknown>(
    scope: string,
    key: string,
  ): IdempotencyRecord<TResponse> | null {
    const row = this.database
      .prepare("SELECT * FROM idempotency_records WHERE scope = ? AND key = ?")
      .get(
        assertShortString(scope, "Idempotency scope", 160),
        this.validateKey(key),
      ) as IdempotencyRow | undefined;
    return row === undefined ? null : idempotencyFromRow<TResponse>(row);
  }

  complete<TResponse>(
    input: CompleteIdempotencyInput<TResponse>,
  ): IdempotencyRecord<TResponse> {
    return this.finish(input, "completed", null);
  }

  fail<TResponse>(
    input: FailIdempotencyInput<TResponse>,
  ): IdempotencyRecord<TResponse> {
    return this.finish(
      input,
      "failed",
      assertShortString(input.errorCode, "Idempotency error code", 120),
    );
  }

  pruneExpired(): number {
    return this.database
      .prepare("DELETE FROM idempotency_records WHERE expires_at <= ?")
      .run(isoNow(this.clock)).changes;
  }

  private finish<TResponse>(
    input: CompleteIdempotencyInput<TResponse>,
    state: "completed" | "failed",
    errorCode: string | null,
  ): IdempotencyRecord<TResponse> {
    if (
      !Number.isInteger(input.statusCode) ||
      input.statusCode < 100 ||
      input.statusCode > 599
    ) {
      throw new DatabaseValidationError(
        "Idempotency status code must be between 100 and 599.",
      );
    }
    const scope = assertShortString(input.scope, "Idempotency scope", 160);
    const key = this.validateKey(input.key);
    const requestHash = this.validateRequestHash(input.requestHash);
    const updatedAt = isoNow(this.clock);
    const changes = this.database
      .prepare(
        `
        UPDATE idempotency_records
        SET state = ?, response_json = ?, status_code = ?, error_code = ?, updated_at = ?
        WHERE scope = ? AND key = ? AND request_hash = ? AND state = 'in-progress'
      `,
      )
      .run(
        state,
        stringifyJson(input.response, "Idempotency response"),
        input.statusCode,
        errorCode,
        updatedAt,
        scope,
        key,
        requestHash,
      ).changes;
    if (changes !== 1) {
      throw new DatabaseValidationError(
        `Idempotency claim '${scope}/${key}' is missing, completed, or belongs to a different request.`,
      );
    }
    return this.getRequired<TResponse>(scope, key);
  }

  private getRequired<TResponse>(
    scope: string,
    key: string,
  ): IdempotencyRecord<TResponse> {
    const record = this.get<TResponse>(scope, key);
    if (record === null) {
      throw new DatabaseValidationError(
        `Idempotency claim '${scope}/${key}' does not exist.`,
      );
    }
    return record;
  }

  private validateKey(value: string): string {
    const key = assertShortString(value, "Idempotency key", 120);
    if (key.length < 8) {
      throw new DatabaseValidationError(
        "Idempotency key must contain at least 8 characters.",
      );
    }
    return key;
  }

  private validateRequestHash(value: string): string {
    const hash = assertShortString(value, "Idempotency request hash", 128);
    if (hash.length < 16) {
      throw new DatabaseValidationError(
        "Idempotency request hash must contain at least 16 characters.",
      );
    }
    return hash;
  }
}

export class IntegrationsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  get(id: IntegrationId): IntegrationPublicStatus | null {
    const row = this.getStored(IntegrationIdSchema.parse(id));
    return row === null ? null : toPublicIntegrationConnection(row);
  }

  list(): IntegrationPublicStatus[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM integration_connections ORDER BY integration_id",
        )
        .all() as IntegrationConnectionRow[]
    ).map(toPublicIntegrationConnection);
  }

  upsert(input: UpsertIntegrationConnectionInput): IntegrationPublicStatus {
    const id = IntegrationIdSchema.parse(input.id);
    const existing = this.getStored(id);
    const hasSecretRef = Object.prototype.hasOwnProperty.call(
      input,
      "secretRef",
    );
    const secretRef = hasSecretRef
      ? this.validateSecretRef(input.secretRef ?? null)
      : (existing?.secret_ref ?? null);
    const healthCode =
      input.healthCode === undefined
        ? (existing?.health_code ?? null)
        : input.healthCode;
    if (healthCode !== null) {
      assertShortString(healthCode, "Health code", 80);
    }
    const lastCheckedAt =
      input.lastCheckedAt === undefined
        ? (existing?.last_checked_at ?? null)
        : input.lastCheckedAt;
    if (lastCheckedAt !== null) {
      assertIsoTimestamp(lastCheckedAt, "Last checked at");
    }
    const now = isoNow(this.clock);

    this.database
      .prepare(
        `
        INSERT INTO integration_connections (
          integration_id, enabled, setup_status, health_status, secret_ref, health_code,
          last_checked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(integration_id) DO UPDATE SET
          enabled = excluded.enabled,
          setup_status = excluded.setup_status,
          health_status = excluded.health_status,
          secret_ref = excluded.secret_ref,
          health_code = excluded.health_code,
          last_checked_at = excluded.last_checked_at,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        id,
        input.enabled ? 1 : 0,
        IntegrationSetupStateSchema.parse(input.setupStatus),
        IntegrationHealthStateSchema.parse(input.healthStatus),
        secretRef,
        healthCode,
        lastCheckedAt,
        existing?.created_at ?? now,
        now,
      );

    const publicConnection = this.get(id);
    if (publicConnection === null) {
      throw new Error(`Integration '${id}' was not persisted.`);
    }
    return publicConnection;
  }

  /** Resolve only at the secret-manager boundary; never return this value through an API. */
  getSecretRef(id: IntegrationId): string | null {
    return this.getStored(IntegrationIdSchema.parse(id))?.secret_ref ?? null;
  }

  clearSecretRef(id: IntegrationId): void {
    this.database
      .prepare(
        "UPDATE integration_connections SET secret_ref = NULL, updated_at = ? WHERE integration_id = ?",
      )
      .run(isoNow(this.clock), IntegrationIdSchema.parse(id));
  }

  private getStored(id: IntegrationId): IntegrationConnectionRow | null {
    return (
      (this.database
        .prepare(
          "SELECT * FROM integration_connections WHERE integration_id = ?",
        )
        .get(id) as IntegrationConnectionRow | undefined) ?? null
    );
  }

  private validateSecretRef(value: string | null): string | null {
    if (value === null) {
      return null;
    }
    const normalized = assertShortString(value, "Secret reference", 512);
    if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(normalized)) {
      throw new DatabaseValidationError(
        "Secret reference must be an opaque URI, not a credential value.",
      );
    }
    return normalized;
  }
}

export class JobsRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  enqueue<TPayload>(input: EnqueueJobInput<TPayload>): Job<TPayload> {
    const now = isoNow(this.clock);
    const availableAt =
      input.availableAt === undefined
        ? now
        : assertIsoTimestamp(input.availableAt, "Available at");
    this.database
      .prepare(
        `
        INSERT INTO jobs (
          id, kind, payload_json, state, priority, attempts, max_attempts, available_at,
          unique_key, created_at, updated_at
        ) VALUES (?, ?, ?, 'queued', ?, 0, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        assertShortString(input.id, "Job id", 120),
        assertShortString(input.kind, "Job kind", 120),
        stringifyJson(input.payload, "Job payload"),
        input.priority ?? 0,
        input.maxAttempts ?? 3,
        availableAt,
        input.uniqueKey ?? null,
        now,
        now,
      );
    return this.getRequired<TPayload>(input.id);
  }

  get<TPayload = unknown>(id: string): Job<TPayload> | null {
    const row = this.database
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get(assertShortString(id, "Job id", 120)) as JobRow | undefined;
    return row === undefined ? null : jobFromRow<TPayload>(row);
  }

  claimNext<TPayload = unknown>(input: ClaimJobInput): Job<TPayload> | null {
    const workerId = assertShortString(input.workerId, "Worker id", 120);
    if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1_000) {
      throw new DatabaseValidationError("Job lease must be at least 1000ms.");
    }
    const kinds =
      input.kinds?.map((kind) => assertShortString(kind, "Job kind", 120)) ??
      [];

    return this.database.transaction(() => {
      const nowDate = this.clock();
      const now = nowDate.toISOString();
      const kindClause =
        kinds.length === 0
          ? ""
          : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      const row = this.database
        .prepare(
          `
          SELECT * FROM jobs
          WHERE attempts < max_attempts
            AND (
              (state = 'queued' AND available_at <= ?)
              OR (state = 'running' AND lease_expires_at <= ?)
            )
            ${kindClause}
          ORDER BY priority DESC, created_at, id
          LIMIT 1
        `,
        )
        .get(now, now, ...kinds) as JobRow | undefined;
      if (row === undefined) {
        return null;
      }
      const leaseExpiresAt = new Date(
        nowDate.getTime() + input.leaseMs,
      ).toISOString();
      this.database
        .prepare(
          `
          UPDATE jobs
          SET state = 'running', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
        `,
        )
        .run(workerId, leaseExpiresAt, now, row.id);
      return this.getRequired<TPayload>(row.id);
    })();
  }

  complete(id: string, workerId: string): boolean {
    const now = isoNow(this.clock);
    return (
      this.database
        .prepare(
          `
          UPDATE jobs
          SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'running' AND lease_owner = ?
        `,
        )
        .run(
          now,
          assertShortString(id, "Job id", 120),
          assertShortString(workerId, "Worker id", 120),
        ).changes > 0
    );
  }

  fail(
    id: string,
    workerId: string,
    errorCode: string,
    retryAt?: string,
  ): boolean {
    const job = this.getRequired(id);
    const now = isoNow(this.clock);
    const retry =
      retryAt === undefined ? now : assertIsoTimestamp(retryAt, "Retry at");
    const nextState = job.attempts >= job.maxAttempts ? "failed" : "queued";
    return (
      this.database
        .prepare(
          `
          UPDATE jobs
          SET state = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
              last_error = ?, updated_at = ?
          WHERE id = ? AND state = 'running' AND lease_owner = ?
        `,
        )
        .run(
          nextState,
          retry,
          assertShortString(errorCode, "Job error code", 240),
          now,
          job.id,
          assertShortString(workerId, "Worker id", 120),
        ).changes > 0
    );
  }

  private getRequired<TPayload = unknown>(id: string): Job<TPayload> {
    const job = this.get<TPayload>(id);
    if (job === null) {
      throw new DatabaseValidationError(`Job '${id}' does not exist.`);
    }
    return job;
  }
}

export class SyncOutboxRepository {
  constructor(
    private readonly database: BetterSqlite3.Database,
    private readonly clock: Clock,
  ) {}

  enqueue<TPayload>(
    input: EnqueueSyncOperationInput<TPayload>,
  ): SyncOutboxOperation<TPayload> {
    if (!Number.isInteger(input.schemaVersion) || input.schemaVersion < 1) {
      throw new DatabaseValidationError(
        "Sync schema version must be a positive integer.",
      );
    }
    const now = isoNow(this.clock);
    this.database
      .prepare(
        `
        INSERT INTO sync_outbox (
          op_id, device_id, profile_id, entity_type, entity_id, schema_version, hlc,
          payload_json, tombstone, attempts, available_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `,
      )
      .run(
        assertShortString(input.opId, "Operation id", 120),
        assertShortString(input.deviceId, "Device id", 120),
        input.profileId === undefined || input.profileId === null
          ? null
          : assertShortString(input.profileId, "Profile id", 120),
        assertShortString(input.entityType, "Entity type", 120),
        assertShortString(input.entityId, "Entity id", 240),
        input.schemaVersion,
        assertShortString(input.hlc, "Hybrid logical timestamp", 120),
        stringifyJson(input.payload, "Sync payload"),
        input.tombstone === true ? 1 : 0,
        input.availableAt === undefined
          ? now
          : assertIsoTimestamp(input.availableAt, "Available at"),
        now,
      );
    return this.getRequired<TPayload>(input.opId);
  }

  listPending<TPayload = unknown>(
    limit = 100,
  ): SyncOutboxOperation<TPayload>[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new DatabaseValidationError(
        "Outbox batch limit must be between 1 and 1000.",
      );
    }
    const rows = this.database
      .prepare(
        `
        SELECT * FROM sync_outbox
        WHERE delivered_at IS NULL AND available_at <= ?
        ORDER BY created_at, op_id
        LIMIT ?
      `,
      )
      .all(isoNow(this.clock), limit) as SyncOutboxRow[];
    return rows.map(syncOperationFromRow<TPayload>);
  }

  markDelivered(opIds: readonly string[]): number {
    if (opIds.length === 0) {
      return 0;
    }
    const ids = opIds.map((id) => assertShortString(id, "Operation id", 120));
    const placeholders = ids.map(() => "?").join(", ");
    return this.database
      .prepare(
        `UPDATE sync_outbox SET delivered_at = ?, last_error = NULL WHERE op_id IN (${placeholders})`,
      )
      .run(isoNow(this.clock), ...ids).changes;
  }

  markFailed(opId: string, errorCode: string, retryAt: string): boolean {
    return (
      this.database
        .prepare(
          `
          UPDATE sync_outbox
          SET attempts = attempts + 1, last_error = ?, available_at = ?
          WHERE op_id = ? AND delivered_at IS NULL
        `,
        )
        .run(
          assertShortString(errorCode, "Sync error code", 240),
          assertIsoTimestamp(retryAt, "Retry at"),
          assertShortString(opId, "Operation id", 120),
        ).changes > 0
    );
  }

  pruneDelivered(before: string): number {
    return this.database
      .prepare(
        "DELETE FROM sync_outbox WHERE delivered_at IS NOT NULL AND delivered_at < ?",
      )
      .run(assertIsoTimestamp(before, "Prune before")).changes;
  }

  private getRequired<TPayload>(opId: string): SyncOutboxOperation<TPayload> {
    const row = this.database
      .prepare("SELECT * FROM sync_outbox WHERE op_id = ?")
      .get(assertShortString(opId, "Operation id", 120)) as
      SyncOutboxRow | undefined;
    if (row === undefined) {
      throw new DatabaseValidationError(
        `Sync operation '${opId}' does not exist.`,
      );
    }
    return syncOperationFromRow<TPayload>(row);
  }
}
