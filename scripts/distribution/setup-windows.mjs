import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { archiveBundle } from "./archive.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const sha256 = (filename) => {
  const descriptor = openSync(filename, "r"),
    hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) return hash.digest("hex");
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
};
export function buildWindowsSetup({
  bundle,
  output,
  compiler,
  review = false,
  ollama,
}) {
  if (process.platform !== "win32")
    throw new Error(
      "Build Windows setup on Windows with .NET Framework build tools.",
    );
  const release = path.resolve(bundle),
    directory = path.resolve(output);
  const manifest = JSON.parse(
    readFileSync(path.join(release, "bundle.json"), "utf8"),
  );
  if (
    manifest.format !== "streamerai-runtime-bundle/v1" ||
    manifest.platform !== "win-x64" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)
  )
    throw new Error("Invalid Windows server bundle.");
  if (!manifest.complete && !review)
    throw new Error(
      "A complete component bundle is required; --review builds disable installation.",
    );
  const verified = spawnSync(
    process.execPath,
    [
      path.join(repository, "packaging/templates/verify-bundle.mjs"),
      release,
      ...(manifest.complete ? ["--complete"] : []),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (verified.status !== 0)
    throw new Error(`Bundle verification failed: ${verified.stderr}`);
  const gatewayRepair = path.join(repository, "packaging/templates/Caddyfile");
  if (
    manifest.complete &&
    sha256(path.join(release, "service", "Caddyfile")) !== sha256(gatewayRepair)
  )
    throw new Error(
      "The complete bundle must contain the current HTTPS gateway template.",
    );
  if (existsSync(directory))
    throw new Error("Setup output must be a new directory.");
  const csc =
    compiler ??
    path.join(
      process.env.WINDIR || "C:/Windows",
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    );
  if (!existsSync(csc))
    throw new Error("Windows .NET Framework compiler is unavailable.");
  if (
    ollama &&
    (!/^https:\/\/github\.com\/ollama\/ollama\/releases\/download\/v\d+\.\d+\.\d+\/OllamaSetup\.exe$/.test(
      ollama.url,
    ) ||
      !/^[a-f0-9]{64}$/.test(ollama.sha256) ||
      !Number.isSafeInteger(ollama.bytes) ||
      ollama.bytes <= 0 ||
      ollama.bytes > 8 * 1024 ** 3)
  )
    throw new Error("Invalid pinned official Ollama installer descriptor.");
  mkdirSync(directory, { recursive: true });
  const payload = path.join(directory, "server.zip");
  archiveBundle(release, payload);
  const configuration = {
    version: manifest.version,
    preview: manifest.releaseReady !== true,
    reviewOnly: review || !manifest.complete,
    payloadSha256: sha256(payload),
    payloadBytes: statSync(payload).size,
    payloadUnpackedBytes: manifest.files.reduce(
      (sum, file) => sum + file.bytes,
      0,
    ),
    ollamaUrl: ollama?.url ?? "",
    ollamaSha256: ollama?.sha256 ?? "",
    ollamaBytes: ollama?.bytes ?? 0,
  };
  const configFile = path.join(directory, "setup-config.json");
  writeFileSync(configFile, `${JSON.stringify(configuration, null, 2)}\n`);
  copyFileSync(
    path.join(repository, "packaging/setup/Setup.exe.manifest"),
    path.join(directory, "Setup.exe.manifest"),
  );
  const iconGenerator = path.join(directory, "SetupIcon.exe");
  const iconFile = path.join(directory, "StreamerAI.ico");
  const iconCompiler = spawnSync(
    csc,
    [
      "/nologo",
      "/target:exe",
      `/out:${iconGenerator}`,
      "/reference:System.Drawing.dll",
      path.join(repository, "packaging/setup/SetupIcon.cs"),
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (iconCompiler.status !== 0)
    throw new Error(
      `Windows setup icon compilation failed: ${iconCompiler.stdout}\n${iconCompiler.stderr}`,
    );
  const iconBuilt = spawnSync(iconGenerator, [iconFile], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  if (iconBuilt.status !== 0)
    throw new Error(
      `Windows setup icon generation failed: ${iconBuilt.stderr}`,
    );
  const executable = path.join(
    directory,
    `StreamerAI-Server-${manifest.version}-win-x64-setup${configuration.reviewOnly ? "-review" : ""}.exe`,
  );
  const args = [
    "/nologo",
    "/codepage:65001",
    "/utf8output",
    "/target:winexe",
    "/platform:x64",
    "/optimize+",
    `/out:${executable}`,
    `/win32manifest:${path.join(directory, "Setup.exe.manifest")}`,
    `/win32icon:${iconFile}`,
    `/resource:${payload},server.zip`,
    `/resource:${configFile},setup-config.json`,
    `/resource:${gatewayRepair},gateway-repair.caddyfile`,
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    "/reference:System.ServiceProcess.dll",
    "/reference:System.Xml.dll",
    path.join(repository, "packaging/setup/Setup.cs"),
  ];
  const built = spawnSync(csc, args, { encoding: "utf8", windowsHide: true });
  if (built.status !== 0)
    throw new Error(
      `Windows setup compilation failed: ${built.stdout}\n${built.stderr}`,
    );
  const checked = spawnSync(executable, ["--self-test"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  if (checked.status !== 0)
    throw new Error(`Windows setup self-test failed: ${checked.stderr}`);
  const result = {
    executable,
    sha256: sha256(executable),
    bytes: statSync(executable).size,
    iconSha256: sha256(iconFile),
    completeComponents: manifest.complete === true,
    reviewOnly: configuration.reviewOnly,
    releaseReady: false,
    selfTest: checked.stdout.trim(),
    reason:
      "Requires Authenticode signing and clean-machine installation/reboot acceptance.",
  };
  writeFileSync(
    path.join(directory, "setup-build.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  writeFileSync(
    `${executable}.sha256`,
    `${result.sha256}  ${path.basename(executable)}\n`,
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
      compiler: { type: "string" },
      review: { type: "boolean", default: false },
      "ollama-descriptor": { type: "string" },
    },
  });
  if (!values.bundle || !values.output)
    throw new Error(
      "Usage: node setup-windows.mjs --bundle VERIFIED_BUNDLE --output NEW_DIRECTORY [--review] [--ollama-descriptor JSON]",
    );
  console.log(
    JSON.stringify(
      buildWindowsSetup({
        bundle: values.bundle,
        output: values.output,
        compiler: values.compiler,
        review: values.review,
        ollama: values["ollama-descriptor"]
          ? JSON.parse(readFileSync(values["ollama-descriptor"], "utf8"))
          : undefined,
      }),
    ),
  );
}
