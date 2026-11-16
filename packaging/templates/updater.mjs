import { spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
/* global fetch, AbortSignal -- Node 24 web globals */
import console from "node:console";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

/**
 * StreamerAI Windows update supervisor.
 *
 *   node service/updater.mjs service
 *     Runs as the StreamerAIUpdater service (LocalSystem). The LocalService
 *     server only downloads a signed release into STATE/updates and writes
 *     request.json after the owner approves (or the nightly window allows) it.
 *     This process re-verifies everything with the trust pinned in the
 *     administrator-only release, then activates it.
 *
 *   node <new release>/service/updater.mjs activate --source <bundle dir>
 *     Used elevated by StreamerAI Setup to upgrade an existing installation
 *     in place (data, keys and HTTPS CA are kept).
 *
 * Activation installs the new release beside the current one, backs up the
 * database, repoints the services, waits for the new version to report ready
 * and rolls back services and database when it does not.
 */

export const FORMAT_REQUEST = "streamerai-update-request/v1";
export const FORMAT_STATUS = "streamerai-update-status/v1";
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const SERVICES = ["Server", "Gateway"];
const DATABASE_FILES = /^(?:streamer-ai\.db(?:-wal|-shm)?|secrets\.vault)$/;
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;

export function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) throw new Error("Invalid version.");
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  return a[4] < b[4] ? -1 : 1;
}

function escapeXml(value) {
  return value.replace(
    /[<>&'"]/g,
    (character) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&apos;",
        '"': "&quot;",
      })[character],
  );
}

/** WinSW 2.12 definitions; Server and Gateway match install-windows.ps1. */
export function serviceXml(service, { release, state }) {
  const node = path.join(release, "runtime", "node.exe");
  const definition = {
    Server: {
      executable: node,
      arguments: `"${path.join(release, "service", "start.mjs")}"`,
      description: "StreamerAI home server",
      account:
        "<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>",
      extra: "",
    },
    Gateway: {
      executable: path.join(release, "bin", "caddy.exe"),
      arguments: `run --config "${path.join(release, "service", "Caddyfile")}" --adapter caddyfile`,
      description: "StreamerAI local HTTPS gateway",
      account:
        "<serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>",
      extra: "",
    },
    // No serviceaccount element: WinSW runs it as LocalSystem, which is
    // required to replace administrator-owned program files and services.
    Updater: {
      executable: node,
      arguments: `"${path.join(release, "service", "updater.mjs")}" service`,
      description:
        "Installs StreamerAI server updates approved by the household owner",
      account: "",
      extra:
        '\n  <onfailure action="restart" delay="10 sec"/><resetfailure>1 hour</resetfailure>',
    },
  }[service];
  if (!definition) throw new Error(`Unknown service ${service}.`);
  return `<service>
  <id>StreamerAI${service}</id><name>StreamerAI ${service}</name>
  <description>${escapeXml(definition.description)}</description>
  <executable>${escapeXml(definition.executable)}</executable><arguments>${escapeXml(definition.arguments)}</arguments>
  <workingdirectory>${escapeXml(state)}</workingdirectory>
  <env name="STREAMERAI_STATE_ROOT" value="${escapeXml(state)}"/>
  <env name="STREAMERAI_RELEASE_ROOT" value="${escapeXml(release)}"/>
  ${definition.account}
  <startmode>Automatic</startmode><stoptimeout>60sec</stoptimeout>${definition.extra}
  <logpath>${escapeXml(path.join(state, "logs"))}</logpath><log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>3</keepFiles></log>
</service>
`;
}

/** Refuses symlinks/junctions anywhere below `root` (LocalService can write STATE). */
export function assertPlainPath(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Path escapes its managed root.");
  let current = base;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`Refusing a link in managed state: ${current}`);
  }
  const expected = path.join(realpathSync(base), relative);
  if (realpathSync(resolved).toLowerCase() !== expected.toLowerCase())
    throw new Error(`Managed path resolves elsewhere: ${resolved}`);
}

/** Atomic replace; never writes through a pre-created link with the final name. */
export function writeJsonAtomic(filename, value) {
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
  renameSync(temporary, filename);
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, "utf8"));
}

