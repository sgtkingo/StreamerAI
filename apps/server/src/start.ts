import { spawnSync } from "node:child_process";
import { createApp } from "./app.js";
import { loadLocalEnvironment, readRuntimeConfig } from "./runtime-config.js";
import { acquireServerRuntimeLock } from "./services/runtime-lock.js";

function mediaToolVersion(command: string): string | null {
  const result = spawnSync(command, ["-version"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return result.status === 0
    ? (result.stdout.split(/\r?\n/, 1)[0]?.slice(0, 200) ?? null)
    : null;
}

loadLocalEnvironment();
const runtimeConfig = readRuntimeConfig();
const runtimeLock = acquireServerRuntimeLock(runtimeConfig.server.dataDir);
const app = (() => {
  try {
    return createApp({ runtimeConfig });
  } catch (cause) {
    runtimeLock.release();
    throw cause;
  }
})();
app.addHook("onClose", async () => runtimeLock.release());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}
app.log.info(
  {
    code: "MEDIA_TOOLCHAIN_VERSION",
    ffmpeg: mediaToolVersion(process.env.STREAMERAI_FFMPEG_PATH || "ffmpeg"),
    ffprobe: mediaToolVersion(process.env.STREAMERAI_FFPROBE_PATH || "ffprobe"),
  },
  "Media toolchain versions",
);

try {
  await app.listen({
    port: runtimeConfig.server.port,
    host: runtimeConfig.server.host,
  });
} catch (error) {
  app.log.fatal(
    { err: error, code: "SERVER_START_FAILED" },
    "Server failed to start",
  );
  process.exitCode = 1;
  await app.close();
}
