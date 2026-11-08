import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const state = await mkdtemp(join(tmpdir(), "streamerai-native-smoke-"));
if (
  dirname(resolve(state)) !== resolve(tmpdir()) ||
  !basename(state).startsWith("streamerai-native-smoke-")
)
  throw new Error(
    "The native smoke test directory is outside its expected location.",
  );
const server = createServer((request, response) => {
  if (request.url === "/api/v1/installation/discovery") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        protocol: "streamerai-discovery",
        version: 1,
        serverId: "smoke-server",
        householdId: "smoke-home",
        name: "Smoke server",
        url: `http://127.0.0.1:${server.address().port}`,
      }),
    );
  } else {
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><title>StreamerAI smoke</title><h1>Server application</h1>",
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  STREAMERAI_CLIENT_SMOKE_URL: `http://127.0.0.1:${server.address().port}`,
  STREAMERAI_CLIENT_SMOKE_STATE: state,
};
delete env.ELECTRON_RUN_AS_NODE;
try {
  const child = spawn(electron, [root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const collect = (data) => {
    output += data.toString();
    if (output.length > 30_000) output = output.slice(-30_000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const timeout = setTimeout(() => child.kill(), 20_000);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  clearTimeout(timeout);
  const result = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("CLIENT_SMOKE "));
  if (code !== 0 || !result)
    throw new Error(`Native client smoke test failed (${code}): ${output}`);
  console.log(result);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true });
}
