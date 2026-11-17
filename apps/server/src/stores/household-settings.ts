import { LOCAL_ACCOUNT_ID, type StreamerDatabase } from "@streamer-ai/database";

/**
 * AI agent settings belong to the household, not to one profile: every profile
 * uses the agent the owner configured in household administration.
 *
 * Settings were stored per profile before. The local household keeps using the
 * former "default" keys, so existing single-profile installs need no migration;
 * other households get account-scoped keys.
 */
export function householdScopeId(
  database: StreamerDatabase,
  profileId: string,
): string {
  const accountId =
    database.profiles.get(profileId)?.accountId ??
    database.accounts.getHousehold().id;
  return accountId === LOCAL_ACCOUNT_ID ? "default" : `account:${accountId}`;
}

/**
 * Reads a household setting. When the household has none yet, the setting a
 * profile of this household saved before settings became shared is adopted,
 * in profile order, so an existing agent setup keeps working for everyone.
 */
export function readHouseholdSetting<T>(
  database: StreamerDatabase,
  key: (scopeId: string) => string,
  profileId: string,
): T | null {
  const scopeId = householdScopeId(database, profileId);
  const current = database.settings.get<T>(key(scopeId));
  if (current !== null) return current;
  const accountId =
    database.profiles.get(profileId)?.accountId ??
    database.accounts.getHousehold().id;
  for (const profile of database.profiles.list(accountId)) {
    if (profile.id === scopeId) continue;
    const legacy = database.settings.get<T>(key(profile.id));
    if (legacy === null) continue;
    database.settings.set(key(scopeId), legacy);
    return legacy;
  }
  return null;
}

export function writeHouseholdSetting(
  database: StreamerDatabase,
  key: (scopeId: string) => string,
  profileId: string,
  value: unknown,
): void {
  database.settings.set(key(householdScopeId(database, profileId)), value);
}
