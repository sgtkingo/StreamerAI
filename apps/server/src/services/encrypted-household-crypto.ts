import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  ENCRYPTED_HOUSEHOLD_MAX_BYTES,
  EncryptedHouseholdEnvelopeSchema,
  EncryptedHouseholdSnapshotSchema,
  type EncryptedHouseholdEnvelope,
  type EncryptedHouseholdSnapshot,
} from "@streamer-ai/contracts";

export class EncryptedHouseholdError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

type Cipher = EncryptedHouseholdEnvelope["payload"];
type Context = Pick<
  EncryptedHouseholdEnvelope,
  "datasetId" | "keyVersion" | "recoveryVersion"
>;

export function recoveryKey(): string {
  return `STRM-R1-${randomBytes(32).toString("base64url")}`;
}

export function decodeRecoveryKey(value: string): Buffer {
  const match = /^STRM-R1-([A-Za-z0-9_-]{43})$/.exec(value.trim());
  if (!match?.[1]) throw new EncryptedHouseholdError("INVALID_RECOVERY_KEY");
  return decode(match[1], 32);
}

function decode(value: string, bytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (bytes !== undefined && decoded.length !== bytes)
  ) {
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD");
  }
  return decoded;
}

function aad(
  context: Context,
  purpose: "recovery" | "snapshot",
  envelope?: EncryptedHouseholdEnvelope,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      "streamerai-encrypted-household",
      1,
      context.datasetId,
      context.keyVersion,
      context.recoveryVersion,
      purpose,
      ...(envelope
        ? [envelope.snapshotId, envelope.sequence, envelope.createdAt]
        : []),
    ]),
    "utf8",
  );
}

function seal(key: Buffer, plaintext: Buffer, authenticated: Buffer): Cipher {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(authenticated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function open(key: Buffer, encrypted: Cipher, authenticated: Buffer): Buffer {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      decode(encrypted.nonce, 12),
      { authTagLength: 16 },
    );
    decipher.setAAD(authenticated);
    decipher.setAuthTag(decode(encrypted.tag, 16));
    // Nothing is consumed or parsed before authentication has succeeded.
    return Buffer.concat([
      decipher.update(decode(encrypted.ciphertext)),
      decipher.final(),
    ]);
  } catch {
    throw new EncryptedHouseholdError("HOUSEHOLD_AUTHENTICATION_FAILED");
  }
}

export function wrapHouseholdKey(
  context: Context,
  dataKey: Buffer,
  key: string,
): Cipher {
  const recovery = decodeRecoveryKey(key);
  try {
    return seal(recovery, dataKey, aad(context, "recovery"));
  } finally {
    recovery.fill(0);
  }
}

export function parseHouseholdEnvelope(
  input: unknown,
): EncryptedHouseholdEnvelope {
  if (
    Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") >
    ENCRYPTED_HOUSEHOLD_MAX_BYTES
  ) {
    throw new EncryptedHouseholdError("HOUSEHOLD_EXPORT_TOO_LARGE");
  }
  const parsed = EncryptedHouseholdEnvelopeSchema.safeParse(input);
  if (!parsed.success)
    throw new EncryptedHouseholdError("INVALID_ENCRYPTED_HOUSEHOLD");
  return parsed.data;
}

export function sealHouseholdSnapshot(
  header: Omit<EncryptedHouseholdEnvelope, "payload">,
  snapshot: EncryptedHouseholdSnapshot,
  dataKey: Buffer,
): EncryptedHouseholdEnvelope {
  const verified = EncryptedHouseholdSnapshotSchema.safeParse(snapshot);
  if (!verified.success || snapshot.datasetId !== header.datasetId) {
    throw new EncryptedHouseholdError("INVALID_HOUSEHOLD_SNAPSHOT");
  }
  const plaintext = Buffer.from(JSON.stringify(verified.data), "utf8");
  try {
    const envelope = {
      ...header,
      payload: seal(
        dataKey,
        plaintext,
        aad(header, "snapshot", header as EncryptedHouseholdEnvelope),
      ),
    };
    return parseHouseholdEnvelope(envelope);
  } finally {
    plaintext.fill(0);
  }
}

export function openHouseholdSnapshot(
  input: unknown,
  key: string,
): {
  envelope: EncryptedHouseholdEnvelope;
  snapshot: EncryptedHouseholdSnapshot;
  dataKey: Buffer;
} {
  const envelope = parseHouseholdEnvelope(input);
  const recovery = decodeRecoveryKey(key);
  let dataKey: Buffer | undefined;
  try {
    dataKey = open(recovery, envelope.recovery, aad(envelope, "recovery"));
    if (dataKey.length !== 32)
      throw new EncryptedHouseholdError("HOUSEHOLD_AUTHENTICATION_FAILED");
    const plaintext = open(
      dataKey,
      envelope.payload,
      aad(envelope, "snapshot", envelope),
    );
    try {
      const snapshot = EncryptedHouseholdSnapshotSchema.safeParse(
        JSON.parse(plaintext.toString("utf8")),
      );
      if (!snapshot.success || snapshot.data.datasetId !== envelope.datasetId) {
        throw new EncryptedHouseholdError("INVALID_HOUSEHOLD_SNAPSHOT");
      }
      return { envelope, snapshot: snapshot.data, dataKey };
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    dataKey?.fill(0);
    if (error instanceof EncryptedHouseholdError) throw error;
    throw new EncryptedHouseholdError("INVALID_HOUSEHOLD_SNAPSHOT");
  } finally {
    recovery.fill(0);
  }
}