function bundleManifest(release) {
  const manifest = readJson(path.join(release, "bundle.json"));
  if (
    manifest.format !== "streamerai-runtime-bundle/v1" ||
    manifest.platform !== "win-x64" ||
    manifest.complete !== true ||
    !VERSION.test(manifest.version)
  )
    throw new Error("The update is not a complete Windows server release.");
  return manifest;
}

export function layout(programRoot, stateRoot) {
  return {
    programRoot,
    stateRoot,
    releases: path.join(programRoot, "releases"),
    current: path.join(programRoot, "current.json"),
    lock: path.join(programRoot, "update.lock"),
    staging: path.join(programRoot, "staging"),
    trustState: path.join(programRoot, "update-state.json"),
    services: path.join(programRoot, "services"),
    updates: path.join(stateRoot, "updates"),
    request: path.join(stateRoot, "updates", "request.json"),
    status: path.join(stateRoot, "updates", "status.json"),
    rollback: path.join(stateRoot, "updates", "rollback"),
    data: path.join(stateRoot, "data"),
    receipt: path.join(stateRoot, "setup-receipt.json"),
  };
}

/** The active release: current.json, or (0.1.x installs) the Server service definition. */
export function currentRelease(paths) {
  if (existsSync(paths.current)) {
    const current = readJson(paths.current);
    if (VERSION.test(current.version))
      return {
        version: current.version,
        release: path.join(paths.releases, current.version),
        previous: current.previous ?? null,
      };
  }
  const xml = path.join(paths.services, "Server", "StreamerAIServer.xml");
  if (existsSync(xml)) {
    const match = /<env name="STREAMERAI_RELEASE_ROOT" value="([^"]+)"\/>/.exec(
      readFileSync(xml, "utf8"),
    );
    if (match) {
      const release = match[1]
        .replace(/&amp;/g, "&")
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      return {
        version: bundleManifest(release).version,
        release,
        previous: null,
      };
    }
  }
  return null;
}

function acquireLock(file, now) {
  try {
    if (existsSync(file) && now() - statSync(file).mtimeMs > LOCK_STALE_MS)
      unlinkSync(file);
    const descriptor = openSync(file, "wx");
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
  } catch (error) {
    if (error?.code === "EEXIST")
      throw new Error("Another StreamerAI update is running.");
    throw error;
  }
  return () => {
    try {
      unlinkSync(file);
    } catch {
      /* already removed */
    }
  };
}

function backupDatabase(paths, version, now) {
  assertPlainPath(paths.stateRoot, paths.data);
  assertPlainPath(paths.stateRoot, paths.rollback);
  mkdirSync(paths.rollback, { recursive: true });
  const target = path.join(
    paths.rollback,
    `${version}-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(target);
  const copied = [];
  for (const name of existsSync(paths.data) ? readdirSync(paths.data) : []) {
    if (!DATABASE_FILES.test(name)) continue;
    const source = path.join(paths.data, name);
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile())
      throw new Error("Refusing a linked database file.");
    copyFileSync(source, path.join(target, name));
    copied.push(name);
  }
  // Keep the three newest rollback points.
  const points = readdirSync(paths.rollback)
    .filter((name) => /^\d/.test(name))
    .sort(
      (a, b) =>
        statSync(path.join(paths.rollback, b)).mtimeMs -
        statSync(path.join(paths.rollback, a)).mtimeMs,
    );
  for (const old of points.slice(3))
    rmSync(path.join(paths.rollback, old), { recursive: true, force: true });
  return { directory: target, files: copied };
}

function restoreDatabase(paths, backup) {
  assertPlainPath(paths.stateRoot, paths.data);
  for (const name of readdirSync(paths.data))
    if (DATABASE_FILES.test(name) && !backup.files.includes(name))
      rmSync(path.join(paths.data, name), { force: true });
  for (const name of backup.files)
    copyFileSync(
      path.join(backup.directory, name),
      path.join(paths.data, name),
    );
}

function writeServiceDefinitions(paths, services, release) {
  for (const service of services) {
    const directory = path.join(paths.services, service);
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `StreamerAI${service}.xml`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      serviceXml(service, { release, state: paths.stateRoot }),
      { flag: "wx" },
    );
    renameSync(temporary, file);
  }
}

/** Service control through the bundled WinSW wrappers (one copy per service). */
export function winswControl(paths, run = spawnSync) {
  const wrapper = (service) =>
    path.join(paths.services, service, `StreamerAI${service}.exe`);
  const call = (service, command, allowFailure = false) => {
    const result = run(wrapper(service), [command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
    });
    if (result.status !== 0 && !allowFailure)
      throw new Error(
        `StreamerAI${service} ${command} failed: ${(result.stderr || result.stdout || result.error?.message || "").trim()}`,
      );
    return result;
  };
  return {
    exists: (service) =>
      existsSync(wrapper(service)) &&
      run("sc.exe", ["query", `StreamerAI${service}`], {
        encoding: "utf8",
        windowsHide: true,
      }).status === 0,
    install(service, release) {
      mkdirSync(path.join(paths.services, service), { recursive: true });
      copyFileSync(
        path.join(release, "bin", "streamerai-service.exe"),
        wrapper(service),
      );
      call(service, "install");
    },
    stop: (service) => call(service, "stop", true),
    start: (service) => call(service, "start"),
  };
}

/** Polls the loopback API until the expected version is ready. */
export async function waitForServer(
  version,
  {
    port = 4400,
    timeoutMs = 180_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const [ready, info] = await Promise.all([
        fetchImpl(`http://127.0.0.1:${port}/api/v1/health/ready`, {
          signal: AbortSignal.timeout(5000),
        }).then((response) => response.json()),
        fetchImpl(`http://127.0.0.1:${port}/api/v1/server/version`, {
          signal: AbortSignal.timeout(5000),
        }).then((response) => response.json()),
      ]);
      if (ready?.status === "ready" && info?.serverVersion === version)
        return true;
    } catch {
      /* still starting or migrating */
    }
    await sleep(2000);
  }
  return false;
}

