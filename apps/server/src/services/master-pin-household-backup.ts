import { argon2, randomBytes } from "node:crypto";
import {
  ENCRYPTED_HOUSEHOLD_MAX_BYTES,
  EncryptedHouseholdEnvelopeSchema,
  MasterPinHouseholdBackupSchema,
  type EncryptedHouseholdEnvelope,
  type MasterPinHouseholdBackup,
} from "@streamer-ai/contracts";
import {
  EncryptedHouseholdError,
  wrapHouseholdKey,
} from "./encrypted-household-crypto.js";

const parameters = {
  algorithm: "argon2id",
  memory: 65_536,
  passes: 3,
  parallelism: 1,
} as const;
async function derive(
  pin: string,
  salt: string,
  cloudRecovery: EncryptedHouseholdEnvelope["recovery"],
): Promise<Buffer> {
  if (!/^\d{8}$/.test(pin))
    throw new EncryptedHouseholdError("INVALID_MASTER_PIN");
  const nonce = Buffer.from(salt, "base64url");
  if (nonce.length !== 16 || nonce.toString("base64url") !== salt)
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD");
  // Bind the independent cloud recovery wrapper as well as the file's KDF salt.
  const message = Buffer.from(
    `streamerai-household-master-pin:v1:${pin}:${JSON.stringify(cloudRecovery)}`,
  );
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      argon2(
        "argon2id",
        {
          memory: parameters.memory,
          passes: parameters.passes,
          parallelism: parameters.parallelism,
          message,
          nonce,
          tagLength: 32,
        },
        (error, result) => (error ? reject(error) : resolve(result)),
      ),
    );
  } finally {
    message.fill(0);
  }
}
export async function protectHouseholdWithMasterPin(
  envelope: EncryptedHouseholdEnvelope,
  dataKey: Buffer,
  pin: string,
): Promise<MasterPinHouseholdBackup> {
  const salt = randomBytes(16).toString("base64url");
  const cloudRecovery =
    EncryptedHouseholdEnvelopeSchema.parse(envelope).recovery;
  const derived = await derive(pin, salt, cloudRecovery);
  try {
    const backup = MasterPinHouseholdBackupSchema.parse({
      format: "streamerai-master-pin-household",
      version: 1,
      kdf: { ...parameters, salt },
      cloudRecovery,
      envelope: {
        ...envelope,
        recovery: wrapHouseholdKey(
          envelope,
          dataKey,
          `STRM-R1-${derived.toString("base64url")}`,
        ),
      },
    });
    if (
      Buffer.byteLength(JSON.stringify(backup)) > ENCRYPTED_HOUSEHOLD_MAX_BYTES
    )
      throw new EncryptedHouseholdError("HOUSEHOLD_EXPORT_TOO_LARGE");
    return backup;
  } finally {
    derived.fill(0);
  }
}
/** Accept only household backups protected by an 8-digit Master PIN. */
export async function resolveHouseholdBackup(
  input: unknown,
  key: string,
): Promise<{
  envelope: EncryptedHouseholdEnvelope;
  recoveryKey: string;
  cloudRecovery?: EncryptedHouseholdEnvelope["recovery"];
}> {
  if (
    Buffer.byteLength(JSON.stringify(input) ?? "") >
    ENCRYPTED_HOUSEHOLD_MAX_BYTES
  )
    throw new EncryptedHouseholdError("HOUSEHOLD_EXPORT_TOO_LARGE");
  const backup = MasterPinHouseholdBackupSchema.safeParse(input);
  if (!backup.success)
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD");
  const derived = await derive(
    key,
    backup.data.kdf.salt,
    backup.data.cloudRecovery,
  );
  try {
    return {
      envelope: backup.data.envelope,
      recoveryKey: `STRM-R1-${derived.toString("base64url")}`,
      cloudRecovery: backup.data.cloudRecovery,
    };
  } finally {
    derived.fill(0);
  }
}
