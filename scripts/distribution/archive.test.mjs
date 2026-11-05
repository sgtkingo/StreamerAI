import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { archiveBundle } from "./archive.mjs";

test("platform archiver handles literal path characters and refuses replacement", () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "streamerai-archive-"));
  try {
    const source = path.join(temporary, "literal '$()[folder]");
    const target = path.join(
      temporary,
      `archive${process.platform === "win32" ? ".zip" : ".tar.gz"}`,
    );
    mkdirSync(source);
    writeFileSync(path.join(source, ".runtime"), "runtime test");
    archiveBundle(source, target);
    const contents = readFileSync(target);
    assert.ok(contents.length > 40);
    assert.deepEqual(
      contents.subarray(0, 2),
      Buffer.from(process.platform === "win32" ? [0x50, 0x4b] : [0x1f, 0x8b]),
    );
    assert.throws(() => archiveBundle(source, target), /already exist/);
  } finally {
    assert.ok(
      path.resolve(temporary).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    rmSync(temporary, { recursive: true, force: true });
  }
});
