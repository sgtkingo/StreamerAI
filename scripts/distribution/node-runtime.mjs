import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  copyFileSync,
  constants,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const origins = new Set([
  "https://nodejs.org",
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
  "https://raw.githubusercontent.com",
]);

export function validateNodeRuntimeLock(value) {
  if (
    !value ||
    value.format !== "streamerai-node-runtime/v1" ||
    value.platform !== "win-x64" ||
    !/^v24\.\d+\.\d+$/.test(value.nodeVersion) ||
    value.nodeAbi !== "137" ||
    !/^\d+\.\d+\.\d+$/.test(value.sqliteVersion)
  )
    throw new Error("Invalid Node runtime lock.");
  const expectedNode = `https://nodejs.org/dist/${value.nodeVersion}/win-x64/node.exe`;
  const expectedSqlite = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${value.sqliteVersion}/better-sqlite3-v${value.sqliteVersion}-node-v${value.nodeAbi}-win32-x64.tar.gz`;
  if (
    value.node?.url !== expectedNode ||
    value.sqlite?.url !== expectedSqlite ||
    value.nodeLicense?.url !==
      `https://raw.githubusercontent.com/nodejs/node/${value.nodeVersion}/LICENSE` ||
    value.sqlite.member !== "build/Release/better_sqlite3.node"
  )
    throw new Error(
      "Node runtime assets require exact official release URLs and archive member.",
    );
  for (const asset of [value.node, value.sqlite, value.nodeLicense]) {
    if (
      !/^[a-z0-9-]{1,80}$/.test(asset.id) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > 160 * 1024 * 1024 ||
      typeof asset.provenance !== "string"
    )
      throw new Error("Invalid pinned runtime asset.");
  }
  return value;
}

export async function verifyRuntimeAsset(filename, asset) {
  if (
    !existsSync(filename) ||
    lstatSync(filename).isSymbolicLink() ||
    !statSync(filename).isFile() ||
    statSync(filename).size !== asset.bytes
  )
    throw new Error("Runtime asset size or file type mismatch.");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest("hex") !== asset.sha256)
    throw new Error("Runtime asset digest mismatch.");
}

