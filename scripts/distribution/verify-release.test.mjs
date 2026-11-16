import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  stageRelease,
  verifyArtifact,
  verifyRelease,
} from "./verify-release.mjs";

const now = Date.now();
const keypairs = [
  generateKeyPairSync("ed25519"),
  generateKeyPairSync("ed25519"),
];
const bytes = Buffer.from("offline runtime test artifact");
const artifact = {
  platform: "win-x64",
  filename: "streamerai-server-1.2.0-win-x64.zip",
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  url: "https://github.com/sgtkingo/StreamerAI/releases/download/v1.2.0/streamerai-server-1.2.0-win-x64.zip",
};
const root = {
  format: "streamerai-update-trust/v1",
  epoch: 1,
  expiresAt: new Date(now + 86_400_000).toISOString(),
  threshold: 2,
  keys: Object.fromEntries(
    keypairs.map((pair, index) => [
      `key-${index}`,
      pair.publicKey.export({ type: "spki", format: "pem" }),
    ]),
  ),
  allowedDownloadOrigins: ["https://github.com"],
};
const metadata = {
  format: "streamerai-signed-release/v1",
  trustEpoch: 1,
  sequence: 2,
  version: "1.2.0",
  channel: "stable",
  issuedAt: new Date(now - 60_000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
  artifacts: [artifact],
};
function envelope(value = metadata) {
  const payload = Buffer.from(JSON.stringify(value));
  return {
    payload: payload.toString("base64"),
    signatures: keypairs.map((pair, index) => ({
      keyId: `key-${index}`,
      signature: sign(null, payload, pair.privateKey).toString("base64"),
    })),
  };
}
function check(overrides = {}) {
  return verifyRelease({
    root,
    envelope: envelope(),
    currentVersion: "1.1.0",
    platform: "win-x64",
    now,
    ...overrides,
  });
}

test("signed metadata verifies against independent pinned trust", () => {
  assert.equal(check().artifact.sha256, artifact.sha256);
});
test("threshold counts distinct authorized keys", () => {
  const invalid = envelope();
  invalid.signatures = [invalid.signatures[0], invalid.signatures[0]];
  assert.throws(() => check({ envelope: invalid }), /threshold/);
  assert.throws(
    () =>
      check({
        root: {
          ...root,
          keys: { "key-0": root.keys["key-0"], "key-1": root.keys["key-0"] },
        },
      }),
    /same public key/,
  );
});
test("tampering, expired metadata and expired trust are rejected", () => {
  const invalid = envelope();
  invalid.payload = Buffer.from(
    JSON.stringify({ ...metadata, version: "9.9.9" }),
  ).toString("base64");
  assert.throws(() => check({ envelope: invalid }), /threshold/);
  assert.throws(
    () =>
      check({
        envelope: envelope({
          ...metadata,
          expiresAt: new Date(now - 1).toISOString(),
        }),
      }),
    /expired/,
  );
  assert.throws(
    () =>
      check({ root: { ...root, expiresAt: new Date(now - 1).toISOString() } }),
    /expired/,
  );
});
test("wrong channel, platform, trust epoch, and download origin are rejected", () => {
  assert.throws(() => check({ channel: "beta" }), /mismatched/);
  assert.throws(() => check({ platform: "linux-x64" }), /platform/);
  assert.throws(
    () => check({ envelope: envelope({ ...metadata, trustEpoch: 2 }) }),
    /mismatched/,
  );
  assert.throws(
    () =>
      check({
        envelope: envelope({
          ...metadata,
          artifacts: [{ ...artifact, url: "https://evil.example/server.zip" }],
        }),
      }),
    /Untrusted/,
  );
});
test("rollback, replay and equivocation cannot lower accepted metadata", () => {
  const accepted = check();
  assert.equal(check({ state: accepted.state }).metadata.sequence, 2);
  assert.throws(() => check({ currentVersion: "2.0.0" }), /downgrade/);
  assert.throws(
    () =>
      check({
        state: accepted.state,
        envelope: envelope({ ...metadata, sequence: 1 }),
      }),
    /replay/,
  );
  assert.throws(
    () =>
      check({
        state: accepted.state,
        envelope: envelope({ ...metadata, version: "1.3.0" }),
      }),
    /equivocation/,
  );
});
test("invalid artifact paths, validity windows, digests and lengths are rejected", () => {
  assert.throws(
    () =>
      check({
        envelope: envelope({
          ...metadata,
          artifacts: [{ ...artifact, filename: "../payload.zip" }],
        }),
      }),
    /descriptor/,
  );
  assert.throws(
    () =>
      check({
        envelope: envelope({
          ...metadata,
          issuedAt: new Date(now + 600_000).toISOString(),
        }),
      }),
    /validity/,
  );
  assert.throws(
    () =>
      check({
        envelope: envelope({
          ...metadata,
          artifacts: [{ ...artifact, bytes: -1 }],
        }),
      }),
    /descriptor/,
  );
});
test("offline verification is read-only; commit stages and persists replay protection", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "streamerai-updates-"));
  try {
    const paths = {
      rootFile: path.join(directory, "root.json"),
      metadataFile: path.join(directory, "release.json"),
      artifactFile: path.join(directory, "download.zip"),
      stateFile: path.join(directory, "state.json"),
      stageDirectory: path.join(directory, "stage"),
      currentVersion: "1.1.0",
      platform: "win-x64",
    };
    writeFileSync(paths.rootFile, JSON.stringify(root));
    writeFileSync(paths.metadataFile, JSON.stringify(envelope()));
    writeFileSync(paths.artifactFile, bytes);
    assert.equal(stageRelease(paths).staged, false);
    assert.equal(existsSync(paths.stateFile), false);
    assert.equal(existsSync(paths.stageDirectory), false);
    const staged = stageRelease({ ...paths, commit: true });
    assert.equal(staged.staged, true);
    assert.deepEqual(readFileSync(staged.artifact), bytes);
    assert.equal(
      JSON.parse(readFileSync(paths.stateFile)).channels["1:stable"].sequence,
      2,
    );
    writeFileSync(
      paths.metadataFile,
      JSON.stringify(envelope({ ...metadata, sequence: 1 })),
    );
    assert.throws(() => stageRelease({ ...paths, commit: true }), /replay/);
    writeFileSync(paths.artifactFile, "tampered artifact");
    assert.throws(
      () => verifyArtifact(paths.artifactFile, artifact),
      /verification/,
    );
  } finally {
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test("offline signing CLI produces an envelope accepted by independent verification", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "streamerai-signing-"));
  try {
    const archive = path.join(directory, artifact.filename);
    const output = path.join(directory, "signed.json");
    writeFileSync(archive, bytes);
    const signingArguments = [];
    for (const [index, pair] of keypairs.entries()) {
      const file = path.join(directory, `key-${index}.pem`);
      writeFileSync(
        file,
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
        { flag: "wx", mode: 0o600 },
      );
      signingArguments.push("--key", `key-${index}=${file}`);
    }
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./create-release.mjs", import.meta.url)),
        "--version",
        "1.2.0",
        "--sequence",
        "2",
        "--channel",
        "stable",
        "--expires",
        metadata.expiresAt,
        "--base-url",
        "https://github.com/sgtkingo/StreamerAI/releases/download/v1.2.0/",
        ...signingArguments,
        "--output",
        output,
        archive,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      check({ envelope: JSON.parse(readFileSync(output, "utf8")) }).artifact
        .sha256,
      artifact.sha256,
    );
    assert.doesNotMatch(result.stdout, /PRIVATE KEY/);
  } finally {
    assert.ok(
      path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep),
    );
    rmSync(directory, { recursive: true, force: true });
  }
});

