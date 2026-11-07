import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const templates = path.join(repository, "packaging/setup/linux");
const hashFile = (filename) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");
const safeVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/;

function inventoryMatches(release, manifest) {
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  if (expected.size !== manifest.files.length)
    throw new Error("Setup payload contains duplicate inventory entries.");
  const found = new Set();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (lstatSync(filename).isSymbolicLink())
        throw new Error("Setup payload cannot contain symlinks.");
      if (entry.isDirectory()) {
        walk(filename);
        continue;
      }
      if (!entry.isFile())
        throw new Error("Setup payload must contain regular files only.");
      const relative = path
        .relative(release, filename)
        .split(path.sep)
        .join("/");
      if (relative === "bundle.json") continue;
      const selected = expected.get(relative);
      if (
        !selected ||
        selected.bytes !== lstatSync(filename).size ||
        selected.sha256 !== hashFile(filename)
      )
        throw new Error(
          "Setup payload inventory does not match the reviewed bundle.",
        );
      found.add(relative);
    }
  }
  walk(release);
  if (found.size !== expected.size)
    throw new Error("Setup payload is missing files.");
  for (const required of [
    "runtime/node",
    "bin/caddy",
    "bin/ffmpeg",
    "bin/ffprobe",
    "app/dist/start.js",
    "app/web/index.html",
    "service/start.mjs",
    "NOTICES/NODE.txt",
    "NOTICES/CADDY.txt",
    "NOTICES/FFMPEG.txt",
  ])
    if (!found.has(required))
      throw new Error(`Complete Linux component bundle missing ${required}.`);
}

