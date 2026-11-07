import { pbkdf2, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { SecretStore } from "../stores/secret-store.js";

const derive = promisify(pbkdf2);
export const masterPinSecretKey = (accountId: string) =>
  `account.master-pin.${Buffer.from(accountId).toString("base64url")}`;
export interface MasterPinVerifier {
  salt: string;
  hash: string;
  version: string;
  changeSalt?: string;
}
export interface CloudMasterPinVerifier extends MasterPinVerifier {
  changeSalt: string;
  changeHash: string;
}
export async function createMasterPinVerifier(
  pin: string,
): Promise<CloudMasterPinVerifier> {
  if (!/^\d{8}$/.test(pin)) throw new Error("Choose an 8-digit Master PIN.");
  const salt = randomBytes(16).toString("hex");
  const changeSalt = randomBytes(16).toString("hex");
  return {
    salt,
    hash: (await derive(pin, salt, 600_000, 32, "sha256")).toString("hex"),
    version: randomUUID(),
    changeSalt,
    changeHash: (await derive(pin, changeSalt, 600_000, 32, "sha256")).toString(
      "hex",
    ),
  };
}
interface StoredPin {
  verifier: MasterPinVerifier;
  pin?: string;
}
export function isMasterPinVerifier(
  value: unknown,
): value is MasterPinVerifier {
  if (!value || typeof value !== "object") return false;
  const record = value as MasterPinVerifier;
  return (
    typeof record.salt === "string" &&
    /^[a-f0-9]{32}$/.test(record.salt) &&
    typeof record.hash === "string" &&
    /^[a-f0-9]{64}$/.test(record.hash) &&
    typeof record.version === "string" &&
    /^[a-f0-9-]{36}$/.test(record.version) &&
    (record.changeSalt === undefined ||
      (typeof record.changeSalt === "string" &&
        /^[a-f0-9]{32}$/.test(record.changeSalt)))
  );
}
/** Recoverable PINs stay only in the encrypted local vault, never in sync data. */
export class MasterPinService {
  private readonly jobs = new Map<string, Promise<void>>();
  constructor(private readonly secrets: SecretStore) {}
  private async exclusive<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.jobs.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const job = new Promise<void>((done) => {
      release = done;
    });
    this.jobs.set(accountId, job);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.jobs.get(accountId) === job) this.jobs.delete(accountId);
    }
  }
  async read(accountId: string): Promise<StoredPin | null> {
    const raw = await this.secrets.get(masterPinSecretKey(accountId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredPin;
    if (!isMasterPinVerifier(stored.verifier))
      throw new Error("Invalid Master PIN record.");
    return stored;
  }
  async setupLocal(accountId: string, pin: string) {
    return this.exclusive(accountId, async () => {
      if (!/^\d{8}$/.test(pin))
        throw new Error("Choose an 8-digit Master PIN.");
      if (await this.read(accountId))
        throw new Error("A Master PIN is already set.");
      const salt = randomBytes(16).toString("hex");
      const verifier = {
        salt,
        hash: (await derive(pin, salt, 600_000, 32, "sha256")).toString("hex"),
        version: randomUUID(),
      };
      await this.secrets.set(
        masterPinSecretKey(accountId),
        JSON.stringify({ verifier, pin }),
      );
    });
  }
  async cacheVerifier(accountId: string, verifier: MasterPinVerifier) {
    return this.exclusive(accountId, async () => {
      if (!isMasterPinVerifier(verifier))
        throw new Error("Invalid Master PIN verifier.");
      const existing = await this.read(accountId);
      if (
        existing?.verifier.version === verifier.version &&
        existing.verifier.changeSalt === verifier.changeSalt
      )
        return;
      await this.secrets.set(
        masterPinSecretKey(accountId),
        JSON.stringify({ verifier }),
      );
    });
  }
  async verify(accountId: string, pin: string): Promise<boolean> {
    return this.exclusive(accountId, async () => {
      if (!/^\d{8}$/.test(pin)) return false;
      const stored = await this.read(accountId);
      if (!stored) return false;
      const actual = await derive(
        pin,
        stored.verifier.salt,
        600_000,
        32,
        "sha256",
      );
      if (!timingSafeEqual(actual, Buffer.from(stored.verifier.hash, "hex")))
        return false;
      if (
        (await this.read(accountId))?.verifier.version !==
        stored.verifier.version
      )
        return false;
      await this.secrets.set(
        masterPinSecretKey(accountId),
        JSON.stringify({ ...stored, pin }),
      );
      return true;
    });
  }

  async changeLocal(
    accountId: string,
    currentPin: string,
    pin: string,
  ): Promise<boolean> {
    return this.exclusive(accountId, async () => {
      const stored = await this.read(accountId);
      if (!stored || !/^\d{8}$/.test(currentPin) || !/^\d{8}$/.test(pin))
        return false;
      const actual = await derive(
        currentPin,
        stored.verifier.salt,
        600_000,
        32,
        "sha256",
      );
      if (!timingSafeEqual(actual, Buffer.from(stored.verifier.hash, "hex")))
        return false;
      const candidate = await createMasterPinVerifier(pin);
      const verifier = {
        salt: candidate.salt,
        hash: candidate.hash,
        version: candidate.version,
      };
      await this.secrets.set(
        masterPinSecretKey(accountId),
        JSON.stringify({ verifier, pin }),
      );
      return true;
    });
  }
}
