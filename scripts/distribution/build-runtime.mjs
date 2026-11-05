import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const workspaceDirectories = {
  "@streamer-ai/server": "apps/server",
  "@streamer-ai/contracts": "packages/contracts",
  "@streamer-ai/database": "packages/database",
};

function json(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function dependencyDirectory(name, importer) {
  if (workspaceDirectories[name]) {
    return path.join(repository, workspaceDirectories[name]);
  }
  const require = createRequire(path.join(importer, "package.json"));
  let resolved;
  try {
    resolved = require.resolve(`${name}/package.json`);
  } catch {
    resolved = require.resolve(name);
  }
  let directory = path.dirname(realpathSync(resolved));
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest) && json(manifest).name === name) return directory;
    directory = path.dirname(directory);
  }
  throw new Error(`Cannot locate installed production dependency ${name}.`);
}

function compileDirectory(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    if (entry.isDirectory()) {
      compileDirectory(input, path.join(destination, entry.name));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      const result = ts.transpileModule(readFileSync(input, "utf8"), {
        fileName: input,
        compilerOptions: {
          target: ts.ScriptTarget.ES2023,
          module: ts.ModuleKind.ESNext,
          isolatedModules: true,
          verbatimModuleSyntax: true,
        },
        reportDiagnostics: true,
      });
      const errors = result.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (errors?.length) {
        throw new Error(
          ts.formatDiagnosticsWithColorAndContext(errors, {
            getCanonicalFileName: (name) => name,
            getCurrentDirectory: () => repository,
            getNewLine: () => "\n",
          }),
        );
      }
      writeFileSync(
        path.join(destination, entry.name.replace(/\.ts$/, ".js")),
        result.outputText,
      );
    } else if (!entry.name.endsWith(".d.ts")) {
      cpSync(input, path.join(destination, entry.name));
    }
  }
}

function rewriteExports(value) {
  if (typeof value === "string") return value.replace(/\.ts$/, ".js");
  if (Array.isArray(value)) return value.map(rewriteExports);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteExports(item)]),
    );
  }
  return value;
}

/** Copy the installed production closure without platform-dependent symlinks. */
export function buildRuntime(
  destination,
  {
    includeWeb = false,
    webDirectory = path.join(repository, "apps/web/dist"),
  } = {},
) {
  const output = path.resolve(destination);
  const inputs = [...Object.values(workspaceDirectories), "node_modules"].map(
    (directory) => path.join(repository, directory),
  );
  if (
    inputs.some(
      (directory) =>
        output === directory || output.startsWith(`${directory}${path.sep}`),
    )
  )
    throw new Error(
      "Runtime output must not be inside source packages or installed dependencies.",
    );
  if (existsSync(output))
    throw new Error("Runtime output must not already exist.");
  if (output === repository || !path.isAbsolute(output))
    throw new Error("Invalid output directory.");
  mkdirSync(output, { recursive: true });
  const rootModules = path.join(output, "node_modules");
  const hoisted = new Map();
  const inventory = new Map();

  function copyPackage(source, target, ancestors = new Map()) {
    const manifest = json(path.join(source, "package.json"));
    const identity = realpathSync(source);
    inventory.set(`${manifest.name}@${manifest.version}`, {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "SEE PACKAGE LICENSE",
    });
    mkdirSync(target, { recursive: true });
    if (workspaceDirectories[manifest.name]) {
      const directory =
        manifest.name === "@streamer-ai/server" ? "dist" : "src";
      compileDirectory(path.join(source, "src"), path.join(target, directory));
      const runtimeManifest = rewriteExports(manifest);
      delete runtimeManifest.devDependencies;
      delete runtimeManifest.scripts;
      writeFileSync(
        path.join(target, "package.json"),
        `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      );
    } else {
      cpSync(source, target, {
        recursive: true,
        dereference: true,
        filter: (filename) => {
          const relative = path.relative(source, filename);
          return !relative.split(path.sep).includes("node_modules");
        },
      });
    }
    const lineage = new Map(ancestors).set(manifest.name, identity);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
    };
    const edges = [];
    for (const name of Object.keys(dependencies).sort()) {
      let dependency;
      try {
        dependency = dependencyDirectory(name, source);
      } catch (error) {
        if (name in (manifest.optionalDependencies ?? {})) continue;
        throw error;
      }
      const dependencyIdentity = realpathSync(dependency);
      if (lineage.get(name) === dependencyIdentity) continue;
      const existing = hoisted.get(name);
      if (existing === dependencyIdentity) continue;
      const modules = hoisted.has(name)
        ? path.join(target, "node_modules")
        : rootModules;
      if (!hoisted.has(name)) hoisted.set(name, dependencyIdentity);
      edges.push([dependency, path.join(modules, name)]);
    }
    for (const [dependency, installed] of edges)
      copyPackage(dependency, installed, lineage);
  }

  copyPackage(path.join(repository, "apps/server"), output);
  if (includeWeb) {
    const web = path.resolve(webDirectory);
    if (!existsSync(path.join(web, "index.html")))
      throw new Error("Build the web client before packaging.");
    cpSync(web, path.join(output, "web"), { recursive: true });
  }
  const packages = [...inventory.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  writeFileSync(
    path.join(output, "DEPENDENCIES.json"),
    `${JSON.stringify(packages, null, 2)}\n`,
  );
  return { output, packages: packages.length };
}

export function hashFile(filename) {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

export function fileInventory(directory) {
  const files = [];
  function visit(current) {
    for (const entry of readdirSync(current).sort()) {
      const filename = path.join(current, entry);
      if (lstatSync(filename).isSymbolicLink())
        throw new Error("Bundles must not contain symlinks.");
      if (statSync(filename).isDirectory()) visit(filename);
      else
        files.push({
          path: path.relative(directory, filename).split(path.sep).join("/"),
          bytes: statSync(filename).size,
          sha256: hashFile(filename),
        });
    }
  }
  visit(directory);
  return files;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const output = process.argv[2];
  if (!output)
    throw new Error(
      "Usage: node scripts/distribution/build-runtime.mjs <new-output-directory> [--web]",
    );
  console.log(
    JSON.stringify(
      buildRuntime(output, { includeWeb: process.argv.includes("--web") }),
    ),
  );
}
