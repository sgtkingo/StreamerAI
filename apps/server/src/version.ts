import { readFileSync } from "node:fs";

const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The single server version source: the server package manifest. Both the
 * development tree (src/) and the installed release (app/dist/) keep that
 * manifest one directory above this module. `pnpm release:version` keeps the
 * workspace manifests in step.
 */
function readServerVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };
    if (
      typeof manifest.version === "string" &&
      RELEASE_VERSION.test(manifest.version)
    )
      return manifest.version;
  } catch {
    // Fall through to a recognisable non-release value.
  }
  return "0.0.0";
}

export const SERVER_VERSION = readServerVersion();