async function responseFor(url, fetcher, remaining = 5) {
  const parsed = new URL(url);
  if (!origins.has(parsed.origin) || parsed.username || parsed.password)
    throw new Error("Untrusted runtime download origin.");
  const response = await fetcher(parsed, {
    redirect: "manual",
    signal: AbortSignal.timeout(120000),
    headers: { "user-agent": "StreamerAI-runtime-builder" },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || remaining <= 0)
      throw new Error("Runtime redirect limit reached.");
    return responseFor(new URL(location, parsed), fetcher, remaining - 1);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Runtime download failed (${response.status}).`);
  }
  return response;
}

export async function downloadRuntimeAsset(asset, directory, fetcher = fetch) {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Runtime cache cannot be a symlink.");
  if (
    !/^[a-z0-9-]{1,80}$/.test(asset.id) ||
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes < 1 ||
    asset.bytes > 160 * 1024 * 1024
  )
    throw new Error("Invalid runtime asset.");
  const filename = path.join(
    directory,
    `${asset.id}-${asset.sha256.slice(0, 16)}.download`,
  );
  if (existsSync(filename)) {
    await verifyRuntimeAsset(filename, asset);
    return filename;
  }
  const temporary = `${filename}.partial-${randomUUID()}`;
  const response = await responseFor(asset.url, fetcher);
  let size = 0;
  const hash = createHash("sha256");
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > asset.bytes)
        done(new Error("Runtime download exceeded its pinned length."));
      else {
        hash.update(chunk);
        done(null, chunk);
      }
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    if (size !== asset.bytes || hash.digest("hex") !== asset.sha256)
      throw new Error("Runtime download digest mismatch.");
    renameSync(temporary, filename);
    return filename;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function smokeRuntime({ nodeExecutable, sqliteBinding, lock }) {
  validateNodeRuntimeLock(lock);
  const require = createRequire(
    path.join(repository, "packages/database/package.json"),
  );
  const wrapperPackage = JSON.parse(
    readFileSync(require.resolve("better-sqlite3/package.json"), "utf8"),
  );
  if (wrapperPackage.version !== lock.sqliteVersion)
    throw new Error(
      "Installed better-sqlite3 JavaScript wrapper does not match the pinned native binding.",
    );
  const program =
    "const DB=require(process.argv[1]); const db=new DB(':memory:',{nativeBinding:process.argv[2]}); const row=db.prepare('SELECT 42 AS answer').get(); db.close(); console.log(JSON.stringify({nodeVersion:process.version,nodeAbi:process.versions.modules,platform:process.platform,architecture:process.arch,sqliteAnswer:row.answer}));";
  const checked = spawnSync(
    nodeExecutable,
    [
      "-e",
      program,
      require.resolve("better-sqlite3"),
      path.resolve(sqliteBinding),
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 64 * 1024,
    },
  );
  if (checked.status !== 0)
    throw new Error(
      `Verified target runtime smoke test failed: ${checked.stderr || checked.error?.message || "unknown error"}`,
    );
  const result = JSON.parse(checked.stdout);
  if (
    result.nodeVersion !== lock.nodeVersion ||
    result.nodeAbi !== lock.nodeAbi ||
    result.platform !== "win32" ||
    result.architecture !== "x64" ||
    result.sqliteAnswer !== 42
  )
    throw new Error("Target runtime or native ABI did not match its lock.");
  return result;
}

/** Build inputs only; never installs Node globally or replaces development dependencies. */
export async function prepareNodeRuntime({
  lock,
  output,
  cache,
  fetcher = fetch,
}) {
  validateNodeRuntimeLock(lock);
  if (process.platform !== "win32" || process.arch !== "x64")
    throw new Error(
      "Prepare and smoke-test the Windows runtime on Windows x64.",
    );
  const directory = path.resolve(output);
  if (existsSync(directory))
    throw new Error("Runtime output must be a new directory.");
  const [nodeSource, sqliteSource, noticeSource] = await Promise.all([
    downloadRuntimeAsset(lock.node, cache, fetcher),
    downloadRuntimeAsset(lock.sqlite, cache, fetcher),
    downloadRuntimeAsset(lock.nodeLicense, cache, fetcher),
  ]);
  mkdirSync(directory, { recursive: true });
  const nodeExecutable = path.join(directory, "node.exe");
  const sqliteBinding = path.join(directory, "better_sqlite3.node");
  const nodeNotice = path.join(directory, "NODE.txt");
  copyFileSync(nodeSource, nodeExecutable, constants.COPYFILE_EXCL);
  copyFileSync(noticeSource, nodeNotice, constants.COPYFILE_EXCL);
  const tar = path.join(
    process.env.WINDIR || "C:/Windows",
    "System32",
    "tar.exe",
  );
  const extracted = spawnSync(tar, ["-xOf", sqliteSource, lock.sqlite.member], {
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (extracted.status !== 0 || extracted.stdout.length < 4096)
    throw new Error(
      "The verified SQLite archive did not contain its expected native binding.",
    );
  writeFileSync(sqliteBinding, extracted.stdout, { flag: "wx" });
  const smoke = smokeRuntime({ nodeExecutable, sqliteBinding, lock });
  const result = {
    format: "streamerai-prepared-runtime/v1",
    nodeExecutable,
    sqliteBinding,
    nodeNotice,
    nodeVersion: lock.nodeVersion,
    nodeAbi: lock.nodeAbi,
    sqliteVersion: lock.sqliteVersion,
    sqliteBindingSha256: createHash("sha256")
      .update(extracted.stdout)
      .digest("hex"),
    nodeSha256: lock.node.sha256,
    provenance: [
      lock.node.provenance,
      lock.sqlite.provenance,
      lock.nodeLicense.provenance,
    ],
    smoke,
    releaseReady: false,
  };
  writeFileSync(
    path.join(directory, "runtime-inputs.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      lock: { type: "string" },
      output: { type: "string" },
      cache: { type: "string" },
    },
  });
  if (!values.output)
    throw new Error(
      "Usage: node node-runtime.mjs --output NEW_DIRECTORY [--cache DIRECTORY] [--lock JSON]",
    );
  const lock = JSON.parse(
    readFileSync(
      values.lock ??
        path.join(repository, "packaging/node-runtime.win-x64.lock.json"),
      "utf8",
    ),
  );
  console.log(
    JSON.stringify(
      await prepareNodeRuntime({
        lock,
        output: values.output,
        cache:
          values.cache ??
          path.join(repository, "dist/component-cache/node-runtime"),
      }),
    ),
  );
}
