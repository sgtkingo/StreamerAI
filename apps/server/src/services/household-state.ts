import { createHash, randomUUID } from "node:crypto";
import type { StreamerDatabase } from "@streamer-ai/database";

export const householdAccountKey = "household.accountId";
export const householdPendingKey = (accountId: string) =>
  `household.pending.${accountId}`;
export const householdReadyKey = (accountId: string) =>
  `household.ready.${accountId}`;
export const householdIdKey = (accountId: string) =>
  `household.id.${accountId}`;
export const householdCloudCredentialKey = (accountId: string) =>
  `household.cloudCredential.${accountId}`;

export interface PendingHousehold {
  kind: "create" | "restore" | "register";
  householdId?: string;
  revision?: number;
}

/** The public household identity survives cloud attach/detach and portable restores. */
export function householdId(
  database: StreamerDatabase,
  accountId: string,
): string {
  let value = database.settings.get<string>(householdIdKey(accountId));
  if (!value) {
    value =
      database.settings.get<{ datasetId: string }>(
        `encryptedHousehold.${createHash("sha256").update(accountId).digest("hex")}`,
      )?.datasetId ?? randomUUID();
    database.settings.set(householdIdKey(accountId), value);
  }
  return value;
}

export function householdHasData(
  database: StreamerDatabase,
  accountId: string,
): boolean {
  const profiles = database.profiles.list(accountId);
  return (
    profiles.length > 1 ||
    profiles.some(
      (profile) =>
        profile.name !== "Viewer" ||
        profile.pinEnabled ||
        profile.preferences.onboardingComplete === true ||
        database.library.list(profile.id).length > 0 ||
        database.history.listAll(profile.id).length > 0 ||
        database.discoverySessions.listForProfile(profile.id, 1).length > 0,
    )
  );
}
