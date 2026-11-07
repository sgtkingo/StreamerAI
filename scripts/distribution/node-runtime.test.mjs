import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  downloadRuntimeAsset,
  validateNodeRuntimeLock,
  verifyRuntimeAsset,
} from "./node-runtime.mjs";

const committed = JSON.parse(
  readFileSync(
    new URL("../../packaging/node-runtime.win-x64.lock.json", import.meta.url),
    "utf8",
  ),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fixture = (value = "verified runtime fixture") => ({
  id: "runtime-fixture",
  url: "https://nodejs.org/dist/v24.22.2/win-x64/node.exe",
  bytes: Buffer.byteLength(value),
  sha256: hash(value),
});

test("target runtime pins official Node24 and exact SQLite137 assets", () => {
  const lock = validateNodeRuntimeLock(committed);
  assert.equal(lock.nodeVersion, "v24.22.2");
  assert.equal(lock.nodeAbi, "137");
  assert.equal(lock.sqliteVersion, "12.11.1");
  for (const bad of [
    { ...lock, nodeVersion: "v25.6.0" },
    { ...lock, nodeAbi: "141" },
    { ...lock, sqlite: { ...lock.sqlite, member: "../better_sqlite3.node" } },
    { ...lock, node: { ...lock.node, url: "https://example.com/node.exe" } },
    {
      ...lock,
      sqlite: {
        ...lock.sqlite,
        url: lock.sqlite.url.replace("v12.11.1", "latest"),
      },
    },
  ])
    assert.throws(() => validateNodeRuntimeLock(bad));
});

test("verified downloads are reused without a second request", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "streamerai-node-runtime-test-"),
  );
  try {
    let requests = 0;
    const asset = fixture();
    const fetcher = async (_url, options) => {
      requests++;
      assert.equal(options.redirect, "manual");
      return new Response("verified runtime fixture");
    };
    const first = await downloadRuntimeAsset(asset, directory, fetcher);
    const second = await downloadRuntimeAsset(asset, directory, fetcher);
    assert.equal(first, second);
    assert.equal(requests, 1);
    await verifyRuntimeAsset(first, asset);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("wrong bytes, excess length and truncation never publish a usable input", async () => {
  for (const value of [
    "unverified runtime data",
    "verified runtime fixture plus extra",
    "short",
  ]) {
    const directory = mkdtempSync(
      path.join(tmpdir(), "streamerai-node-runtime-test-"),
    );
    try {
      await assert.rejects(
        downloadRuntimeAsset(
          fixture(),
          directory,
          async () => new Response(value),
        ),
      );
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("cached tampering fails rather than silently replacing a local file", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "streamerai-node-runtime-test-"),
  );
  try {
    const asset = fixture();
    const filename = await downloadRuntimeAsset(
      asset,
      directory,
      async () => new Response("verified runtime fixture"),
    );
    writeFileSync(filename, "changed runtime contents");
    await assert.rejects(
      downloadRuntimeAsset(asset, directory, async () => {
        throw new Error("network must not be called");
      }),
      /mismatch/,
    );
    assert.equal(readFileSync(filename, "utf8"), "changed runtime contents");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redirects cannot escape official HTTPS download hosts", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "streamerai-node-runtime-test-"),
  );
  try {
    for (const location of [
      "https://evil.example/runtime.exe",
      "http://nodejs.org/runtime.exe",
      "https://user:password@nodejs.org/runtime.exe",
    ]) {
      let requests = 0;
      await assert.rejects(
        downloadRuntimeAsset(fixture(), directory, async () => {
          requests++;
          return new Response(null, { status: 302, headers: { location } });
        }),
        /Untrusted runtime download origin/,
      );
      assert.equal(requests, 1);
    }
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("redirect limits and HTTP failure do not create partial output", async () => {
  const directory = mkdtempSync(
    path.join(tmpdir(), "streamerai-node-runtime-test-"),
  );
  try {
    await assert.rejects(
      downloadRuntimeAsset(
        fixture(),
        directory,
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://nodejs.org/again" },
          }),
      ),
      /redirect limit/,
    );
    await assert.rejects(
      downloadRuntimeAsset(
        fixture(),
        directory,
        async () => new Response(null, { status: 503 }),
      ),
      /503/,
    );
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