function serverPort(stateRoot) {
  try {
    const match = /^\s*STREAMERAI_PORT\s*=\s*"?(\d{2,5})"?\s*$/m.exec(
      readFileSync(path.join(stateRoot, "runtime.env"), "utf8"),
    );
    if (match) return Number(match[1]);
  } catch {
    /* default */
  }
  return 4400;
}

function cleanupReleases(paths, keep) {
  if (!existsSync(paths.releases)) return;
  const kept = new Set(
    [...keep].filter(Boolean).map((value) => path.resolve(value).toLowerCase()),
  );
  for (const name of readdirSync(paths.releases)) {
    const candidate = path.join(paths.releases, name);
    if (
      kept.has(path.resolve(candidate).toLowerCase()) ||
      lstatSync(candidate).isSymbolicLink()
    )
      continue;
    try {
      rmSync(candidate, { recursive: true, force: true });
    } catch {
      /* in use; retried after the next update */
    }
  }
}

/**
 * Installs a verified, extracted release directory and switches services to
 * it. `source` is moved into releases/<version>. Returns the outcome; throws
 * only when nothing was changed or after a completed rollback.
 */
export async function activateRelease({
  source,
  paths,
  control,
  verifyBundle,
  waitHealthy,
  mode,
  ownRelease,
  now = Date.now,
  log = () => {},
}) {
  const manifest = bundleManifest(source);
  verifyBundle(source);
  const version = manifest.version;
  mkdirSync(paths.releases, { recursive: true });
  const target = path.join(paths.releases, version);
  const unlock = acquireLock(paths.lock, now);
  try {
    const current = currentRelease(paths);
    if (current && compareVersions(version, current.version) < 0)
      throw new Error(
        `StreamerAI ${current.version} is newer than ${version}; downgrades are refused.`,
      );
    if (
      current &&
      current.version === version &&
      path.resolve(current.release).toLowerCase() ===
        path.resolve(target).toLowerCase() &&
      existsSync(target)
    ) {
      if (
        path.resolve(source).toLowerCase() !==
        path.resolve(target).toLowerCase()
      )
        rmSync(source, { recursive: true, force: true });
      return { result: "current", version };
    }
    if (
      path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()
    ) {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
      renameSync(source, target);
    }
    verifyBundle(target);
    log(
      `Activating StreamerAI ${version}${current ? ` (from ${current.version})` : ""}…`,
    );
    const backup = current ? backupDatabase(paths, current.version, now) : null;
    for (const service of [...SERVICES].reverse()) control.stop(service);
    writeServiceDefinitions(paths, SERVICES, target);
    let healthy = false;
    try {
      for (const service of SERVICES) control.start(service);
      healthy = await waitHealthy(version);
    } catch (error) {
      log(`Start failed: ${error.message}`);
    }
    if (!healthy) {
      log("The new release did not become ready; rolling back.");
      for (const service of [...SERVICES].reverse()) control.stop(service);
      if (current) {
        writeServiceDefinitions(paths, SERVICES, current.release);
        if (backup) restoreDatabase(paths, backup);
        for (const service of SERVICES) control.start(service);
      }
      const rolledBack = current ? await waitHealthy(current.version) : false;
      throw Object.assign(
        new Error(
          `StreamerAI ${version} did not start; ${current ? (rolledBack ? `restored ${current.version}` : `restored ${current.version}, which is not answering yet`) : "no previous release exists"}.`,
        ),
        { code: "UPDATE_ROLLED_BACK", rolledBack },
      );
    }
    writeJsonAtomic(paths.current, {
      version,
      previous: current?.version ?? null,
      activatedAt: new Date(now()).toISOString(),
    });
    if (mode === "service")
      writeJsonAtomic(paths.receipt, { version, phase: "complete" });
    // The updater itself moves to the new release; the running copy restarts.
    const updaterExists = control.exists("Updater");
    writeServiceDefinitions(paths, ["Updater"], target);
    let restartSelf = false;
    if (mode === "service") restartSelf = true;
    else if (updaterExists) {
      control.stop("Updater");
      control.start("Updater");
    } else {
      control.install("Updater", target);
      control.start("Updater");
    }
    cleanupReleases(paths, [target, current?.release, ownRelease]);
    return {
      result: "installed",
      version,
      previous: current?.version ?? null,
      restartSelf,
    };
  } finally {
    unlock();
  }
}

