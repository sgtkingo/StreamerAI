import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../android",
);
const task =
  process.argv[2] === "release" ? "assembleRelease" : "assembleDebug";
const executable = process.platform === "win32" ? "cmd.exe" : "sh";
const args =
  process.platform === "win32"
    ? ["/d", "/s", "/c", `gradlew.bat ${task} testDebugUnitTest --no-daemon`]
    : ["./gradlew", task, "testDebugUnitTest", "--no-daemon"];
const child = spawn(executable, args, {
  cwd: directory,
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
