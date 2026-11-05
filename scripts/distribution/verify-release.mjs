import { createHash, createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const FORMAT = "streamerai-signed-release/v1";
const MAX_METADATA = 256 * 1024;

function fail(message) {
  throw new Error(message);
}
function integer(value) {
  return Number.isSafeInteger(value) && value > 0;
}
function fresh(value, now) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    Date.parse(value) > now
  );
}
function versionParts(value) {
  if (typeof value !== "string") fail("Invalid version.");
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/.exec(
      value,
    );
  if (!match) fail("Invalid version.");
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts.some((part) => !Number.isSafeInteger(part)))
    fail("Invalid version.");
  return [...parts, match[4]];
}
function older(version, current) {
  const left = versionParts(version),
    right = versionParts(current);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  // Prototype intentionally refuses prerelease-to-prerelease transitions at
  // equal numeric versions; use an increased numeric version for beta builds.
  if (left[3] === right[3]) return false;
  if (left[3] && !right[3]) return true;
  if (!left[3] && right[3]) return false;
  return true;
}

export function verifyRelease({
  root,
  envelope,
  state = {},
  currentVersion,
  platform,
  channel = "stable",
  now = Date.now(),
}) {
  if (
    root?.format !== "streamerai-update-trust/v1" ||
    !integer(root.epoch) ||
    !fresh(root.expiresAt, now) ||
    !integer(root.threshold)
  )
    fail("Invalid or expired locally pinned update trust.");
  const keyEntries = Object.entries(root.keys ?? {});
  if (root.threshold > keyEntries.length || keyEntries.length > 32)
    fail("Invalid signature threshold.");
  if (
    !Array.isArray(root.allowedDownloadOrigins) ||
    !root.allowedDownloadOrigins.length
  )
    fail("Missing trusted download origins.");
  const allowedOrigins = root.allowedDownloadOrigins.map((origin) => {
    const url = new URL(origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== origin ||
      url.username ||
      url.password
    )
      fail("Invalid trusted download origin.");
    return url.origin;
  });
  const uniquePublicKeys = new Set();
  const keys = new Map(
    keyEntries.map(([keyId, pem]) => {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(keyId))
        fail("Invalid signing key ID.");
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== "ed25519")
        fail("Update trust only supports Ed25519 keys.");
      const identity = key
        .export({ type: "spki", format: "der" })
        .toString("base64");
      if (uniquePublicKeys.has(identity))
        fail("Update trust repeats the same public key.");
      uniquePublicKeys.add(identity);
      return [keyId, key];
    }),
  );
  if (
    typeof envelope?.payload !== "string" ||
    envelope.payload.length > MAX_METADATA ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length > 32
  )
    fail("Invalid signed envelope.");
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.toString("base64") !== envelope.payload)
    fail("Noncanonical payload encoding.");
  const validKeys = new Set();
  for (const signature of envelope.signatures) {
    if (
      !signature ||
      typeof signature.keyId !== "string" ||
      typeof signature.signature !== "string"
    )
      continue;
    const key = keys.get(signature.keyId);
    const bytes = Buffer.from(signature.signature, "base64");
    if (key && bytes.length === 64 && verify(null, payload, key, bytes))
      validKeys.add(signature.keyId);
  }
  if (validKeys.size < root.threshold)
    fail("Release signature threshold not met.");
  const metadata = JSON.parse(payload.toString("utf8"));
  const metadataHash = createHash("sha256").update(payload).digest("hex");
  if (
    metadata.format !== FORMAT ||
    metadata.trustEpoch !== root.epoch ||
    !integer(metadata.sequence) ||
    metadata.channel !== channel ||
    !["stable", "beta"].includes(channel) ||
    !fresh(metadata.expiresAt, now)
  )
    fail("Invalid, expired, or mismatched release metadata.");
  if (
    !fresh(metadata.issuedAt, 0) ||
    Date.parse(metadata.issuedAt) > now + 5 * 60 * 1000 ||
    Date.parse(metadata.expiresAt) <= Date.parse(metadata.issuedAt) ||
    Date.parse(metadata.expiresAt) - Date.parse(metadata.issuedAt) >
      31 * 24 * 60 * 60 * 1000
  )
    fail("Invalid release validity window.");
  if (older(metadata.version, currentVersion))
    fail("Release downgrade refused.");
  if (channel === "stable" && versionParts(metadata.version)[3])
    fail("Stable channel must not contain prereleases.");
  const stateChannel = `${root.epoch}:${channel}`;
  const previous = state.channels?.[stateChannel];
  if (
    state.trustEpoch > root.epoch ||
    (previous &&
      (metadata.sequence < previous.sequence ||
        (metadata.sequence === previous.sequence &&
          previous.metadataHash !== metadataHash)))
  )
    fail("Release metadata replay or equivocation refused.");
  if (!Array.isArray(metadata.artifacts) || metadata.artifacts.length > 16)
    fail("Invalid artifacts.");
  const artifacts = metadata.artifacts.filter(
    (artifact) => artifact.platform === platform,
  );
  if (artifacts.length !== 1 || !["win-x64", "linux-x64"].includes(platform))
    fail("Release does not contain exactly one matching platform artifact.");
  const artifact = artifacts[0];
  if (
    typeof artifact.filename !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(artifact.filename) ||
    !integer(artifact.bytes) ||
    artifact.bytes > 8 * 1024 ** 3 ||
    !/^[a-f0-9]{64}$/.test(artifact.sha256)
  )
    fail("Invalid artifact descriptor.");
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    !allowedOrigins.includes(url.origin) ||
    url.username ||
    url.password ||
    url.hash
  )
    fail("Untrusted artifact URL.");
  return {
    metadata,
    metadataHash,
    artifact,
    state: {
      ...state,
      trustEpoch: root.epoch,
      channels: {
        ...state.channels,
        [stateChannel]: { sequence: metadata.sequence, metadataHash },
      },
    },
  };
}

