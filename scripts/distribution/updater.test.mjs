import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  FORMAT_REQUEST,
  activateRelease,
  assertPlainPath,
  compareVersions,
  currentRelease,
  layout,
  processRequest,
  serviceXml,
  UNINSTALL_KEY,
  winswControl,
} from "../../packaging/templates/updater.mjs";

test("updates the Installed apps version only when setup registered StreamerAI", () => {
  const calls = [];
  const control = (registered) =>
    winswControl({ services: "C:/unused" }, (command, args) => {
      calls.push([command, ...args]);
      return { status: args[0] === "query" && !registered ? 1 : 0 };
    });
  assert.equal(control(false).recordVersion("0.12.0"), false);
  assert.deepEqual(calls, [["reg.exe", "query", UNINSTALL_KEY, "/reg:64"]]);
  calls.length = 0;
  assert.equal(control(true).recordVersion("0.12.0"), true);
  assert.deepEqual(calls[1], [
    "reg.exe",
    "add",
    UNINSTALL_KEY,
    "/v",
    "DisplayVersion",
    "/t",
    "REG_SZ",
    "/d",
    "0.12.0",
    "/f",
    "/reg:64",
  ]);
});

function release(root, version) {
  const directory = path.join(
    root,
    `extract-${version}`,
    `streamerai-server-${version}-win-x64`,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "bundle.json"),
    JSON.stringify({
      format: "streamerai-runtime-bundle/v1",
      platform: "win-x64",
      complete: true,
      version,
      files: [],
    }),
  );
  return directory;
}

function installation(currentVersion = "0.1.0") {
  const root = mkdtempSync(path.join(tmpdir(), "streamerai-updater-"));
  const paths = layout(
    path.join(root, "Program Files", "StreamerAI"),
    path.join(root, "ProgramData", "StreamerAI"),
  );
  mkdirSync(paths.data, { recursive: true });
  mkdirSync(path.join(paths.updates, "download"), { recursive: true });
  writeFileSync(path.join(paths.data, "streamer-ai.db"), "old-db");
  writeFileSync(path.join(paths.data, "secrets.vault"), "vault");
  if (currentVersion) {
    const installed = path.join(paths.releases, currentVersion);
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      path.join(installed, "bundle.json"),
      JSON.stringify({
        format: "streamerai-runtime-bundle/v1",
        platform: "win-x64",
        complete: true,
        version: currentVersion,
        files: [],
      }),
    );
    // 0.1.x installations have no current.json; the Server definition names the release.
    mkdirSync(path.join(paths.services, "Server"), { recursive: true });
    writeFileSync(
      path.join(paths.services, "Server", "StreamerAIServer.xml"),
      serviceXml("Server", { release: installed, state: paths.stateRoot }),
    );
  }
  return { root, paths };
}

function fakeControl(existing = new Set(["Server", "Gateway"])) {
  const calls = [];
  return {
    calls,
    exists: (service) => existing.has(service),
    install: (service) => {
      existing.add(service);
      calls.push(`install ${service}`);
    },
    stop: (service) => calls.push(`stop ${service}`),
    start: (service) => calls.push(`start ${service}`),
  };
}

test("versions compare numerically with prereleases before releases", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0.0-beta.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});

test("service definitions keep the server unprivileged and restart the updater", () => {
  const server = serviceXml("Server", {
    release: "C:\\P\\releases\\1.0.0",
    state: "C:\\D",
  });
  assert.match(server, /<user>LocalService<\/user>/);
  assert.match(
    server,
    /STREAMERAI_RELEASE_ROOT" value="C:\\P\\releases\\1\.0\.0"/,
  );
  const updater = serviceXml("Updater", {
    release: "C:\\P\\releases\\1.0.0",
    state: "C:\\D",
  });
  assert.doesNotMatch(updater, /serviceaccount/);
  assert.match(updater, /<onfailure action="restart"/);
  assert.match(updater, /updater\.mjs&quot; service/);
});

