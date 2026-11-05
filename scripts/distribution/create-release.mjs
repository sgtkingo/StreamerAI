import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    version: { type: "string" },
    sequence: { type: "string" },
    epoch: { type: "string", default: "1" },
    channel: { type: "string", default: "beta" },
    expires: { type: "string" },
    "base-url": { type: "string" },
    key: { type: "string", multiple: true },
    output: { type: "string" },
  },
});
if (
  !values.version ||
  !values.sequence ||
  !values.expires ||
  !values["base-url"] ||
  !values.output ||
  !values.key?.length ||
  !positionals.length
)
  throw new Error(
    "Required: --version --sequence --expires --base-url --key <keyId>=<private-key-file> [repeat] --output <new-envelope.json> <artifact> [...]. No key is generated or published.",
  );
if (
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(values.version) ||
  !["stable", "beta"].includes(values.channel) ||
  !Number.isSafeInteger(Number(values.sequence)) ||
  Number(values.sequence) < 1 ||
  !Number.isSafeInteger(Number(values.epoch)) ||
  Number(values.epoch) < 1
)
  throw new Error("Invalid version, channel, sequence, or epoch.");
const now = new Date();
const expires = new Date(values.expires);
if (
  !Number.isFinite(expires.getTime()) ||
  expires <= now ||
  expires.getTime() - now.getTime() > 31 * 24 * 60 * 60 * 1000
)
  throw new Error("Metadata expiration must be in the next 31 days.");
const base = new URL(values["base-url"]);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  !base.pathname.endsWith("/")
)
  throw new Error("Artifact base must be an HTTPS directory URL.");
const artifacts = positionals.map((filename) => {
  const name = path.basename(filename);
  const platform = name.includes("win-x64")
    ? "win-x64"
    : name.includes("linux-x64")
      ? "linux-x64"
      : null;
  if (
    !platform ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(name) ||
    name.includes("prototype")
  )
    throw new Error(
      "Only complete named platform archives may be signed for releases.",
    );
  const contents = readFileSync(filename);
  return {
    platform,
    filename: name,
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
    url: new URL(name, base).href,
  };
});
if (
  new Set(artifacts.map((artifact) => artifact.platform)).size !==
  artifacts.length
)
  throw new Error("Only one artifact per platform is allowed.");
const payload = Buffer.from(
  JSON.stringify({
    format: "streamerai-signed-release/v1",
    trustEpoch: Number(values.epoch),
    sequence: Number(values.sequence),
    version: values.version,
    channel: values.channel,
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    artifacts,
  }),
);
const used = new Set();
const signatures = values.key.map((specification) => {
  const separator = specification.indexOf("=");
  if (separator < 1) throw new Error("Key format must be keyId=filename.");
  const keyId = specification.slice(0, separator);
  if (used.has(keyId)) throw new Error("Duplicate signing key ID.");
  used.add(keyId);
  const key = createPrivateKey(
    readFileSync(specification.slice(separator + 1)),
  );
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Only Ed25519 signing keys are accepted.");
  return { keyId, signature: sign(null, payload, key).toString("base64") };
});
writeFileSync(
  values.output,
  `${JSON.stringify({ payload: payload.toString("base64"), signatures }, null, 2)}\n`,
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Created signed metadata for ${artifacts.length} artifacts. Publication and installer acceptance remain separate steps.`,
);
