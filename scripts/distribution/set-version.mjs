import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * One release version for every shipped component. The server reads its own
 * package manifest at runtime, the Windows/Linux bundles use the root manifest,
 * the desktop client is versioned by electron-builder from its manifest and the
 * Android build derives versionName/versionCode from the client manifest.
 */
export const VERSIONED_MANIFESTS = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/client/package.json",
  "packages/discovery/package.json",
];
export const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function androidVersionCode(version) {
  const match = RELEASE_VERSION.exec(version);
  if (!match) throw new Error(`Invalid release version: ${version}`);
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (minor > 999 || patch > 999 || major > 2000)
    throw new Error("Version parts are too large for an Android versionCode.");
  // A prerelease shares the code of its final version; Android accepts an
  // equal versionCode as an update, only lower codes are refused.
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function setVersion(version, repository) {
  if (!RELEASE_VERSION.test(version))
    throw new Error(
      `Invalid release version "${version}". Use MAJOR.MINOR.PATCH[-prerelease].`,
    );
  const changed = [];
  for (const relative of VERSIONED_MANIFESTS) {
    const filename = path.join(repository, relative);
    const text = readFileSync(filename, "utf8");
    const manifest = JSON.parse(text);
    if (manifest.version === version) continue;
    const updated = text.replace(
      /("version"\s*:\s*")[^"]*(")/,
      `$1${version}$2`,
    );
    if (JSON.parse(updated).version !== version)
      throw new Error(`Could not update ${relative}.`);
    writeFileSync(filename, updated);
    changed.push(relative);
  }
  return { version, androidVersionCode: androidVersionCode(version), changed };
}

export function checkVersions(repository) {
  const versions = new Map(
    VERSIONED_MANIFESTS.map((relative) => [
      relative,
      JSON.parse(readFileSync(path.join(repository, relative), "utf8")).version,
    ]),
  );
  const distinct = new Set(versions.values());
  if (distinct.size !== 1)
    throw new Error(
      `Release manifests disagree: ${[...versions].map(([file, value]) => `${file}=${value}`).join(", ")}`,
    );
  return [...distinct][0];
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const [argument] = process.argv.slice(2);
  if (!argument || argument === "--check") {
    console.log(checkVersions(repository));
  } else {
    console.log(
      JSON.stringify(setVersion(argument.replace(/^v/, ""), repository)),
    );
  }
}
