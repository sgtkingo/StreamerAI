import { createHash, randomUUID } from "node:crypto";
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
  chmodSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const origins = new Set([
  "https://github.com",
  "https://raw.githubusercontent.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
]);
const binaryNames = new Set([
  "ffmpeg.exe",
  "ffprobe.exe",
  "caddy.exe",
  "streamerai-service.exe",
  "ffmpeg",
  "ffprobe",
  "caddy",
]);
const textNames = new Set(["NODE.txt", "FFMPEG.txt", "CADDY.txt", "WINSW.txt"]);

export function validateComponentLock(value) {
  if (
    !value ||
    value.format !== "streamerai-components/v1" ||
    !["win-x64", "linux-x64"].includes(value.platform) ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1 ||
    value.assets.length > 12
  )
    throw new Error("Unsupported component lock.");
  const ids = new Set();
  for (const asset of value.assets) {
    const url = new URL(asset.url);
    if (
      !/^[a-z0-9-]{1,60}$/.test(asset.id) ||
      ids.has(asset.id) ||
      !origins.has(url.origin) ||
      url.username ||
      url.password ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      asset.bytes > 512 * 1024 * 1024 ||
      typeof asset.provenance !== "string" ||
      !["zip", "tar", "binary", "text"].includes(asset.type)
    )
      throw new Error("Invalid pinned component asset.");
    if (
      !asset.version ||
      /(?:\/latest\/|\/master\/|\/main\/)/.test(url.pathname)
    )
      throw new Error("Components require immutable release URLs.");
    ids.add(asset.id);
    if (
      !Array.isArray(asset.outputs) ||
      asset.outputs.length < 1 ||
      asset.outputs.length > 6
    )
      throw new Error("Invalid component outputs.");
    for (const file of asset.outputs) {
      if (!binaryNames.has(file.name) && !textNames.has(file.name))
        throw new Error("Unexpected component output.");
      if (
        ["zip", "tar"].includes(asset.type) &&
        (typeof file.member !== "string" ||
          file.member.includes("\\") ||
          file.member.startsWith("/") ||
          file.member
            .split("/")
            .some(
              (part) => part === ".." || part === "." || part.includes(":"),
            ))
      )
        throw new Error("Unsafe component archive member.");
    }
  }
  return value;
}

export async function verifyComponentFile(filename, asset) {
  if (
    !existsSync(filename) ||
    lstatSync(filename).isSymbolicLink() ||
    !statSync(filename).isFile() ||
    statSync(filename).size !== asset.bytes
  )
    throw new Error(`Component size mismatch: ${asset.id}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  if (hash.digest("hex") !== asset.sha256)
    throw new Error(`Component digest mismatch: ${asset.id}`);
}

async function responseFor(url, fetcher, remaining = 5) {
  const parsed = new URL(url);
  if (!origins.has(parsed.origin) || parsed.username || parsed.password)
    throw new Error("Untrusted component download origin.");
  const response = await fetcher(parsed, {
    redirect: "manual",
    signal: AbortSignal.timeout(180_000),
    headers: { "user-agent": "StreamerAI-component-builder" },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || remaining <= 0)
      throw new Error("Component redirect limit reached.");
    return responseFor(new URL(location, parsed), fetcher, remaining - 1);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Component download failed (${response.status}).`);
  }
  return response;
}

