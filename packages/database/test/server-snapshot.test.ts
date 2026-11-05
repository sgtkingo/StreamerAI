import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectStreamerDatabaseSnapshot,
  openStreamerDatabase,
  snapshotStreamerDatabaseFile,
} from "../src/index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("SQLite server snapshot", () => {
  it("serializes committed WAL pages while the original database remains open", () => {
    const directory = mkdtempSync(join(tmpdir(), "streamer-db-snapshot-"));
    directories.push(directory);
    const filename = join(directory, "original.db"),
      db = openStreamerDatabase({ filename });
    try {
      db.profiles.create({
        id: "committed-in-wal",
        name: "Committed viewer",
        locale: "cs",
      });
      db.settings.set("snapshot.nested", { stillInWal: true });
      const snapshot = snapshotStreamerDatabaseFile(filename);
      expect(inspectStreamerDatabaseSnapshot(snapshot.bytes).accounts).toEqual([
        { id: "local", name: "StreamerAI", profiles: 1 },
      ]);
      mkdirSync(join(directory, "target"));
      const restoredFile = join(directory, "target", "restore.db");
      writeFileSync(restoredFile, snapshot.bytes);
      const restored = openStreamerDatabase({ filename: restoredFile });
      try {
        expect(restored.profiles.get("committed-in-wal")?.name).toBe(
          "Committed viewer",
        );
        expect(restored.settings.get("snapshot.nested")).toEqual({
          stillInWal: true,
        });
      } finally {
        restored.close();
      }
    } finally {
      db.close();
    }
  });
});