test("components select the server archive, desktop client or Android APK", () => {
  const client = {
    ...artifact,
    component: "client",
    filename: "StreamerAI-Client-1.2.0-win-x64-setup.exe",
  };
  const android = { ...artifact, platform: "android", component: "client" };
  const value = { ...metadata, artifacts: [artifact, client, android] };
  const options = { envelope: envelope(value) };
  assert.equal(check(options).artifact.filename, artifact.filename);
  assert.equal(
    check({ ...options, component: "client" }).artifact.filename,
    client.filename,
  );
  assert.equal(
    check({ ...options, platform: "android", component: "client" }).artifact
      .platform,
    "android",
  );
  assert.throws(
    () => check({ ...options, platform: "android" }),
    /exactly one matching/,
  );
  assert.throws(
    () => check({ ...options, component: "setup" }),
    /exactly one matching/,
  );
});

test("signing classifies artifacts and refresh keeps them with a higher sequence", async () => {
  const { classifyArtifact, createEnvelope, refreshEnvelope } =
    await import("./create-release.mjs");
  assert.deepEqual(
    classifyArtifact("StreamerAI-Client-1.2.0-android.apk", "1.2.0"),
    { platform: "android", component: "client" },
  );
  assert.throws(
    () => classifyArtifact("StreamerAI-1.2.0-win-x64-setup.exe", "1.2.0"),
    /not a complete/,
  );
  assert.throws(
    () => classifyArtifact("streamerai-server-1.1.0-win-x64.zip", "1.2.0"),
    /not a complete/,
  );
  const directory = mkdtempSync(path.join(tmpdir(), "streamerai-refresh-"));
  try {
    const archive = path.join(directory, artifact.filename);
    writeFileSync(archive, bytes);
    const keys = keypairs.map((pair, index) => ({
      keyId: `key-${index}`,
      key: pair.privateKey,
    }));
    const created = createEnvelope({
      version: "1.2.0",
      sequence: 2,
      baseUrl:
        "https://github.com/sgtkingo/StreamerAI/releases/download/v1.2.0/",
      keys,
      files: [archive],
    });
    const first = check({ envelope: created });
    assert.equal(first.artifact.component, "server");
    assert.throws(
      () => refreshEnvelope({ envelope: created, keys, sequence: 2 }),
      /higher sequence/,
    );
    const refreshed = refreshEnvelope({ envelope: created, keys, sequence: 3 });
    const second = check({ envelope: refreshed, state: first.state });
    assert.equal(second.metadata.sequence, 3);
    assert.deepEqual(second.artifact, first.artifact);
    assert.throws(
      () => check({ envelope: created, state: second.state }),
      /replay/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
