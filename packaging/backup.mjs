import { existsSync } from "node:fs";
import path from "node:path";
import process, { loadEnvFile } from "node:process";
import { URL } from "node:url";

const state = process.env.STREAMERAI_STATE_ROOT;
if (state) {
  if (!path.isAbsolute(state))
    throw new Error("STREAMERAI_STATE_ROOT must be absolute.");
  if (existsSync(path.join(state, "runtime.env")))
    loadEnvFile(path.join(state, "runtime.env"));
  process.env.STREAMERAI_DATA_DIR = path.join(state, "data");
  process.env.STREAMERAI_SECRET_VAULT_FILE = path.join(
    state,
    "data",
    "secrets.vault",
  );
  process.env.STREAMERAI_SECRET_KEY_FILE = path.join(
    state,
    "keys",
    "master.key",
  );
  process.env.STREAMERAI_SECRET_BACKEND = "encrypted-file";
}
await import(new URL("./app/dist/backup/cli.js", import.meta.url).href);
