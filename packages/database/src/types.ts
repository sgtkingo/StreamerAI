import type {
  AvailabilityState,
  CatalogTitle,
  ContentMode,
  IntegrationHealthState,
  IntegrationId,
  IntegrationSetupState,
  SupportedLocale,
} from "@streamer-ai/contracts";

export type Clock = () => Date;

export interface Profile {
  id: string;
  name: string;
  locale: SupportedLocale;
  preferences: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProfileInput {
  id: string;
  name: string;
  locale: SupportedLocale;
  preferences?: Record<string, unknown>;
}

export interface UpdateProfileInput {
  name?: string;
  locale?: SupportedLocale;
  preferences?: Record<string, unknown>;
}

export interface UpsertIntegrationConnectionInput {
  id: IntegrationId;
  enabled: boolean;
  setupStatus: IntegrationSetupState;
  healthStatus: IntegrationHealthState;
  /** Opaque pointer into the local secret store. Never pass a credential value. */
  secretRef?: string | null;
  healthCode?: string | null;
  lastCheckedAt?: string | null;
}

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface Job<TPayload = unknown> {
  id: string;
  kind: string;
  payload: TPayload;
  state: JobState;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  uniqueKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueJobInput<TPayload = unknown> {
  id: string;
  kind: string;
  payload: TPayload;
  priority?: number;
  maxAttempts?: number;
  availableAt?: string;
  uniqueKey?: string | null;
}

export interface ClaimJobInput {
  workerId: string;
  leaseMs: number;
  kinds?: readonly string[];
}

export interface SyncOutboxOperation<TPayload = unknown> {
  opId: string;
  deviceId: string;
  profileId: string | null;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  hlc: string;
  payload: TPayload;
  tombstone: boolean;
  attempts: number;
  availableAt: string;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface EnqueueSyncOperationInput<TPayload = unknown> {
  opId: string;
  deviceId: string;
  profileId?: string | null;
  entityType: string;
  entityId: string;
  schemaVersion: number;
  hlc: string;
  payload: TPayload;
  tombstone?: boolean;
  availableAt?: string;
}

export type CanonicalTitleData = Omit<
  CatalogTitle,
  | "inLibrary"
  | "matchPercent"
  | "progressPercent"
  | "resumePositionSeconds"
  | "resumeEpisode"
  | "priority"
>;

export interface CanonicalTitleRecord extends CanonicalTitleData {
  createdAt: string;
  updatedAt: string;
}

export type UpsertCanonicalTitleInput = CanonicalTitleData;

export interface ExternalEntityMappingInput {
  titleId: string;
  providerId: string;
  externalId: string;
  entityType: "movie" | "series" | "season" | "episode";
  retrievedAt: string;
}

export interface LibraryEntryRecord {
  profileId: string;
  titleId: string;
  membershipReason: "explicit" | "playback";
  state: "saved" | "in-progress" | "completed";
  progressPercent: number | null;
  addedAt: string;
  updatedAt: string;
  lastPlayedAt: string | null;
}

export interface UpsertLibraryEntryInput {
  profileId: string;
  titleId: string;
  membershipReason: "explicit" | "playback";
  state?: "saved" | "in-progress" | "completed";
  progressPercent?: number | null;
  lastPlayedAt?: string | null;
}

export interface PlaybackPositionRecord {
  profileId: string;
  titleId: string;
  seasonNumber: number | null;
  episodeNumber: number | null;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  updatedAt: string;
}

export interface UpsertPlaybackPositionInput extends Omit<
  PlaybackPositionRecord,
  "updatedAt"
> {
  updatedAt?: string;
}

export interface WatchHistoryRecord {
  id: string;
  profileId: string;
  titleId: string;
  eventType: "start" | "progress" | "stop" | "complete";
  episodeLabel: string | null;
  progressPercent: number;
  occurredAt: string;
}

export interface AppendWatchHistoryInput extends Omit<
  WatchHistoryRecord,
  "occurredAt"
> {
  occurredAt?: string;
}

export interface AvailabilitySnapshot {
  state: AvailabilityState;
  checkedAt: string | null;
}

export const DISCOVERY_SESSION_STATES = [
  "active",
  "completed",
  "needs-setup",
  "failed",
] as const;
export type DiscoverySessionState = (typeof DISCOVERY_SESSION_STATES)[number];

export interface DiscoverySessionRecord<TContext = unknown> {
  id: string;
  profileId: string;
  mode: ContentMode;
  state: DiscoverySessionState;
  context: TContext;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateDiscoverySessionInput<TContext = unknown> {
  id: string;
  profileId: string;
  mode: ContentMode;
  context?: TContext;
}

export const DISCOVERY_MESSAGE_ROLES = [
  "system",
  "user",
  "assistant",
  "tool",
] as const;
export type DiscoveryMessageRole = (typeof DISCOVERY_MESSAGE_ROLES)[number];

export interface DiscoveryMessageRecord<TContent = unknown> {
  id: string;
  sessionId: string;
  ordinal: number;
  role: DiscoveryMessageRole;
  content: TContent;
  requestId: string | null;
  createdAt: string;
}

export interface AppendDiscoveryMessageInput<TContent = unknown> {
  id: string;
  sessionId: string;
  role: DiscoveryMessageRole;
  content: TContent;
  requestId?: string | null;
  createdAt?: string;
}

export const IDEMPOTENCY_STATES = [
  "in-progress",
  "completed",
  "failed",
] as const;
export type IdempotencyState = (typeof IDEMPOTENCY_STATES)[number];

export interface IdempotencyRecord<TResponse = unknown> {
  scope: string;
  key: string;
  requestHash: string;
  state: IdempotencyState;
  response: TResponse | null;
  statusCode: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ClaimIdempotencyInput {
  scope: string;
  key: string;
  requestHash: string;
  ttlSeconds?: number;
}

export type IdempotencyClaim<TResponse = unknown> =
  | { status: "claimed"; record: IdempotencyRecord<TResponse> }
  | { status: "replay"; record: IdempotencyRecord<TResponse> }
  | { status: "in-progress"; record: IdempotencyRecord<TResponse> }
  | { status: "conflict"; record: IdempotencyRecord<TResponse> };

export interface CompleteIdempotencyInput<TResponse = unknown> {
  scope: string;
  key: string;
  requestHash: string;
  response: TResponse;
  statusCode: number;
}

export interface FailIdempotencyInput<
  TResponse = unknown,
> extends CompleteIdempotencyInput<TResponse> {
  errorCode: string;
}
