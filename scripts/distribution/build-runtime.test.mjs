import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildRuntime, fileInventory } from "./build-runtime.mjs";

test("production closure runs compiled server and native SQLite without developer tools", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "streamerai-runtime-"));
  try {
    const output = path.join(temporary, "app");
    const built = buildRuntime(output);
    assert.ok(built.packages > 0);
    assert.ok(fileInventory(output).length > 0);
    assert.equal(existsSync(path.join(output, "node_modules/tsx")), false);
    assert.equal(
      existsSync(path.join(output, "node_modules/typescript")),
      false,
    );
    const manifest = JSON.parse(
      readFileSync(
        path.join(output, "node_modules/@streamer-ai/database/package.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.exports["."], "./src/index.js");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import './dist/index.js'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); const DB=require('better-sqlite3'); const db=new DB(':memory:'); if(db.prepare('SELECT 42 AS answer').get().answer!==42) process.exit(1); db.close(); console.log('plain JavaScript and SQLite OK');",
      ],
      { cwd: output, encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /SQLite OK/);
    assert.throws(() => buildRuntime(output), /must not already exist/);
  } finally {
    assert.ok(
      path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    rmSync(temporary, { recursive: true, force: true });
  }
});