/** Extracts a ZIP with Windows' bsdtar, which refuses absolute and parent paths. */
export function extractArchive(archive, destination, run = spawnSync) {
  mkdirSync(destination, { recursive: true });
  const tar = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "tar.exe",
  );
  const result = run(tar, ["-xf", archive, "-C", destination], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 600_000,
  });
  if (result.status !== 0)
    throw new Error(
      `The update archive could not be extracted: ${(result.stderr || "").trim()}`,
    );
  const found = [];
  const walk = (directory, depth) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("The update archive contains a link.");
      if (entry.isFile() && entry.name === "bundle.json") found.push(directory);
      if (entry.isDirectory() && depth < 2)
        walk(path.join(directory, entry.name), depth + 1);
    }
  };
  walk(destination, 0);
  if (found.length !== 1)
    throw new Error(
      "The update archive must contain exactly one server release.",
    );
  return found[0];
}

function verifyBundleWith(node, script) {
  return (release) => {
    const result = spawnSync(node, [script, release, "--complete"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 300_000,
    });
    if (result.status !== 0)
      throw new Error(
        `Release files failed verification: ${(result.stderr || result.stdout).trim().slice(0, 400)}`,
      );
  };
}

/** Handles one approved request from the server. */
export async function processRequest({
  paths,
  ownRelease,
  control,
  verifier,
  extract = extractArchive,
  verifyBundle,
  waitHealthy,
  now = Date.now,
  log = () => {},
}) {
  assertPlainPath(paths.stateRoot, paths.updates);
  if (!existsSync(paths.request)) return null;
  if (lstatSync(paths.request).isSymbolicLink())
    throw new Error("Refusing a linked update request.");
  let request;
  try {
    request = readJson(paths.request);
  } finally {
    rmSync(paths.request, { force: true });
  }
  const status = (value) =>
    writeJsonAtomic(paths.status, {
      format: FORMAT_STATUS,
      at: new Date(now()).toISOString(),
      ...value,
    });
  const current = currentRelease(paths);
  try {
    if (
      request?.format !== FORMAT_REQUEST ||
      !VERSION.test(request.version) ||
      typeof request.metadata !== "string" ||
      typeof request.artifact !== "string" ||
      [request.metadata, request.artifact].some(
        (name) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name),
      )
    )
      throw new Error("The update request is malformed.");
    status({
      state: "installing",
      version: request.version,
      from: current?.version ?? null,
    });
    const download = path.join(paths.updates, "download");
    for (const name of [request.metadata, request.artifact])
      assertPlainPath(paths.stateRoot, path.join(download, name));
    // Re-verify with the trust and replay state only administrators can change;
    // the verified archive is copied to administrator-only staging first.
    const staged = verifier({
      rootFile: path.join(ownRelease, "service", "update-trust.json"),
      metadataFile: path.join(download, request.metadata),
      artifactFile: path.join(download, request.artifact),
      stateFile: paths.trustState,
      stageDirectory: paths.staging,
      currentVersion: current?.version ?? "0.0.0",
      platform: "win-x64",
      component: "server",
      channel: request.channel === "beta" ? "beta" : "stable",
      commit: true,
    });
    if (staged.version !== request.version)
      throw new Error(
        "The approved version does not match the signed release.",
      );
    const extracted = path.join(
      paths.staging,
      `extract-${request.version}-${now()}`,
    );
    let outcome;
    try {
      const source = extract(staged.artifact, extracted);
      if (bundleManifest(source).version !== request.version)
        throw new Error("The archive contains a different version.");
      outcome = await activateRelease({
        source,
        paths,
        control,
        verifyBundle,
        waitHealthy,
        mode: "service",
        ownRelease,
        now,
        log,
      });
    } finally {
      rmSync(extracted, { recursive: true, force: true });
      rmSync(staged.artifact, { force: true });
    }
    status({
      state: "idle",
      result: outcome.result,
      version: outcome.version,
      from: current?.version ?? null,
    });
    for (const name of [request.metadata, request.artifact])
      rmSync(path.join(download, name), { force: true });
    return outcome;
  } catch (error) {
    status({
      state: "idle",
      result: error.code === "UPDATE_ROLLED_BACK" ? "rolled-back" : "failed",
      version: request?.version ?? null,
      from: current?.version ?? null,
      message: String(error.message).slice(0, 500),
    });
    log(`Update failed: ${error.message}`);
    return { result: "failed", error };
  }
}

