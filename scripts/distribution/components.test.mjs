import { test } from "node:test";
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
  validateComponentLock,
  downloadComponent,
  verifyComponentFile,
} from "./components.mjs";

const content = Buffer.from("pinned-component");
const asset = () => ({
  id: "fixture",
  version: "1.0.0",
  type: "binary",
  url: "https://github.com/example/tool/releases/download/v1.0.0/file.exe",
  bytes: content.length,
  sha256: createHash("sha256").update(content).digest("hex"),
  provenance: "Official release metadata fixture",
  outputs: [{ name: "caddy.exe" }],
});
const lock = () => ({
  format: "streamerai-components/v1",
  platform: "win-x64",
  assets: [asset()],
});

test("committed platform locks pin exact Node LTS notices and target filenames", () => {
  for (const platform of ["win-x64", "linux-x64"]) {
    const committed = validateComponentLock(
      JSON.parse(
        readFileSync(
          new URL(
            `../../packaging/component-lock.${platform}.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    assert.equal(committed.platform, platform);
    assert.equal(committed.nodeVersion, "v24.22.2");
    assert.equal(
      committed.assets.find((asset) => asset.id === "node-license").version,
      "24.22.2",
    );
    const binaries = committed.assets
      .flatMap((asset) => asset.outputs)
      .filter((output) => !output.name.endsWith(".txt"))
      .map((output) => output.name);
    assert.deepEqual(
      binaries.sort(),
      (platform === "win-x64"
        ? ["ffmpeg.exe", "ffprobe.exe", "caddy.exe", "streamerai-service.exe"]
        : ["ffmpeg", "ffprobe", "caddy"]
      ).sort(),
    );
  }
});
function temporary() {
  return mkdtempSync(path.join(tmpdir(), "streamerai-component-test-"));
}

test("component lock requires pinned releases, digests and bounded safe outputs", () => {
  assert.equal(validateComponentLock(lock()).platform, "win-x64");
  for (const change of [
    { url: "http://github.com/tool" },
    { url: "https://untrusted.example/file.exe" },
    {
      url: "https://github.com/example/tool/releases/download/latest/file.exe",
    },
    { sha256: "no-checksum" },
    { bytes: Number.MAX_SAFE_INTEGER },
    { outputs: [{ name: "../arbitrary.exe" }] },
    {
      type: "zip",
      outputs: [{ name: "caddy.exe", member: "../../escape.exe" }],
    },
  ]) {
    const candidate = lock();
    Object.assign(candidate.assets[0], change);
    assert.throws(() => validateComponentLock(candidate));
  }
});

test("component download checks pinned bytes and hash and verifies cached copies", async () => {
  const directory = temporary();
  let requests = 0;
  try {
    const filename = await downloadComponent(asset(), directory, async () => {
      requests++;
      return new Response(content);
    });
    assert.deepEqual(readFileSync(filename), content);
    await verifyComponentFile(filename, asset());
    await downloadComponent(asset(), directory, async () => {
      throw new Error("cache should not need network");
    });
    assert.equal(requests, 1);
    writeFileSync(filename, Buffer.alloc(content.length));
    await assert.rejects(
      () =>
        downloadComponent(
          asset(),
          directory,
          async () => new Response(content),
        ),
      /digest mismatch/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("component failures remove partial files and never follow foreign redirects", async () => {
  const directory = temporary();
  try {
    await assert.rejects(
      () =>
        downloadComponent(
          asset(),
          directory,
          async () => new Response("wrong"),
        ),
      /digest mismatch/,
    );
    assert.deepEqual(readdirSync(directory), []);
    await assert.rejects(
      () =>
        downloadComponent(
          asset(),
          directory,
          async () => new Response(Buffer.alloc(content.length + 1)),
        ),
      /pinned length/,
    );
    assert.deepEqual(readdirSync(directory), []);
    let requests = 0;
    await assert.rejects(
      () =>
        downloadComponent(asset(), directory, async () => {
          requests++;
          return new Response(null, {
            status: 302,
            headers: { location: "https://untrusted.example/payload" },
          });
        }),
      /Untrusted/,
    );
    assert.equal(requests, 1);
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
