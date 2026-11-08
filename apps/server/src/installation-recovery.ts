import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openStreamerDatabase } from "@streamer-ai/database";
import { acquireServerRuntimeLock } from "./services/runtime-lock.js";
import { loadLocalEnvironment, readRuntimeConfig } from "./runtime-config.js";

/** Local OS administration only; this operation is not available through HTTP. */
export function resetInstallationOwner(dataDirectory: string): void {
  const directory = resolve(dataDirectory);
  const lock = acquireServerRuntimeLock(directory);
  try {
    const database = openStreamerDatabase({
      filename: resolve(directory, "streamer-ai.db"),
    });
    try {
      database.transaction(() => {
        database.settings.set("server.localAccess", {
          claimed: false,
          devices: [],
        });
        for (const account of database.accounts.list())
          for (const session of database.auth.listDeviceHistory(account.id))
            database.auth.revokeSession(session.tokenHash);
      });
    } finally {
      database.close();
    }
  } finally {
    lock.release();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (!process.argv.includes("--reset-owner")) {
    process.stderr.write(
      "Stop the server, then run installation-recovery.js --reset-owner [--data-dir DIRECTORY]. This revokes device sessions and preserves profiles and service credentials.\n",
    );
    process.exitCode = 1;
  } else {
    loadLocalEnvironment();
    const index = process.argv.indexOf("--data-dir");
    const directory =
      index >= 0 ? process.argv[index + 1] : readRuntimeConfig().server.dataDir;
    if (!directory) throw new Error("A server data directory is required.");
    resetInstallationOwner(directory);
    process.stdout.write(
      "Device access revoked. Open /admin and sign in with your household Master PIN.\n",
    );
  }
}
