import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { buildRuntime, fileInventory, hashFile } from "./build-runtime.mjs";
import { archiveBundle } from "./archive.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "web-directory": { type: "string" },
    node: { type: "string", default: process.execPath },
    ffmpeg: { type: "string" },
    ffprobe: { type: "string" },
    gateway: { type: "string" },
    "service-wrapper": { type: "string" },
    notices: { type: "string" },
    "runtime-only": { type: "boolean", default: false },
    archive: { type: "boolean", default: false },
  },
});
if (!["win32", "linux"].includes(process.platform) || process.arch !== "x64") {
  throw new Error(
    "Build on the target Windows/Linux x64 platform; native bindings cannot be cross-copied.",
  );
}
const complete = !values["runtime-only"];
const nodeExecutable = path.resolve(values.node);
const windows = process.platform === "win32";
const version = JSON.parse(
  readFileSync(path.join(repository, "package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
  throw new Error("Invalid package version.");
const platform = windows ? "win-x64" : "linux-x64";
const name = `streamerai-server-${version}-${platform}${complete ? "" : "-runtime-prototype"}`;
const output = path.resolve(
  values.output ?? path.join(repository, "dist", "distribution", name),
);
if (existsSync(output))
  throw new Error("Bundle output must be a new directory.");
const required = [
  "ffmpeg",
  "ffprobe",
  "gateway",
  ...(windows ? ["service-wrapper"] : []),
];
if (complete && (required.some((key) => !values[key]) || !values.notices)) {
  throw new Error(
    `Complete bundle requires ${required.map((key) => `--${key}`).join(", ")} and --notices. Use --runtime-only for an explicitly incomplete prototype.`,
  );
}
const nodeVersion = spawnSync(nodeExecutable, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (
  nodeVersion.status !== 0 ||
  !/^v(?:24\.(?:[7-9]|[1-9]\d+)\.|25\.)/.test(nodeVersion.stdout)
) {
  throw new Error(
    "Node runtime must be >=24.7 and <26 (Node 24 LTS is the release target).",
  );
}
const toolNotices = [
  "NODE.txt",
  "FFMPEG.txt",
  "CADDY.txt",
  ...(windows ? ["WINSW.txt"] : []),
];
if (
  complete &&
  toolNotices.some((file) => !existsSync(path.join(values.notices, file)))
) {
  throw new Error(
    `Notices directory must contain ${toolNotices.join(", ")} for the actual binaries.`,
  );
}
mkdirSync(output, { recursive: true });
buildRuntime(path.join(output, "app"), {
  includeWeb: true,
  webDirectory: values["web-directory"],
});
const smoke = spawnSync(
  nodeExecutable,
  [
    "--input-type=module",
    "-e",
    "import './dist/index.js'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);const DB=require('better-sqlite3');const db=new DB(':memory:');db.prepare('SELECT 1').get();db.close();",
  ],
  {
    cwd: path.join(output, "app"),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  },
);
if (smoke.status !== 0)
  throw new Error(
    `Target Node runtime/native binding verification failed: ${smoke.stderr || smoke.error?.message}`,
  );
mkdirSync(path.join(output, "runtime"));
copyFileSync(
  nodeExecutable,
  path.join(output, "runtime", windows ? "node.exe" : "node"),
);
mkdirSync(path.join(output, "bin"));
for (const [option, executable] of [
  ["ffmpeg", "ffmpeg"],
  ["ffprobe", "ffprobe"],
  ["gateway", "caddy"],
  ["service-wrapper", "streamerai-service"],
]) {
  if (values[option])
    copyFileSync(
      values[option],
      path.join(output, "bin", `${executable}${windows ? ".exe" : ""}`),
    );
}
cpSync(
  path.join(repository, "packaging/templates"),
  path.join(output, "service"),
  { recursive: true },
);
copyFileSync(
  path.join(repository, "packaging/README.md"),
  path.join(output, "README.md"),
);
copyFileSync(
  path.join(repository, "packaging/backup.mjs"),
  path.join(output, "backup.mjs"),
);
copyFileSync(
  path.join(repository, "scripts/generate-master-key.mjs"),
  path.join(output, "service/generate-master-key.mjs"),
);
if (values.notices)
  cpSync(values.notices, path.join(output, "NOTICES"), { recursive: true });
if (!windows) {
  for (const directory of ["runtime", "bin"]) {
    for (const file of fileInventory(path.join(output, directory)))
      chmodSync(path.join(output, directory, file.path), 0o755);
  }
  chmodSync(path.join(output, "service/install-linux.sh"), 0o755);
}
const manifest = {
  format: "streamerai-runtime-bundle/v1",
  version,
  platform,
  node: nodeVersion.stdout.trim(),
  complete,
  releaseReady: false,
  reason:
    "Requires signed release metadata, Authenticode on Windows, installer/upgrade VM acceptance, and trusted HTTPS setup.",
  files: fileInventory(output),
};
writeFileSync(
  path.join(output, "bundle.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
let archive;
if (values.archive) {
  archive = `${output}${windows ? ".zip" : ".tar.gz"}`;
  archiveBundle(output, archive);
  writeFileSync(
    `${archive}.sha256`,
    `${hashFile(archive)}  ${path.basename(archive)}\n`,
  );
}
console.log(JSON.stringify({ output, archive, complete, releaseReady: false }));
