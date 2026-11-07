import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildLinuxSetup } from "./setup-linux.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const needed = [
  "runtime/node",
  "bin/caddy",
  "bin/ffmpeg",
  "bin/ffprobe",
  "app/dist/start.js",
  "app/web/index.html",
  "service/start.mjs",
  "NOTICES/NODE.txt",
  "NOTICES/CADDY.txt",
  "NOTICES/FFMPEG.txt",
];
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "streamerai-deb-test-"));
  const bundle = path.join(directory, "bundle");
  const files = needed.map((name) => {
    const filename = path.join(bundle, name),
      content = Buffer.from(`test-only: ${name}\n`);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, content);
    return {
      path: name,
      bytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  const manifest = {
    format: "streamerai-runtime-bundle/v1",
    version: "0.1.0",
    platform: "linux-x64",
    complete: true,
    files,
  };
  writeFileSync(path.join(bundle, "bundle.json"), JSON.stringify(manifest));
  return { directory, bundle, manifest, output: path.join(directory, "setup") };
}

test("Linux package dry run prepares desktop setup and restricted services without installing anything", () => {
  const item = fixture();
  try {
    const result = buildLinuxSetup({
      bundle: item.bundle,
      output: item.output,
      dryRun: true,
    });
    assert.equal(result.packageFile, null);
    assert.equal(result.releaseReady, false);
    const staged = (relative) =>
      readFileSync(path.join(result.packageRoot, relative), "utf8");
    assert.match(staged("DEBIAN/control"), /python3 \(>= 3\.12\)/);
    assert.match(staged("DEBIAN/control"), /pkexec/);
    assert.match(
      staged("DEBIAN/postinst"),
      /systemctl enable --now streamerai-server/,
    );
    assert.match(
      staged("DEBIAN/preinst"),
      /does not perform in-place upgrades/,
    );
    assert.doesNotMatch(staged("DEBIAN/postrm"), /rm -rf|rmtree/);
    assert.match(
      staged("usr/share/applications/streamerai.desktop"),
      /Terminal=false/,
    );
    assert.match(
      staged("usr/share/applications/streamerai-ai.desktop"),
      /--ai/,
    );
    assert.match(
      staged("usr/share/polkit-1/actions/eu.streamerai.setup.policy"),
      /\/usr\/lib\/streamerai\/setup-helper/,
    );
    assert.match(
      staged("usr/lib/systemd/system/streamerai-server.service"),
      /User=streamerai/,
    );
    assert.match(staged("usr/lib/streamerai/setup-helper"), /filter="data"/);
    assert.match(
      staged("usr/lib/streamerai/desktop.py"),
      /MODEL = "qwen3\.5:4b"/,
    );
  } finally {
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("Linux installer refuses incomplete, non-Linux and changed component payloads", () => {
  for (const variation of ["incomplete", "platform", "changed", "extra"]) {
    const item = fixture();
    try {
      if (variation === "incomplete") item.manifest.complete = false;
      if (variation === "platform") item.manifest.platform = "win-x64";
      if (variation === "changed")
        writeFileSync(path.join(item.bundle, "bin/caddy"), "tampered");
      if (variation === "extra")
        writeFileSync(
          path.join(item.bundle, "unexpected-script"),
          "not reviewed",
        );
      writeFileSync(
        path.join(item.bundle, "bundle.json"),
        JSON.stringify(item.manifest),
      );
      assert.throws(
        () =>
          buildLinuxSetup({
            bundle: item.bundle,
            output: item.output,
            dryRun: true,
          }),
        /required|inventory/,
      );
      assert.equal(existsSync(item.output), false);
    } finally {
      rmSync(item.directory, { recursive: true, force: true });
    }
  }
});

test("Linux helpers compile and run pure self-tests without GTK, elevation or network", (context) => {
  const python =
    process.env.STREAMERAI_TEST_PYTHON ||
    (process.platform === "win32" ? "python" : "python3");
  const probe = spawnSync(python, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (probe.status !== 0) {
    context.skip("Python is not installed on this build host");
    return;
  }
  for (const name of ["setup-helper.py", "desktop.py"]) {
    const filename = path.join(root, "packaging/setup/linux", name);
    const syntax = spawnSync(
      python,
      [
        "-I",
        "-c",
        "import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(encoding='utf8'),sys.argv[1],'exec')",
        filename,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(syntax.status, 0, syntax.stderr);
    const checked = spawnSync(python, ["-I", filename, "--self-test"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /self-test/);
  }
});