/** Verify an offline download. Never extracts, launches, or activates a package. */
export function verifyArtifact(filename, artifact) {
  if (statSync(filename).size !== artifact.bytes)
    fail("Artifact length or SHA-256 verification failed.");
  const descriptor = openSync(filename, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  let length;
  try {
    while ((length = readSync(descriptor, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, length));
  } finally {
    closeSync(descriptor);
  }
  if (hash.digest("hex") !== artifact.sha256)
    fail("Artifact length or SHA-256 verification failed.");
}

export function stageRelease({
  rootFile,
  metadataFile,
  artifactFile,
  stateFile,
  stageDirectory,
  currentVersion,
  platform,
  channel = "stable",
  commit = false,
}) {
  if (
    statSync(rootFile).size > MAX_METADATA ||
    statSync(metadataFile).size > MAX_METADATA * 2
  )
    fail("Metadata is too large.");
  const load = (file) => JSON.parse(readFileSync(file, "utf8"));
  const check = () =>
    verifyRelease({
      root: load(rootFile),
      envelope: load(metadataFile),
      state: existsSync(stateFile) ? load(stateFile) : {},
      currentVersion,
      platform,
      channel,
    });
  let verified = check();
  verifyArtifact(artifactFile, verified.artifact);
  if (!commit)
    return {
      version: verified.metadata.version,
      verified: true,
      staged: false,
      activationImplemented: false,
    };
  mkdirSync(stageDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const lock = `${stateFile}.lock`;
  const descriptor = openSync(lock, "wx", 0o600);
  let temporary;
  try {
    // Re-read high-water mark after acquiring the lock; concurrent checks may
    // have staged newer metadata since the read-only verification above.
    verified = check();
    const target = path.join(stageDirectory, verified.artifact.filename);
    temporary = `${target}.${process.pid}.partial`;
    copyFileSync(artifactFile, temporary, constants.COPYFILE_EXCL);
    verifyArtifact(temporary, verified.artifact);
    if (existsSync(target)) {
      verifyArtifact(target, verified.artifact);
      unlinkSync(temporary);
    } else renameSync(temporary, target);
    temporary = undefined;
    const stateTemporary = `${stateFile}.${process.pid}.partial`;
    writeFileSync(
      stateTemporary,
      `${JSON.stringify(verified.state, null, 2)}\n`,
      { mode: 0o600, flag: "wx" },
    );
    renameSync(stateTemporary, stateFile);
    return {
      version: verified.metadata.version,
      verified: true,
      staged: true,
      activationImplemented: false,
      artifact: target,
    };
  } finally {
    closeSync(descriptor);
    unlinkSync(lock);
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      metadata: { type: "string" },
      artifact: { type: "string" },
      state: { type: "string" },
      staging: { type: "string" },
      "current-version": { type: "string" },
      platform: { type: "string" },
      channel: { type: "string", default: "stable" },
      commit: { type: "boolean", default: false },
    },
  });
  if (
    [
      "root",
      "metadata",
      "artifact",
      "state",
      "staging",
      "current-version",
      "platform",
    ].some((key) => !values[key])
  )
    fail(
      "Required: --root --metadata --artifact --state --staging --current-version --platform [--channel stable|beta] [--commit]. Verification is read-only unless --commit is given.",
    );
  console.log(
    JSON.stringify(
      stageRelease({
        rootFile: values.root,
        metadataFile: values.metadata,
        artifactFile: values.artifact,
        stateFile: values.state,
        stageDirectory: values.staging,
        currentVersion: values["current-version"],
        platform: values.platform,
        channel: values.channel,
        commit: values.commit,
      }),
    ),
  );
}
