import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  VERSIONED_MANIFESTS,
  androidVersionCode,
  checkVersions,
  setVersion,
} from "./set-version.mjs";

function fixture(version = "0.1.0") {
  const root = mkdtempSync(path.join(tmpdir(), "streamerai-version-"));
  for (const relative of VERSIONED_MANIFESTS) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(
      path.join(root, relative),
      `{\n  "name": "x",\n  "version": "${version}",\n  "private": true\n}\n`,
    );
  }
  return root;
}

test("updates every release manifest and keeps formatting", () => {
  const root = fixture();
  const result = setVersion("0.2.0", root);
  assert.equal(result.changed.length, VERSIONED_MANIFESTS.length);
  assert.equal(result.androidVersionCode, 2000);
  assert.equal(checkVersions(root), "0.2.0");
  assert.match(
    readFileSync(path.join(root, "package.json"), "utf8"),
    /^\{\n {2}"name": "x",\n {2}"version": "0\.2\.0",/,
  );
});

test("refuses invalid versions and reports disagreement", () => {
  const root = fixture();
  assert.throws(() => setVersion("2.0", root), /Invalid release version/);
  writeFileSync(
    path.join(root, "apps/client/package.json"),
    '{"version":"9.9.9"}',
  );
  assert.throws(() => checkVersions(root), /disagree/);
});

test("android version codes are monotonic", () => {
  assert.ok(androidVersionCode("1.0.0") > androidVersionCode("0.999.999"));
  assert.equal(androidVersionCode("1.2.3-beta.1"), 1_002_003);
  assert.throws(() => androidVersionCode("0.1000.0"), /too large/);
});
