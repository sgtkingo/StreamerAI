import { randomBytes, randomUUID } from "node:crypto";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  DEFAULT_PLAYBACK_PREFERENCES,
  type AccountSyncOperation,
  type MasterPinHouseholdBackup,
} from "@streamer-ai/contracts";
import { accounts, type fixture } from "./helpers.js";
import { hash } from "../src/http.js";

export async function deviceToken(
  f: ReturnType<typeof fixture>,
  account = "a",
) {
  const token = randomBytes(32).toString("hex"),
    deviceId = randomUUID();
  f.sqlite
    .prepare(
      "INSERT INTO cloud_device(id,account_id,name,purpose,token_hash,created_at,expires_at) VALUES(?,?,'Home server','login',?,?,?)",
    )
    .run(
      deviceId,
      accounts[account]!.id,
      await hash(token),
      f.now(),
      f.now() + 300_000,
    );
  return { token, deviceId };
}
export async function registeredHousehold(
  f: ReturnType<typeof fixture>,
  account = "a",
  householdId = randomUUID(),
) {
  const credential = await deviceToken(f, account);
  const response = await f.request("/v1/households", {
    method: "POST",
    token: credential.token,
    data: { householdId, name: `Household ${account}`, serverId: randomUUID() },
  });
  if (response.status !== 200)
    throw new Error(
      `Registration failed: ${response.status} ${await response.text()}`,
    );
  return { ...credential, householdId };
}
export function profileOperation(
  f: ReturnType<typeof fixture>,
  name: string,
  profileId = randomUUID(),
): AccountSyncOperation {
  const { audioOutputDeviceId: _device, ...playback } =
    DEFAULT_PLAYBACK_PREFERENCES;
  return {
    id: randomUUID(),
    profileId,
    entityId: profileId,
    kind: "profile",
    action: "upsert",
    updatedAt: new Date(f.now()).toISOString(),
    payload: {
      name,
      locale: "en",
      genres: [],
      playback,
      appearance: DEFAULT_APPEARANCE_PREFERENCES,
      onboardingComplete: true,
    },
  };
}
export function householdBackup(
  f: ReturnType<typeof fixture>,
  householdId: string,
): MasterPinHouseholdBackup {
  const cipher = {
    algorithm: "aes-256-gcm" as const,
    nonce: "AAAAAAAAAAAAAAAA",
    tag: "AAAAAAAAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  return {
    format: "streamerai-master-pin-household",
    version: 1,
    kdf: {
      algorithm: "argon2id",
      memory: 65536,
      passes: 3,
      parallelism: 1,
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
    },
    cloudRecovery: { ...cipher },
    envelope: {
      format: "streamerai-encrypted-household",
      version: 1,
      datasetId: householdId,
      keyVersion: 1,
      recoveryVersion: 1,
      snapshotId: randomUUID(),
      sequence: 1,
      createdAt: new Date(f.now()).toISOString(),
      recovery: { ...cipher },
      payload: { ...cipher },
    },
  };
}
