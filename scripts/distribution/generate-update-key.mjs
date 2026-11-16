import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/**
 * Creates the release signing key. The private key is written only outside
 * the repository (store it as the STREAMERAI_UPDATE_SIGNING_KEY GitHub secret
 * and in an offline backup); the public key is pinned in
 * packaging/update-trust.json, which every installer and client embeds.
 */
const repository = fileURLToPath(new URL("../../", import.meta.url));
const trustFile = path.join(repository, "packaging/update-trust.json");
const { values } = parseArgs({
  options: {
    "private-key": { type: "string" },
    "key-id": { type: "string", default: "release-1" },
    years: { type: "string", default: "3" },
    replace: { type: "boolean", default: false },
  },
});
if (!values["private-key"])
  throw new Error(
    "Usage: node scripts/distribution/generate-update-key.mjs --private-key <file outside the repository> [--key-id release-1] [--years 3] [--replace]",
  );
const privateFile = path.resolve(values["private-key"]);
mkdirSync(path.dirname(privateFile), { recursive: true });
const resolvedRepository = realpathSync(repository);
const resolvedTarget = path.join(
  realpathSync(path.dirname(privateFile)),
  path.basename(privateFile),
);
if (
  resolvedTarget
    .toLowerCase()
    .startsWith(resolvedRepository.toLowerCase() + path.sep) ||
  resolvedTarget.toLowerCase() === resolvedRepository.toLowerCase()
)
  throw new Error(
    "Refusing to write a private signing key inside the repository.",
  );
if (existsSync(privateFile))
  throw new Error("The private key file already exists.");
const trust = JSON.parse(readFileSync(trustFile, "utf8"));
if (Object.keys(trust.keys ?? {}).length && !values.replace)
  throw new Error(
    "packaging/update-trust.json already pins a key. Pass --replace only for a deliberate key rotation.",
  );
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(values["key-id"]))
  throw new Error("Invalid key ID.");
const years = Number(values.years);
if (!Number.isInteger(years) || years < 1 || years > 10)
  throw new Error("--years must be 1-10.");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(
  privateFile,
  privateKey.export({ type: "pkcs8", format: "pem" }),
  { flag: "wx", mode: 0o600 },
);
const expiresAt = new Date();
expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + years);
const updated = {
  format: "streamerai-update-trust/v1",
  epoch: values.replace ? trust.epoch + 1 : trust.epoch,
  expiresAt: expiresAt.toISOString(),
  threshold: 1,
  keys: {
    [values["key-id"]]: publicKey.export({ type: "spki", format: "pem" }),
  },
  allowedDownloadOrigins: ["https://github.com"],
};
writeFileSync(trustFile, `${JSON.stringify(updated, null, 2)}\n`);
console.log(
  [
    `Private key: ${privateFile} (keep an offline backup; never commit it).`,
    `Public key pinned in packaging/update-trust.json as "${values["key-id"]}", valid until ${updated.expiresAt}.`,
    "Store the private key as a GitHub secret, for example:",
    `  gh secret set STREAMERAI_UPDATE_SIGNING_KEY < "${privateFile}"`,
  ].join("\n"),
);
