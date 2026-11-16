import { build } from "esbuild";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(resolve(root, "dist"), { recursive: true });
// Update signing keys are pinned into the app at build time.
const trust = JSON.parse(
  await readFile(resolve(root, "../../packaging/update-trust.json"), "utf8"),
);
await build({
  entryPoints: [resolve(root, "src/main.ts")],
  outfile: resolve(root, "dist/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  define: {
    __STREAMERAI_UPDATE_TRUST__: JSON.stringify(JSON.stringify(trust)),
  },
  // verify-release.mjs guards its CLI entry against the empty import.meta.
  logOverride: { "empty-import-meta": "silent" },
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
