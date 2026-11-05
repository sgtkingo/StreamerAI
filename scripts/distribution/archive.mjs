import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function archiveBundle(directory, destination) {
  if (existsSync(destination))
    throw new Error("Archive must not already exist.");
  const windows = process.platform === "win32";
  const command = windows ? "powershell.exe" : "tar";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:STREAMERAI_ARCHIVE_SOURCE, $env:STREAMERAI_ARCHIVE_TARGET, [System.IO.Compression.CompressionLevel]::Fastest, $true)",
      ]
    : [
        "-czf",
        destination,
        "-C",
        path.dirname(directory),
        path.basename(directory),
      ];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    env: {
      ...process.env,
      STREAMERAI_ARCHIVE_SOURCE: path.resolve(directory),
      STREAMERAI_ARCHIVE_TARGET: path.resolve(destination),
    },
  });
  if (result.status !== 0)
    throw new Error(
      `Archive creation failed${result.error ? `: ${result.error.message}` : `: ${result.stderr || result.stdout}`}`,
    );
}
