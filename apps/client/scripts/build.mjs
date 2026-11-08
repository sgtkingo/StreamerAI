import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "dist/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await build({
  entryPoints: [resolve(root, "src/preload.ts")],
  outfile: resolve(root, "dist/preload.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await build({
  entryPoints: [resolve(root, "src/renderer.ts")],
  outfile: resolve(root, "dist/renderer.js"),
  bundle: true,
  platform: "browser",
  target: "es2023",
});
for (const name of ["renderer.html", "renderer.css"])
  await copyFile(resolve(root, "src", name), resolve(root, "dist", name));
await copyFile(
  resolve(root, "assets/icon.png"),
  resolve(root, "dist/icon.png"),
);
console.log("Built StreamerAI desktop client in apps/client/dist.");