export async function downloadComponent(asset, directory, fetcher = fetch) {
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink())
    throw new Error("Component cache cannot be a symlink.");
  const filename = path.join(
    directory,
    `${asset.id}-${asset.sha256.slice(0, 16)}.${asset.type === "zip" ? "zip" : asset.type === "tar" ? "tar" : asset.type === "text" ? "txt" : "exe"}`,
  );
  if (existsSync(filename)) {
    await verifyComponentFile(filename, asset);
    return filename;
  }
  const temporary = `${filename}.partial-${process.pid}-${randomUUID()}`;
  const response = await responseFor(asset.url, fetcher);
  let size = 0;
  const hash = createHash("sha256");
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > asset.bytes)
        done(new Error("Component exceeded pinned length."));
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
      throw new Error(`Component digest mismatch: ${asset.id}`);
    renameSync(temporary, filename);
    return filename;
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function extractMember(archive, member, destination) {
  if (process.platform !== "win32")
    throw new Error(
      "Windows component extraction must run on the target Windows builder.",
    );
  // Read exactly the selected entry. Never extract paths or execute downloaded archive content.
  const command =
    "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:STREAMERAI_COMPONENT_ARCHIVE); try {$entries=@($zip.Entries | Where-Object {$_.FullName -ceq $env:STREAMERAI_COMPONENT_MEMBER}); if($entries.Count -ne 1){throw 'Archive member missing or duplicated'}; if($entries[0].Length -gt 400MB){throw 'Archive member too large'}; $inputStream=$entries[0].Open(); $outputStream=[IO.File]::Open($env:STREAMERAI_COMPONENT_OUTPUT,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); try{$inputStream.CopyTo($outputStream)} finally{$inputStream.Dispose();$outputStream.Dispose()}} finally{$zip.Dispose()}";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        STREAMERAI_COMPONENT_ARCHIVE: path.resolve(archive),
        STREAMERAI_COMPONENT_MEMBER: member,
        STREAMERAI_COMPONENT_OUTPUT: path.resolve(destination),
      },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Component extraction failed: ${result.stderr || result.error?.message}`,
    );
}

function extractTarMember(archive, member, destination) {
  const result = spawnSync("tar", ["-xOf", archive, "--", member], {
    windowsHide: true,
    encoding: null,
    timeout: 120_000,
    maxBuffer: 400 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(
      `Component tar extraction failed: ${result.error?.message || result.stderr?.toString()}`,
    );
  writeFileSync(destination, result.stdout, { flag: "wx", mode: 0o755 });
}

export async function prepareComponents(
  lock,
  { cache, output, fetcher = fetch },
) {
  validateComponentLock(lock);
  const windows = lock.platform === "win-x64";
  if (
    (windows ? "win32" : "linux") !== process.platform ||
    process.arch !== "x64"
  )
    throw new Error(
      "Prepare installer components on the target Windows/Linux x64 builder.",
    );
  if (lock.nodeVersion !== process.version)
    throw new Error(
      "Component notice lock must match the builder Node runtime version.",
    );
  if (existsSync(output))
    throw new Error("Prepared component output must be a new directory.");
  mkdirSync(output, { recursive: true });
  mkdirSync(path.join(output, "bin"));
  mkdirSync(path.join(output, "notices"));
  const inventory = [];
  for (const asset of lock.assets) {
    const source = await downloadComponent(asset, cache, fetcher);
    for (const file of asset.outputs) {
      const target = path.join(
        output,
        binaryNames.has(file.name) ? "bin" : "notices",
        file.name,
      );
      if (existsSync(target)) throw new Error("Duplicate prepared output.");
      if (asset.type === "zip") extractMember(source, file.member, target);
      else if (asset.type === "tar")
        extractTarMember(source, file.member, target);
      else copyFileSync(source, target);
      if (!windows && binaryNames.has(file.name)) chmodSync(target, 0o755);
      const data = readFileSync(target);
      inventory.push({
        name: file.name,
        asset: asset.id,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      });
    }
  }
  const required = windows
    ? [
        "ffmpeg.exe",
        "ffprobe.exe",
        "caddy.exe",
        "streamerai-service.exe",
        ...textNames,
      ]
    : ["ffmpeg", "ffprobe", "caddy", "NODE.txt", "FFMPEG.txt", "CADDY.txt"];
  for (const name of required)
    if (!inventory.some((file) => file.name === name))
      throw new Error(`Required component output missing: ${name}`);
  writeFileSync(
    path.join(output, "components.json"),
    JSON.stringify(
      {
        format: "streamerai-prepared-components/v1",
        platform: lock.platform,
        sourceLock: lock,
        inventory,
        releaseReady: false,
        note: "Binary availability is not release acceptance. Review provenance, corresponding-source obligations, signatures and clean-machine behavior before public distribution.",
      },
      null,
      2,
    ),
  );
  return {
    directory: path.resolve(output),
    ffmpeg: path.resolve(output, windows ? "bin/ffmpeg.exe" : "bin/ffmpeg"),
    ffprobe: path.resolve(output, windows ? "bin/ffprobe.exe" : "bin/ffprobe"),
    gateway: path.resolve(output, windows ? "bin/caddy.exe" : "bin/caddy"),
    ...(windows
      ? { serviceWrapper: path.resolve(output, "bin/streamerai-service.exe") }
      : {}),
    notices: path.resolve(output, "notices"),
    releaseReady: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      lock: {
        type: "string",
        default: path.join(
          repository,
          `packaging/component-lock.${process.platform === "win32" ? "win" : "linux"}-x64.json`,
        ),
      },
      cache: {
        type: "string",
        default: path.join(repository, "dist/component-cache"),
      },
      output: {
        type: "string",
        default: path.join(repository, "dist/components/win-x64"),
      },
    },
  });
  const lock = JSON.parse(readFileSync(values.lock, "utf8"));
  console.log(
    JSON.stringify(
      await prepareComponents(lock, {
        cache: values.cache,
        output: values.output,
      }),
    ),
  );
}
