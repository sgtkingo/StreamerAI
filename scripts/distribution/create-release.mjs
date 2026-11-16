import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const RELEASE_FORMAT = "streamerai-signed-release/v1";
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const MAX_VALIDITY = 31 * 24 * 60 * 60 * 1000;

/**
 * Release artifacts that update clients may install. Anything else on a GitHub
 * release (for example the combined first-install setup) is not signed here.
 */
export function classifyArtifact(name, version) {
  const escaped = version.replace(/[.]/g, "\\.");
  const rules = [
    [
      new RegExp(`^streamerai-server-${escaped}-win-x64\\.zip$`),
      "win-x64",
      "server",
    ],
    [
      new RegExp(`^streamerai-server-${escaped}-linux-x64\\.tar\\.gz$`),
      "linux-x64",
      "server",
    ],
    [
      new RegExp(`^StreamerAI-Client-${escaped}-win-x64-setup\\.exe$`),
      "win-x64",
      "client",
    ],
    [
      new RegExp(`^StreamerAI-Client-${escaped}-android\\.apk$`),
      "android",
      "client",
    ],
  ];
  for (const [pattern, platform, component] of rules)
    if (pattern.test(name)) return { platform, component };
  throw new Error(
    `"${name}" is not a complete ${version} server archive, desktop client installer or Android APK.`,
  );
}

function sha256File(filename) {
  const descriptor = openSync(filename, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
}

/** keyId=path/to/key.pem or keyId=env:VARIABLE (PEM text, never written to disk). */
export function loadSigningKeys(specifications, environment = process.env) {
  const used = new Set();
  return specifications.map((specification) => {
    const separator = specification.indexOf("=");
    if (separator < 1)
      throw new Error("Key format must be keyId=filename or keyId=env:NAME.");
    const keyId = specification.slice(0, separator);
    const source = specification.slice(separator + 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(keyId))
      throw new Error("Invalid signing key ID.");
    if (used.has(keyId)) throw new Error("Duplicate signing key ID.");
    used.add(keyId);
    const pem = source.startsWith("env:")
      ? environment[source.slice(4)]
      : readFileSync(source, "utf8");
    if (!pem) throw new Error(`Signing key ${keyId} is empty or missing.`);
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Only Ed25519 signing keys are accepted.");
    return { keyId, key };
  });
}

function validity(now, expires) {
  const expiresAt = expires
    ? new Date(expires)
    : new Date(now.getTime() + 28 * 24 * 60 * 60 * 1000);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > MAX_VALIDITY
  )
    throw new Error("Metadata expiration must be in the next 31 days.");
  return expiresAt;
}

function signPayload(metadata, keys) {
  const payload = Buffer.from(JSON.stringify(metadata));
  return {
    payload: payload.toString("base64"),
    signatures: keys.map(({ keyId, key }) => ({
      keyId,
      signature: sign(null, payload, key).toString("base64"),
    })),
  };
}

export function createEnvelope({
  version,
  channel = "stable",
  epoch = 1,
  sequence = Math.floor(Date.now() / 1000),
  expires,
  baseUrl,
  keys,
  files,
  now = new Date(),
}) {
  if (!VERSION.test(version) || !["stable", "beta"].includes(channel))
    throw new Error("Invalid version or channel.");
  if (channel === "stable" && version.includes("-"))
    throw new Error("Stable releases must not be prereleases.");
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1
  )
    throw new Error("Invalid sequence or epoch.");
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !base.pathname.endsWith("/")
  )
    throw new Error("Artifact base must be an HTTPS directory URL.");
  if (!files.length) throw new Error("At least one artifact is required.");
  const artifacts = files.map((filename) => {
    const name = path.basename(filename);
    return {
      ...classifyArtifact(name, version),
      filename: name,
      bytes: statSync(filename).size,
      sha256: sha256File(filename),
      url: new URL(name, base).href,
    };
  });
  const identities = new Set(
    artifacts.map((item) => `${item.platform}/${item.component}`),
  );
  if (identities.size !== artifacts.length)
    throw new Error("Only one artifact per platform and component is allowed.");
  return signPayload(
    {
      format: RELEASE_FORMAT,
      trustEpoch: epoch,
      sequence,
      version,
      channel,
      issuedAt: now.toISOString(),
      expiresAt: validity(now, expires).toISOString(),
      artifacts,
    },
    keys,
  );
}

/**
 * Re-issue existing metadata with a fresh validity window and a higher
 * sequence. Artifacts, version and channel stay byte-for-byte the same, so an
 * unchanged release keeps verifying after the 31-day freshness limit.
 */
export function refreshEnvelope({
  envelope,
  keys,
  sequence = Math.floor(Date.now() / 1000),
  expires,
  now = new Date(),
}) {
  const previous = JSON.parse(
    Buffer.from(envelope.payload, "base64").toString("utf8"),
  );
  if (previous.format !== RELEASE_FORMAT)
    throw new Error("Unsupported release metadata.");
  if (!Number.isSafeInteger(sequence) || sequence <= previous.sequence)
    throw new Error("A refreshed release needs a higher sequence.");
  return signPayload(
    {
      ...previous,
      sequence,
      issuedAt: now.toISOString(),
      expiresAt: validity(now, expires).toISOString(),
    },
    keys,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      version: { type: "string" },
      sequence: { type: "string" },
      epoch: { type: "string", default: "1" },
      channel: { type: "string", default: "stable" },
      expires: { type: "string" },
      "base-url": { type: "string" },
      key: { type: "string", multiple: true },
      refresh: { type: "string" },
      output: { type: "string" },
    },
  });
  if (
    !values.output ||
    !values.key?.length ||
    (!values.refresh &&
      (!values.version || !values["base-url"] || !positionals.length))
  )
    throw new Error(
      "Usage: create-release.mjs --key <keyId>=<file|env:NAME> --output <new.json> (--version X --base-url https://…/ <artifact>… | --refresh <existing.json>) [--channel stable|beta] [--sequence N] [--expires ISO]. No key is generated or published.",
    );
  const keys = loadSigningKeys(values.key);
  const sequence = values.sequence ? Number(values.sequence) : undefined;
  const envelope = values.refresh
    ? refreshEnvelope({
        envelope: JSON.parse(readFileSync(values.refresh, "utf8")),
        keys,
        sequence,
        expires: values.expires,
      })
    : createEnvelope({
        version: values.version,
        channel: values.channel,
        epoch: Number(values.epoch),
        sequence,
        expires: values.expires,
        baseUrl: values["base-url"],
        keys,
        files: positionals,
      });
  writeFileSync(values.output, `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    `Created signed ${values.refresh ? "refreshed " : ""}release metadata at ${values.output}.`,
  );
}