test("activation moves the release, repoints services and records the active version", async () => {
  const { root, paths } = installation();
  try {
    const control = fakeControl();
    const outcome = await activateRelease({
      source: release(root, "0.2.0"),
      paths,
      control,
      verifyBundle: () => {},
      waitHealthy: async (version) => version === "0.2.0",
      mode: "setup",
      ownRelease: null,
    });
    assert.equal(outcome.result, "installed");
    assert.equal(outcome.previous, "0.1.0");
    assert.deepEqual(control.calls, [
      "stop Gateway",
      "stop Server",
      "start Server",
      "start Gateway",
      "install Updater",
      "start Updater",
    ]);
    assert.equal(currentRelease(paths).version, "0.2.0");
    assert.match(
      readFileSync(
        path.join(paths.services, "Gateway", "StreamerAIGateway.xml"),
        "utf8",
      ),
      /releases[\\/]0\.2\.0[\\/]service[\\/]Caddyfile/,
    );
    assert.ok(
      existsSync(path.join(paths.releases, "0.1.0")),
      "previous release is kept for rollback",
    );
    const [point] = await import("node:fs").then(({ readdirSync }) =>
      readdirSync(paths.rollback),
    );
    assert.equal(
      readFileSync(path.join(paths.rollback, point, "streamer-ai.db"), "utf8"),
      "old-db",
    );
    const again = await activateRelease({
      source: release(root, "0.2.0"),
      paths,
      control,
      verifyBundle: () => {},
      waitHealthy: async () => true,
      mode: "setup",
      ownRelease: null,
    });
    assert.equal(again.result, "current");
    await assert.rejects(
      activateRelease({
        source: release(root, "0.1.5"),
        paths,
        control,
        verifyBundle: () => {},
        waitHealthy: async () => true,
        mode: "setup",
        ownRelease: null,
      }),
      /downgrades are refused/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a release that does not become ready is rolled back with its database", async () => {
  const { root, paths } = installation();
  try {
    const control = fakeControl();
    await assert.rejects(
      activateRelease({
        source: release(root, "0.2.0"),
        paths,
        control,
        verifyBundle: () => {},
        waitHealthy: async (version) => {
          // The broken release migrates the database before failing.
          if (version === "0.2.0")
            writeFileSync(path.join(paths.data, "streamer-ai.db"), "migrated");
          return version === "0.1.0";
        },
        mode: "service",
        ownRelease: null,
      }),
      (error) =>
        error.code === "UPDATE_ROLLED_BACK" && error.rolledBack === true,
    );
    assert.equal(
      readFileSync(path.join(paths.data, "streamer-ai.db"), "utf8"),
      "old-db",
    );
    assert.match(
      readFileSync(
        path.join(paths.services, "Server", "StreamerAIServer.xml"),
        "utf8",
      ),
      /releases[\\/]0\.1\.0/,
    );
    assert.equal(currentRelease(paths).version, "0.1.0");
    assert.ok(!existsSync(paths.lock));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("server requests are re-verified and their outcome is reported", async () => {
  const { root, paths } = installation();
  try {
    const download = path.join(paths.updates, "download");
    writeFileSync(path.join(download, "stable.json"), "{}");
    writeFileSync(
      path.join(download, "streamerai-server-0.2.0-win-x64.zip"),
      "zip",
    );
    writeFileSync(
      paths.request,
      JSON.stringify({
        format: FORMAT_REQUEST,
        version: "0.2.0",
        metadata: "stable.json",
        artifact: "streamerai-server-0.2.0-win-x64.zip",
      }),
    );
    const staged = path.join(root, "staged.zip");
    writeFileSync(staged, "zip");
    let verified;
    const outcome = await processRequest({
      paths,
      ownRelease: path.join(paths.releases, "0.1.0"),
      control: fakeControl(new Set(["Server", "Gateway", "Updater"])),
      verifier: (options) => {
        verified = options;
        return { version: "0.2.0", artifact: staged };
      },
      extract: () => release(root, "0.2.0"),
      verifyBundle: () => {},
      waitHealthy: async () => true,
    });
    assert.equal(outcome.result, "installed");
    assert.equal(outcome.restartSelf, true);
    assert.equal(verified.commit, true);
    assert.equal(verified.currentVersion, "0.1.0");
    assert.equal(verified.component, "server");
    assert.match(
      verified.rootFile,
      /0\.1\.0[\\/]service[\\/]update-trust\.json$/,
    );
    assert.ok(!existsSync(paths.request));
    const status = JSON.parse(readFileSync(paths.status, "utf8"));
    assert.equal(status.result, "installed");
    assert.equal(status.from, "0.1.0");

    writeFileSync(
      paths.request,
      JSON.stringify({
        format: FORMAT_REQUEST,
        version: "0.3.0",
        metadata: "../x",
        artifact: "a.zip",
      }),
    );
    const refused = await processRequest({
      paths,
      ownRelease: path.join(paths.releases, "0.2.0"),
      control: fakeControl(),
      verifier: () => assert.fail("must not verify"),
      verifyBundle: () => {},
      waitHealthy: async () => true,
    });
    assert.equal(refused.result, "failed");
    assert.equal(
      JSON.parse(readFileSync(paths.status, "utf8")).result,
      "failed",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed state paths refuse links", (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "streamerai-links-"));
  try {
    mkdirSync(path.join(root, "state", "real"), { recursive: true });
    mkdirSync(path.join(root, "elsewhere"));
    assertPlainPath(path.join(root, "state"), path.join(root, "state", "real"));
    try {
      symlinkSync(
        path.join(root, "elsewhere"),
        path.join(root, "state", "updates"),
        "junction",
      );
    } catch {
      context.skip("links are unavailable");
      return;
    }
    assert.throws(
      () =>
        assertPlainPath(
          path.join(root, "state"),
          path.join(root, "state", "updates", "request.json"),
        ),
      /link/,
    );
    assert.throws(
      () =>
        assertPlainPath(path.join(root, "state"), path.join(root, "outside")),
      /escapes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
