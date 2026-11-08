import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStreamerDatabase } from "@streamer-ai/database";
import { resetInstallationOwner } from "../src/installation-recovery.js";
import { acquireServerRuntimeLock } from "../src/services/runtime-lock.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("local owner recovery", () => {
  it("only changes access state and refuses to run against an active server", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "streamerai-owner-recovery-test-"),
    );
    directories.push(directory);
    const database = openStreamerDatabase({
      filename: join(directory, "streamer-ai.db"),
    });
    database.settings.set("server.localAccess", {
      claimed: true,
      devices: [{ id: "old-owner" }],
    });
    database.profiles.create({
      id: "preserved",
      name: "Viewer",
      locale: "en",
      accountId: "local",
    });
    database.auth.createSession({
      tokenHash: "a".repeat(64),
      accountId: "local",
      deviceId: "test-device",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    database.close();
    const lock = acquireServerRuntimeLock(directory);
    expect(() => resetInstallationOwner(directory)).toThrow("already in use");
    lock.release();
    resetInstallationOwner(directory);
    expect(existsSync(join(directory, "installation-bootstrap.key"))).toBe(
      false,
    );
    const restored = openStreamerDatabase({
      filename: join(directory, "streamer-ai.db"),
    });
    expect(restored.settings.get("server.localAccess")).toEqual({
      claimed: false,
      devices: [],
    });
    expect(restored.profiles.get("preserved")?.name).toBe("Viewer");
    expect(restored.auth.getSession("a".repeat(64))).toBeNull();
    restored.close();
  });
});
