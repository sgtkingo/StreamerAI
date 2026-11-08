import { networkInterfaces } from "node:os";
import type { StreamerDatabase } from "@streamer-ai/database";
import { startDiscoveryResponder } from "@streamer-ai/discovery";
import { householdIdKey } from "./household-state.js";

export function advertisedServerUrl(webOrigin: string, explicit?: string) {
  if (explicit) return new URL(explicit).origin;
  const url = new URL(webOrigin);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    const address = Object.values(networkInterfaces())
      .flatMap((x) => x ?? [])
      .find((x) => x.family === "IPv4" && !x.internal);
    if (address) url.hostname = address.address;
  }
  return url.origin;
}

export function startHouseholdDiscovery(
  database: StreamerDatabase,
  webOrigin: string,
  explicit?: string,
) {
  return startDiscoveryResponder({
    getAnnouncement: () => {
      const account = database.accounts.getHousehold();
      return {
        serverId: database.settings.get<string>("server.instanceId")!,
        householdId: database.settings.get<string>(householdIdKey(account.id)),
        name: account.name || "StreamerAI household",
        url: advertisedServerUrl(webOrigin, explicit),
      };
    },
  });
}
