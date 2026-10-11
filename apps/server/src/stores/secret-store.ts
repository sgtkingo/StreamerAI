import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type StorePersistence = "memory" | "persistent";
export type SecretStoreBackend =
  "memory" | "encrypted-file" | "os-keychain" | "external";

/** Keeps the first profile's existing vault keys readable during migration. */
export function profileSecretKey(profileId: string, key: string): string {
  if (profileId === "default") return key;
  const profileToken = Buffer.from(profileId, "utf8").toString("base64url");
  const scoped = `profile.${profileToken}.${key}`;
  if (scoped.length > 256)
    throw new TypeError("Profile secret key is too long.");
  return scoped;
}

export interface SecretStoreCapabilities {
  readonly persistence: StorePersistence;
  readonly backend: SecretStoreBackend;
  readonly encryptedAtRest: boolean;
}

/**
 * A boundary for recoverable application secrets.
 *
 * Implementations must encrypt durable values at rest. Callers must never log
 * returned values or expose store keys as public API identifiers.
 */
export interface SecretStore {
  readonly persistence: StorePersistence;
  readonly isPersistent: boolean;
  readonly capabilities: SecretStoreCapabilities;

  isReady(): Promise<boolean>;
  has(key: string): Promise<boolean>;
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Development/test-only secret store. Values disappear on process exit and
 * are not encrypted. Production composition rejects this implementation.
 */
export class NonPersistentMemorySecretStore implements SecretStore {
  readonly persistence = "memory" as const;
  readonly isPersistent = false;
  readonly capabilities = {
    persistence: "memory",
    backend: "memory",
    encryptedAtRest: false,
  } as const;
  readonly #values = new Map<string, string>();

  async isReady(): Promise<boolean> {
    return true;
  }

  async has(key: string): Promise<boolean> {
    return this.#values.has(key);
  }

  async get(key: string): Promise<string | undefined> {
    return this.#values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
}

interface EncryptedVaultEnvelope {
  readonly version: 1;
  readonly algorithm: "aes-256-gcm";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

export interface EncryptedFileSecretStoreOptions {
  /** Encrypted vault. This file may be included in normal application backups. */
  readonly filename: string;
  /** Read-only 32-byte key, kept outside the data directory (for example a Docker secret). */
  readonly keyFilename: string;
}

const VAULT_AAD = Buffer.from("streamer-ai-secret-vault:v1", "utf8");

function decodeMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-f\d]{64}$/iu.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "Secret-store key file must contain exactly 32 bytes encoded as base64 or hexadecimal.",
    );
  }
  return key;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => key.length > 0 && typeof item === "string",
    )
  );
}

/**
 * Portable encrypted vault for a single StreamerAI server process.
 *
 * The AES key is never written beside the vault. Docker deployments mount it
 * from a secret file; native deployments can use an ACL-protected file. Each
 * mutation rewrites the authenticated envelope atomically.
 */
export class EncryptedFileSecretStore implements SecretStore {
  readonly persistence = "persistent" as const;
  readonly isPersistent = true;
  readonly capabilities = {
    persistence: "persistent",
    backend: "encrypted-file",
    encryptedAtRest: true,
  } as const;

  readonly #filename: string;
  readonly #keyFilename: string;
  #values: Map<string, string> | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(options: EncryptedFileSecretStoreOptions) {
    this.#filename = resolve(options.filename);
    this.#keyFilename = resolve(options.keyFilename);
    if (this.#filename === this.#keyFilename) {
      throw new Error("Secret vault and key file must be separate files.");
    }
  }

  async #masterKey(): Promise<Buffer> {
    return decodeMasterKey(await readFile(this.#keyFilename, "utf8"));
  }

  async #load(): Promise<Map<string, string>> {
    if (this.#values !== undefined) return this.#values;

    let serialized: string;
    try {
      serialized = await readFile(this.#filename, "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        await this.#masterKey();
        this.#values = new Map();
        return this.#values;
      }
      throw error;
    }

    const envelope = JSON.parse(serialized) as Partial<EncryptedVaultEnvelope>;
    if (
      envelope.version !== 1 ||
      envelope.algorithm !== "aes-256-gcm" ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("Secret vault has an unsupported or invalid format.");
    }

    const decipher = createDecipheriv(
      "aes-256-gcm",
      await this.#masterKey(),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
    if (!isStringRecord(parsed)) {
      throw new Error("Secret vault plaintext has an invalid format.");
    }
    this.#values = new Map(Object.entries(parsed));
    return this.#values;
  }

  async #persist(values: Map<string, string>): Promise<void> {
    const key = await this.#masterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(VAULT_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(Object.fromEntries(values)), "utf8"),
      cipher.final(),
    ]);
    const envelope: EncryptedVaultEnvelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    await mkdir(dirname(this.#filename), { recursive: true });
    const temporary = `${this.#filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, this.#filename);
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#pending;
    let release: () => void = () => undefined;
    this.#pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async isReady(): Promise<boolean> {
    try {
      await this.#exclusive(async () => this.#load());
      return true;
    } catch {
      return false;
    }
  }

  async has(key: string): Promise<boolean> {
    return this.#exclusive(async () => (await this.#load()).has(key));
  }

  async get(key: string): Promise<string | undefined> {
    return this.#exclusive(async () => (await this.#load()).get(key));
  }

  async set(key: string, value: string): Promise<void> {
    if (key.length === 0 || key.length > 256)
      throw new TypeError(
        "Secret key must contain between 1 and 256 characters.",
      );
    await this.#exclusive(async () => {
      const next = new Map(await this.#load());
      next.set(key, value);
      await this.#persist(next);
      this.#values = next;
    });
  }

  async delete(key: string): Promise<void> {
    await this.#exclusive(async () => {
      const next = new Map(await this.#load());
      if (!next.delete(key)) return;
      await this.#persist(next);
      this.#values = next;
    });
  }
}

export interface CreateSecretStoreOptions {
  /**
   * Inject an OS-keychain or external secret-manager adapter. StreamerAI does
   * not pretend that its memory fallback is encrypted or durable.
   */
  adapter?: SecretStore;
}

/** Composition point for a future OS keychain adapter. */
export function createSecretStore(
  options: CreateSecretStoreOptions = {},
): SecretStore {
  const store = options.adapter ?? new NonPersistentMemorySecretStore();
  if (
    store.capabilities.persistence !== store.persistence ||
    store.capabilities.encryptedAtRest !== store.isPersistent
  ) {
    throw new Error(
      "SecretStore capabilities are inconsistent: persistent stores must provide encryption at rest.",
    );
  }
  return store;
}