async function main(argv) {
  const release = fileURLToPath(new URL("../", import.meta.url)).replace(
    /[\\/]$/,
    "",
  );
  const node = process.execPath;
  const verifyBundle = verifyBundleWith(
    node,
    path.join(release, "service", "verify-bundle.mjs"),
  );
  const log = (message) =>
    console.log(`${new Date().toISOString()} ${message}`);
  if (argv[0] === "service") {
    const stateRoot = process.env.STREAMERAI_STATE_ROOT;
    if (!stateRoot || !path.isAbsolute(stateRoot))
      throw new Error("STREAMERAI_STATE_ROOT must be absolute.");
    const programRoot = path.resolve(release, "..", "..");
    const paths = layout(programRoot, stateRoot);
    const { stageRelease } = await import(
      pathToFileURL(path.join(release, "service", "verify-release.mjs")).href
    );
    const control = winswControl(paths);
    const port = serverPort(stateRoot);
    log(
      `StreamerAI updater ready (release ${bundleManifest(release).version}).`,
    );
    for (;;) {
      const outcome = await processRequest({
        paths,
        ownRelease: release,
        control,
        verifier: stageRelease,
        verifyBundle,
        waitHealthy: (version) => waitForServer(version, { port }),
        log,
      }).catch((error) => {
        log(`Updater error: ${error.message}`);
        return null;
      });
      if (outcome?.restartSelf) {
        log("Restarting the updater from the new release.");
        process.exit(75); // WinSW onfailure restarts the service with its new definition.
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
  if (argv[0] === "activate") {
    const index = argv.indexOf("--source");
    if (index < 0 || !argv[index + 1])
      throw new Error(
        "Usage: updater.mjs activate --source <extracted release>",
      );
    const programRoot = path.join(
      process.env.ProgramFiles || "C:\\Program Files",
      "StreamerAI",
    );
    const stateRoot = path.join(
      process.env.ProgramData || "C:\\ProgramData",
      "StreamerAI",
    );
    const paths = layout(programRoot, stateRoot);
    const outcome = await activateRelease({
      source: path.resolve(argv[index + 1]),
      paths,
      control: winswControl(paths),
      verifyBundle,
      waitHealthy: (version) =>
        waitForServer(version, { port: serverPort(stateRoot) }),
      mode: "setup",
      ownRelease: null,
      log: (message) => console.error(message),
    });
    console.log(JSON.stringify(outcome));
    return;
  }
  throw new Error(
    "Usage: updater.mjs service | activate --source <extracted release>",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
