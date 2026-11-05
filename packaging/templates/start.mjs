import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process, { loadEnvFile } from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

const release = fileURLToPath(new URL("../", import.meta.url));
const state = process.env.STREAMERAI_STATE_ROOT;
if (!state || !path.isAbsolute(state))
  throw new Error("STREAMERAI_STATE_ROOT must be an absolute state directory.");
if (existsSync(path.join(state, "runtime.env")))
  loadEnvFile(path.join(state, "runtime.env"));
const data = path.join(state, "data");
mkdirSync(data, { recursive: true, mode: 0o700 });
const key = path.join(state, "keys", "master.key");
if (!existsSync(key))
  throw new Error(
    "Master key missing; initialize the state directory using the installer.",
  );
process.env.NODE_ENV = "production";
process.env.STREAMERAI_ACCESS_MODE ??= "paired";
process.env.STREAMERAI_HOST = "127.0.0.1";
process.env.STREAMERAI_PORT ??= "4400";
process.env.STREAMERAI_DATA_DIR = data;
process.env.STREAMERAI_SECRET_BACKEND = "encrypted-file";
process.env.STREAMERAI_SECRET_KEY_FILE = key;
process.env.STREAMERAI_SECRET_VAULT_FILE = path.join(data, "secrets.vault");
process.env.STREAMERAI_WEB_ORIGIN ??= "https://localhost:8443";
const suffix = process.platform === "win32" ? ".exe" : "";
process.env.STREAMERAI_FFMPEG_PATH = path.join(
  release,
  "bin",
  `ffmpeg${suffix}`,
);
process.env.STREAMERAI_FFPROBE_PATH = path.join(
  release,
  "bin",
  `ffprobe${suffix}`,
);
process.chdir(path.join(release, "app"));
await import(pathToFileURL(path.join(release, "app", "dist", "start.js")).href);