export function buildLinuxSetup({ bundle, output, dryRun = false }) {
  const release = realpathSync(bundle);
  const manifest = JSON.parse(
    readFileSync(path.join(release, "bundle.json"), "utf8"),
  );
  if (
    manifest.format !== "streamerai-runtime-bundle/v1" ||
    manifest.platform !== "linux-x64" ||
    manifest.complete !== true ||
    !safeVersion.test(manifest.version) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 30000
  )
    throw new Error(
      "A complete verified Linux x64 bundle is required for the installer.",
    );
  if (!dryRun && process.platform !== "linux")
    throw new Error(
      "Build the Debian package on Linux, or use --dry-run to review its tree without installing anything.",
    );
  const destination = path.resolve(output);
  if (destination === release || destination.startsWith(release + path.sep))
    throw new Error("Setup output must be outside its input bundle.");
  if (existsSync(destination))
    throw new Error("Setup output must be a new directory.");
  inventoryMatches(release, manifest);
  const root = path.join(destination, "package-root");
  const payload = path.join(root, "opt/streamerai/releases", manifest.version);
  mkdirSync(payload, { recursive: true });
  cpSync(release, payload, { recursive: true, dereference: false });
  const write = (relative, content, executable = false) => {
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content, { mode: executable ? 0o755 : 0o644 });
    if (process.platform === "linux")
      chmodSync(filename, executable ? 0o755 : 0o644);
  };
  const control = `Package: streamerai-server\nVersion: ${manifest.version}\nSection: video\nPriority: optional\nArchitecture: amd64\nMaintainer: StreamerAI contributors\nDepends: systemd, adduser, python3 (>= 3.12), python3-gi, gir1.2-gtk-3.0, pkexec, xdg-utils, ca-certificates, openssl, libnss3-tools, zstd, tar, libc6 (>= 2.35), libstdc++6\nHomepage: https://github.com/sgtkingo/StreamerAI\nDescription: Local StreamerAI server with browser client and guided optional AI\n Installs the server, media tools and local HTTPS gateway as restricted services.\n Launch StreamerAI from the applications menu to finish owner setup and optionally\n reuse or install Ollama and the recommended model. User data is retained on removal.\n`;
  write("DEBIAN/control", control);
  for (const name of ["preinst", "postinst", "prerm", "postrm"])
    write(
      `DEBIAN/${name}`,
      readFileSync(path.join(templates, name), "utf8").replaceAll(
        "@VERSION@",
        manifest.version,
      ),
      true,
    );
  write(
    "usr/lib/streamerai/setup-helper",
    readFileSync(path.join(templates, "setup-helper.py")),
    true,
  );
  write(
    "usr/lib/streamerai/desktop.py",
    readFileSync(path.join(templates, "desktop.py")),
  );
  write(
    "usr/lib/streamerai/ollama.pinned.json",
    readFileSync(path.join(templates, "ollama.pinned.json")),
  );
  write(
    "usr/bin/streamerai-launch",
    readFileSync(path.join(templates, "streamerai-launch")),
    true,
  );
  for (const name of ["streamerai.desktop", "streamerai-ai.desktop"])
    write(
      `usr/share/applications/${name}`,
      readFileSync(path.join(templates, name)),
    );
  write(
    "usr/share/polkit-1/actions/eu.streamerai.setup.policy",
    readFileSync(path.join(templates, "eu.streamerai.setup.policy")),
  );
  write(
    "usr/share/icons/hicolor/scalable/apps/streamerai.svg",
    readFileSync(path.join(repository, "apps/web/public/icon.svg")),
  );
  for (const unit of [
    "streamerai-server.service",
    "streamerai-gateway.service",
  ])
    write(
      `usr/lib/systemd/system/${unit}`,
      readFileSync(path.join(repository, "packaging/templates", unit)),
    );
  write(
    "usr/share/doc/streamerai-server/README",
    "StreamerAI local server\nOpen StreamerAI from your applications menu. Local AI is optional; existing installations and models are preserved. No terminal setup is required. Profiles, encryption keys, local CA and model files remain after removal. This initial package refuses in-place upgrades.\n",
  );
  if (process.platform === "linux") {
    for (const executable of [
      "runtime/node",
      "bin/caddy",
      "bin/ffmpeg",
      "bin/ffprobe",
    ])
      chmodSync(path.join(payload, executable), 0o755);
  }
  const packageFile = path.join(
    destination,
    `streamerai-server_${manifest.version}_amd64.deb`,
  );
  if (!dryRun) {
    const built = spawnSync(
      "dpkg-deb",
      ["--build", "--root-owner-group", root, packageFile],
      { encoding: "utf8", timeout: 600000 },
    );
    if (built.status !== 0)
      throw new Error(
        `Debian package build failed: ${built.stderr || built.error?.message}`,
      );
    for (const [field, expected] of [
      ["Package", "streamerai-server"],
      ["Architecture", "amd64"],
      ["Version", manifest.version],
    ]) {
      const checked = spawnSync("dpkg-deb", ["--field", packageFile, field], {
        encoding: "utf8",
        timeout: 30000,
      });
      if (checked.status !== 0 || checked.stdout.trim() !== expected)
        throw new Error(
          `Generated Debian package has invalid ${field} metadata.`,
        );
    }
    writeFileSync(
      `${packageFile}.sha256`,
      `${hashFile(packageFile)}  ${path.basename(packageFile)}\n`,
    );
  }
  const result = {
    format: "streamerai-linux-setup/v1",
    version: manifest.version,
    packageRoot: root,
    packageFile: dryRun ? null : packageFile,
    dryRun,
    desktopLauncher: "/usr/bin/streamerai-launch",
    completeComponents: true,
    releaseReady: false,
    gates: [
      "Package signing/public source obligations",
      "Ubuntu 24.04+/Debian 13 desktop clean-machine install/reboot/removal",
      "Local certificate trust in actual supported browsers",
      "Explicit optional Ollama installation and GPU preflight",
    ],
  };
  writeFileSync(
    path.join(destination, "setup-build.json"),
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
      bundle: { type: "string" },
      output: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.bundle || !values.output)
    throw new Error(
      "Usage: node setup-linux.mjs --bundle VERIFIED_LINUX_BUNDLE --output NEW_DIRECTORY [--dry-run]",
    );
  console.log(
    JSON.stringify(
      buildLinuxSetup({
        bundle: values.bundle,
        output: values.output,
        dryRun: values["dry-run"],
      }),
    ),
  );
}
