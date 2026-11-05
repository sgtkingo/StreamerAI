import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const directory = realpathSync(process.argv[2]);
const manifest = JSON.parse(
  readFileSync(path.join(directory, "bundle.json"), "utf8"),
);
if (manifest.format !== "streamerai-runtime-bundle/v1")
  throw new Error("Unsupported bundle format.");
if (process.argv.includes("--complete") && manifest.complete !== true)
  throw new Error(
    "Incomplete runtime prototype cannot be installed as a service.",
  );
for (const file of manifest.files) {
  const filename = path.resolve(directory, file.path);
  if (
    !filename.startsWith(`${directory}${path.sep}`) ||
    lstatSync(filename).isSymbolicLink()
  )
    throw new Error("Unsafe bundle path.");
  const actual = realpathSync(filename);
  if (!actual.startsWith(`${directory}${path.sep}`))
    throw new Error("Bundle path escapes runtime.");
  const contents = readFileSync(actual);
  if (
    contents.length !== file.bytes ||
    createHash("sha256").update(contents).digest("hex") !== file.sha256
  )
    throw new Error(`Bundle file verification failed: ${file.path}`);
}
console.log(
  "Bundle files match inventory. Authenticity requires independent signed release metadata; this inventory alone is not a signature.",
);
