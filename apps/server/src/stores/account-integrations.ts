import { LOCAL_ACCOUNT_ID, type StreamerDatabase } from "@streamer-ai/database";
import {
  profileSecretKey,
  type SecretStore,
  type SecretStoreCapabilities,
  type StorePersistence,
} from "./secret-store.js";

/** Only recoverable provider credentials are migrated; installation/cloud secrets stay untouched. */
export const ACCOUNT_PROVIDER_SECRET_KEYS = [
  "integration.tmdb.read-token",
  "integration.webshare.wst",
  "integration.hellspy.session",
  "inference.api.openai",
  "inference.api.anthropic",
  "inference.api.gemini",
  "inference.api.grok",
  "inference.api.kimi",
  "inference.api.deepseek",
] as const;

const providerKeys = new Set<string>(ACCOUNT_PROVIDER_SECRET_KEYS);
const migrationMarker = "migration.accountIntegrations.secretsComplete";

export function accountSecretKey(accountId: string, key: string): string {
  const scoped = `account.${Buffer.from(accountId, "utf8").toString("base64url")}.${key}`;
  if (scoped.length > 256)
    throw new TypeError("Account secret key is too long.");
  return scoped;
}

/**
 * Legacy migration is intentionally driven by one profile only. A missing
 * credential is never borrowed from another profile. Original encrypted values
 * are retained for rollback but are no longer read by the running application.
 */
export async function migrateAccountIntegrations(
  database: StreamerDatabase,
  underlying: SecretStore,
): Promise<void> {
  if (database.settings.get<boolean>(migrationMarker) === true) return;
  const sourceProfile =
    database.settings.get<string>(
      "migration.accountIntegrations.sourceProfile",
    ) ??
    database.profiles.list()[0]?.id ??
    "default";
  for (const key of ACCOUNT_PROVIDER_SECRET_KEYS) {
    const destination = accountSecretKey(LOCAL_ACCOUNT_ID, key);
    if (await underlying.has(destination)) continue;
    const existing = await underlying.get(profileSecretKey(sourceProfile, key));
    if (existing !== undefined) await underlying.set(destination, existing);
  }
  database.settings.set(migrationMarker, true);
}

/** Adapts existing provider clients to account ownership without exposing tokens to clients. */
export class AccountScopedSecretStore implements SecretStore {
  readonly persistence: StorePersistence;
  readonly isPersistent: boolean;
  readonly capabilities: SecretStoreCapabilities;
  #migration: Promise<void> | undefined;

  constructor(
    private readonly database: StreamerDatabase,
    private readonly underlying: SecretStore,
  ) {
    this.persistence = underlying.persistence;
    this.isPersistent = underlying.isPersistent;
    this.capabilities = underlying.capabilities;
  }

  private async ready(): Promise<void> {
    this.#migration ??= migrateAccountIntegrations(
      this.database,
      this.underlying,
    ).catch((error: unknown) => {
      this.#migration = undefined;
      throw error;
    });
    return this.#migration;
  }

  private resolve(key: string): string {
    let profileId = "default";
    let providerKey = key;
    const scoped = /^profile\.([A-Za-z0-9_-]+)\.(.+)$/.exec(key);
    if (scoped !== null) {
      profileId = Buffer.from(scoped[1]!, "base64url").toString("utf8");
      providerKey = scoped[2]!;
    }
    if (!providerKeys.has(providerKey)) return key;
    const profile = this.database.profiles.get(profileId);
    if (profile === null && profileId !== "default")
      throw new Error("Cannot resolve credentials for an unknown profile.");
    return accountSecretKey(
      profile?.accountId ?? LOCAL_ACCOUNT_ID,
      providerKey,
    );
  }

  async isReady(): Promise<boolean> {
    if (!(await this.underlying.isReady())) return false;
    try {
      await this.ready();
      return true;
    } catch {
      return false;
    }
  }
  async has(key: string): Promise<boolean> {
    await this.ready();
    return this.underlying.has(this.resolve(key));
  }
  async get(key: string): Promise<string | undefined> {
    await this.ready();
    return this.underlying.get(this.resolve(key));
  }
  async set(key: string, value: string): Promise<void> {
    await this.ready();
    return this.underlying.set(this.resolve(key), value);
  }
  async delete(key: string): Promise<void> {
    await this.ready();
    return this.underlying.delete(this.resolve(key));
  }
}
